import { App, TFile, WorkspaceItem, WorkspaceLeaf } from 'obsidian';
import { randomUUID } from 'crypto';

export interface WorkspaceOptions {
  path?: string;
  leafId?: string;
  anchorId?: string;
  direction?: 'right' | 'down';
  focus?: boolean;
}

export type WorkspaceValidate = (path?: string, mutation?: boolean) => Promise<string | undefined>;

interface ManagedLeaf { type: string; path?: string }
const ids = new WeakMap<WorkspaceItem, string>();
const managed = new WeakMap<WorkspaceLeaf, ManagedLeaf>();
const busy = new WeakSet<App>();

function id(item: WorkspaceItem): string {
  let value = ids.get(item);
  if (!value) {
    value = randomUUID();
    ids.set(item, value);
  }
  return value;
}

function state(leaf: WorkspaceLeaf) {
  const view = leaf.getViewState();
  const path = typeof view.state?.file === 'string' ? view.state.file : undefined;
  // Only disclose the web origin, never the chat URL, query, or page contents.
  let origin: string | undefined;
  if (view.type === 'webviewer' && typeof view.state?.url === 'string') {
    try {
      const url = new URL(view.state.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
    } catch { /* A non-HTTP or malformed URL has no usable origin. */ }
  }
  return { type: view.type, path, origin, pinned: view.pinned === true };
}

function owned(leaf: WorkspaceLeaf): boolean {
  const expected = managed.get(leaf);
  const actual = state(leaf);
  return !!expected && (actual.type === 'empty' || (actual.path !== undefined && actual.type !== 'webviewer')) && !actual.pinned && expected.type === actual.type && expected.path === actual.path;
}

export async function executeWorkspace(
  app: App, action: string, options: WorkspaceOptions, validate: WorkspaceValidate = async path => path
): Promise<unknown> {
  const workspace = app.workspace;
  function leaves(): WorkspaceLeaf[] {
    const result: WorkspaceLeaf[] = [];
    workspace.iterateRootLeaves(leaf => { result.push(leaf); });
    return result;
  }
  function find(leafId: string | undefined): WorkspaceLeaf {
    if (!leafId) throw new Error('An explicit workspace leaf ID is required. Run workspace.list first.');
    const leaf = leaves().find(item => id(item) === leafId);
    if (!leaf) throw new Error('Workspace leaf no longer exists. Run workspace.list again.');
    return leaf;
  }
  function describe(leaf: WorkspaceLeaf) {
    const info = state(leaf);
    return { leafId: id(leaf), groupId: id(leaf.parent), ...info,
      active: workspace.getMostRecentLeaf() === leaf, managed: owned(leaf) };
  }
  async function checkLeaf(leaf: WorkspaceLeaf, mutation: boolean) {
    const before = state(leaf);
    await validate(before.path, mutation);
    const after = state(leaf);
    if (!leaves().includes(leaf) || before.path !== after.path || before.type !== after.type) {
      throw new Error('Workspace leaf changed during validation. Run workspace.list again.');
    }
  }

  if (action === 'list' || action === 'inspect') {
    await validate();
    const visible = [];
    for (const leaf of leaves()) {
      try { await checkLeaf(leaf, false); } catch { continue; }
      visible.push(describe(leaf));
    }
    return { leaves: visible, scope: 'main workspace', idsValidUntil: 'plugin reload or leaf removal' };
  }
  if (!['open', 'split', 'close', 'focus'].includes(action)) {
    throw new Error('Unknown workspace action: ' + action);
  }
  // Serialize mutations across MCP sessions; do not race over the same pane.
  if (busy.has(app)) throw new Error('Another workspace operation is in progress. Retry.');
  busy.add(app);
  try {
    await validate(undefined, true);
    if (action === 'focus' || action === 'close') {
      const leaf = find(options.leafId);
      await checkLeaf(leaf, true);
      if (action === 'close') {
        if (!owned(leaf)) throw new Error('Only unchanged, unpinned MCP-created panes may be closed.');
        leaf.detach();
        managed.delete(leaf);
        return { success: true, leafId: options.leafId, closed: true };
      }
      workspace.setActiveLeaf(leaf, { focus: true });
      return { success: true, ...describe(leaf) };
    }

    if (options.leafId && options.anchorId) throw new Error('Specify leafId for reuse or anchorId for a new split, not both.');
    if (action === 'split' && options.leafId) throw new Error('workspace.split requires anchorId.');
    if (options.direction && options.direction !== 'right' && options.direction !== 'down') {
      throw new Error('Direction must be right or down.');
    }

    let file: TFile | undefined;
    let expectedType: string | undefined;
    if (action === 'open') {
      if (!options.path) throw new Error('workspace.open requires path.');
      const path = await validate(options.path, false);
      if (!path) throw new Error('Path validation did not return a file path.');
      const candidate = app.vault.getAbstractFileByPath(path);
      if (!(candidate instanceof TFile)) {
        throw new Error('workspace.open requires an existing vault file.');
      }
      // Obsidian's extension registry is internal. Fail closed for non-Markdown
      // files without a registered viewer rather than launching an external app.
      const registry = (app as App & { viewRegistry?: { getTypeByExtension?: (extension: string) => string | undefined } }).viewRegistry;
      expectedType = candidate.extension === 'md' ? 'markdown' : registry?.getTypeByExtension?.(candidate.extension);
      if (!expectedType || expectedType === 'empty' || expectedType === 'webviewer') {
        throw new Error('No registered in-pane viewer for .' + candidate.extension + ' files.');
      }
      file = candidate;
    }

    const target = find(options.leafId ?? options.anchorId);
    await checkLeaf(target, true);
    if (options.leafId && !owned(target)) throw new Error('Only unchanged, unpinned MCP-created panes may be reused.');
    // Splitting or loading a custom viewer can activate its leaf even when
    // openFile receives active: false. Preserve the previous main pane.
    const previous = workspace.getMostRecentLeaf();
    const fresh = !options.leafId;
    const leaf = fresh
      ? workspace.createLeafBySplit(target, options.direction === 'down' ? 'horizontal' : 'vertical', false)
      : target;
    const restoreFocus = () => {
      // Do not override navigation to a different pane during async loading.
      if (options.focus !== true && previous && previous !== leaf &&
          workspace.getMostRecentLeaf() === leaf && leaves().includes(previous)) {
        workspace.setActiveLeaf(previous, { focus: true });
      }
    };
    try {
      if (file) {
        await leaf.openFile(file, { active: options.focus === true });
        const info = state(leaf);
        if (info.type !== expectedType || info.path !== file.path) {
          throw new Error('The requested file did not open in its registered viewer in the target pane.');
        }
      }
      const info = state(leaf);
      if (!file && info.type !== 'empty') throw new Error('The new split was not empty; it was left untouched.');
      managed.set(leaf, { type: info.type, path: info.path });
      if (options.focus === true) workspace.setActiveLeaf(leaf, { focus: true });
      else restoreFocus();
      return { success: true, ...describe(leaf) };
    } catch (error) {
      // Never detach a reused leaf or a new leaf that the user has navigated.
      restoreFocus();
      if (fresh && state(leaf).type === 'empty' && !state(leaf).pinned) leaf.detach();
      throw error;
    }
  } finally {
    busy.delete(app);
  }
}
