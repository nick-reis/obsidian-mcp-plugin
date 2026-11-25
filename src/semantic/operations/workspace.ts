import { RouterContext } from './router-context';
import { Params, paramStr, paramBool } from './shared';

export async function executeWorkspaceOperation(ctx: RouterContext, action: string, params: Params): Promise<unknown> {
  const direction = paramStr(params, 'direction');
  if (direction !== undefined && direction !== 'right' && direction !== 'down') {
    throw new Error('Direction must be right or down.');
  }
  for (const key of ['path', 'leafId', 'anchorId', 'direction']) {
    if (params[key] !== undefined && (typeof params[key] !== 'string' || !params[key])) {
      throw new Error('workspace.' + action + ': ' + key + ' must be a nonempty string.');
    }
  }
  if (params.focus !== undefined && typeof params.focus !== 'boolean') throw new Error('focus must be boolean.');
  return ctx.api.workspaceAction(action, {
    path: paramStr(params, 'path'), leafId: paramStr(params, 'leafId'),
    anchorId: paramStr(params, 'anchorId'), direction, focus: paramBool(params, 'focus')
  });
}
