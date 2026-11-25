import { App, TFile } from 'obsidian';
import { executeWorkspace } from '../src/utils/workspace-api';
import { createSemanticTools } from '../src/tools/semantic-tools';

function fixture() {
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
      this.type = 'markdown'; this.path = file.path;
      if (options.active) current = this;
    }
    detach() { leaves.splice(leaves.indexOf(this), 1); }
  }
  const chat = new FakeLeaf();
  chat.type = 'webviewer';
  chat.url = 'https://chatgpt.com/c/private-conversation?secret=1';
  leaves.push(chat); current = chat;
  const split = jest.fn((_leaf: FakeLeaf, _direction: string, _before: boolean) => {
    const leaf = new FakeLeaf(); leaves.push(leaf); return leaf;
  });
  const app = {
    workspace: {
      iterateRootLeaves: (fn: (leaf: FakeLeaf) => void) => leaves.forEach(fn),
      getMostRecentLeaf: () => current,
      createLeafBySplit: split,
      setActiveLeaf: (leaf: FakeLeaf) => { current = leaf; },
    },
    vault: { getAbstractFileByPath: (path: string) => {
      if (!['exercise.md', 'next.md', 'hidden.md'].includes(path)) return null;
      const file = new TFile();
      Object.assign(file, { path, extension: 'md' });
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
    await expect(run('open', { anchorId, path: 'missing.md' })).rejects.toThrow('existing Markdown');
    await expect(executeWorkspace(app, 'open', { anchorId, path: 'hidden.md' }, async path => {
      if (path === 'hidden.md') throw new Error('denied');
      return path;
    })).rejects.toThrow('denied');
    expect(split).not.toHaveBeenCalled();
  });

  it('offers listing by default but requires opt-in for changes', () => {
    const base = createSemanticTools().find(t => t.name === 'workspace')!;
    expect(base.inputSchema.properties.action).toMatchObject({ enum: ['list', 'inspect'] });
    const enabled = createSemanticTools(undefined, { 'workspace.open': true }).find(t => t.name === 'workspace')!;
    expect(enabled.inputSchema.properties.action).toMatchObject({ enum: ['list', 'inspect', 'open'] });
  });
});
