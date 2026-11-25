import { App, TFile } from 'obsidian';
import { executeWorkspace } from '../src/utils/workspace-api';
import { createSemanticTools } from '../src/tools/semantic-tools';

function fixture({ activateOnSplit = false, activateOnOpen = false }: { activateOnSplit?: boolean; activateOnOpen?: boolean } = {}) {
  const leaves: FakeLeaf[] = [];
  const group = {};
  let current: FakeLeaf;
  class FakeLeaf {
    parent = group;
    type = 'empty';
    path?: string;
    url?: string;
    pinned = false;
    getViewState() { return { type: this.type, state: { file: this.path, url: this.url }, pinned: this.pinned }; }
    async openFile(file: TFile, options: { active: boolean }) {
      this.type = file.extension === 'c' ? 'vscode-editor' : 'markdown'; this.path = file.path;
      if (options.active || activateOnOpen) current = this;
    }
    detach() { leaves.splice(leaves.indexOf(this), 1); }
  }
  const chat = new FakeLeaf();
  chat.type = 'webviewer';
  chat.url = 'https://chatgpt.com/c/private-conversation?secret=1';
  leaves.push(chat); current = chat;
  const split = jest.fn((_leaf: FakeLeaf, _direction: string, _before: boolean) => {
    const leaf = new FakeLeaf(); leaves.push(leaf);
    if (activateOnSplit) current = leaf;
    return leaf;
  });
  const app = {
    workspace: {
      iterateRootLeaves: (fn: (leaf: FakeLeaf) => void) => leaves.forEach(fn),
      getMostRecentLeaf: () => current,
      createLeafBySplit: split,
      setActiveLeaf: (leaf: FakeLeaf) => { current = leaf; },
    },
    viewRegistry: { getTypeByExtension: (extension: string) => extension === 'c' ? 'vscode-editor' : undefined },
    vault: { getAbstractFileByPath: (path: string) => {
      if (!['exercise.md', 'next.md', 'hidden.md', 'exercise.c', 'unsupported.xyz'].includes(path)) return null;
      const file = new TFile();
      Object.assign(file, { path, extension: path.split('.').pop() });
      return file;
    } }
  } as unknown as App;
  const run = (action: string, options = {}) => executeWorkspace(app, action, options) as Promise<any>;
  return { app, run, leaves, chat, split };
}

describe('workspace pane lifecycle', () => {
  it('opens next to the chat, reuses and closes only the exercise leaf', async () => {
    const { run, chat, split, leaves } = fixture();
    const listed = await run('list');
    const anchorId = listed.leaves[0].leafId;
    expect(listed.leaves[0].origin).toBe('https://chatgpt.com');
    expect(JSON.stringify(listed)).not.toContain('private-conversation');
    const opened = await run('open', { anchorId, path: 'exercise.md' });
    expect(split).toHaveBeenCalledWith(chat, 'vertical', false);
    expect(opened.managed).toBe(true);
    expect(opened.active).toBe(false);
    const reused = await run('open', { leafId: opened.leafId, path: 'next.md' });
    expect(reused.leafId).toBe(opened.leafId);
    expect(split).toHaveBeenCalledTimes(1);
    await expect(run('close', { leafId: anchorId })).rejects.toThrow('MCP-created');
    await expect(run('open', { leafId: anchorId, path: 'exercise.md' })).rejects.toThrow('MCP-created');
    await run('close', { leafId: opened.leafId });
    expect(leaves).toEqual([chat]);
    await expect(run('close', { leafId: opened.leafId })).rejects.toThrow('no longer exists');
  });

  it('refuses to close a repurposed or pinned leaf', async () => {
    const { run, leaves } = fixture();
    const anchorId = (await run('list')).leaves[0].leafId;
    const opened = await run('open', { anchorId, path: 'exercise.md' });
    leaves[1].pinned = true;
    await expect(run('close', { leafId: opened.leafId })).rejects.toThrow('unpinned');
    leaves[1].pinned = false;
    leaves[1].path = 'next.md';
    await expect(run('close', { leafId: opened.leafId })).rejects.toThrow('unchanged');
  });

  it('does not create a split for invalid or denied files', async () => {
    const { app, run, split } = fixture();
    const anchorId = (await run('list')).leaves[0].leafId;
    await expect(run('open', { anchorId, path: 'missing.md' })).rejects.toThrow('existing vault file');
    await expect(executeWorkspace(app, 'open', { anchorId, path: 'hidden.md' }, async path => {
      if (path === 'hidden.md') throw new Error('denied');
      return path;
    })).rejects.toThrow('denied');
    expect(split).not.toHaveBeenCalled();
  });

  it('opens, reuses and closes a registered code viewer without replacing chat', async () => {
    const { run, chat, split, leaves } = fixture();
    const anchorId = (await run('list')).leaves[0].leafId;
    const opened = await run('open', { anchorId, path: 'exercise.c' });
    expect(opened).toMatchObject({ type: 'vscode-editor', path: 'exercise.c', managed: true, active: false });
    expect(split).toHaveBeenCalledWith(chat, 'vertical', false);
    leaves[1].pinned = true;
    await expect(run('close', { leafId: opened.leafId })).rejects.toThrow('unpinned');
    leaves[1].pinned = false;
    const reused = await run('open', { leafId: opened.leafId, path: 'next.md' });
    expect(reused).toMatchObject({ leafId: opened.leafId, type: 'markdown', managed: true });
    await run('close', { leafId: opened.leafId });
    expect(leaves).toEqual([chat]);
  });

  it('restores previous pane when splitting or a custom viewer activates the new pane', async () => {
    const { run } = fixture({ activateOnSplit: true, activateOnOpen: true });
    const anchorId = (await run('list')).leaves[0].leafId;
    const opened = await run('open', { anchorId, path: 'exercise.c', focus: false });
    expect(opened.active).toBe(false);
    expect((await run('list')).leaves.find((leaf: any) => leaf.active).leafId).toBe(anchorId);
    const reused = await run('open', { leafId: opened.leafId, path: 'next.md', focus: false });
    expect(reused.active).toBe(false);
    const focused = await run('open', { leafId: opened.leafId, path: 'exercise.c', focus: true });
    expect(focused.active).toBe(true);
  });

  it('keeps the previous pane active when creating an empty split', async () => {
    const { run } = fixture({ activateOnSplit: true });
    const anchorId = (await run('list')).leaves[0].leafId;
    const opened = await run('split', { anchorId, focus: false });
    expect(opened.active).toBe(false);
    expect((await run('list')).leaves.find((leaf: any) => leaf.active).leafId).toBe(anchorId);
  });

  it('rejects unsupported extensions before splitting', async () => {
    const { run, split } = fixture();
    const anchorId = (await run('list')).leaves[0].leafId;
    await expect(run('open', { anchorId, path: 'unsupported.xyz' })).rejects.toThrow('No registered in-pane viewer');
    expect(split).not.toHaveBeenCalled();
  });

  it('offers listing by default but requires opt-in for changes', () => {
    const base = createSemanticTools().find(t => t.name === 'workspace')!;
    expect(base.inputSchema.properties.action).toMatchObject({ enum: ['list', 'inspect'] });
    const enabled = createSemanticTools(undefined, { 'workspace.open': true }).find(t => t.name === 'workspace')!;
    expect(enabled.inputSchema.properties.action).toMatchObject({ enum: ['list', 'inspect', 'open'] });
  });
});
