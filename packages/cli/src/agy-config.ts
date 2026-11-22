import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rename, mkdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HOOK_MARKER } from './config.ts';

export const AGY_EVENTS = [
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'Stop',
  'PreToolUse',
  'PostToolUse',
] as const;

export type AgyEvent = typeof AGY_EVENTS[number];

export interface AgyPlan {
  version: 1;
  provider: 'agy';
  operation: 'install' | 'uninstall';
  directory: string;
  target: string;
  beforeHash: string | null;
  command?: string;
  changes: { event: string; command: string; action: 'add' | 'remove' }[];
}

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function targetForAgy(directory: string): string {
  return path.join(directory, 'hooks.json');
}

async function load(target: string): Promise<{ data: ObjectValue; text: string | null; mode: number }> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('configuration must be a regular file');
    const text = await readFile(target, 'utf8');
    const data: unknown = JSON.parse(text);
    if (!isObject(data)) throw new Error('configuration must be a JSON object');
    return { data, text, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, text: null, mode: 0o600 };
    throw error;
  }
}

export function transformAgy(
  data: ObjectValue,
  operation: AgyPlan['operation'],
  command?: string,
): { data: ObjectValue; changes: AgyPlan['changes'] } {
  const next = structuredClone(data);
  const changes: AgyPlan['changes'] = [];

  // Remove only marked handlers in every hook name. A matcher group, event or hook name is dropped
  // only when that removal emptied it; everything the user wrote stays as it was.
  for (const [hookName, hookConfig] of Object.entries(next)) {
    if (!isObject(hookConfig)) continue;
    let removedAny = false;
    for (const [event, handlers] of Object.entries(hookConfig)) {
      if (!Array.isArray(handlers)) continue;
      let removed = false;
      const drop = (handler: unknown): boolean => {
        if (!isObject(handler) || typeof handler.command !== 'string' || !handler.command.endsWith(HOOK_MARKER)) return false;
        removed = true;
        changes.push({ event, command: handler.command, action: 'remove' });
        return true;
      };
      const kept = event === 'PreToolUse' || event === 'PostToolUse'
        ? handlers.flatMap(group => {
          if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
          const remaining = group.hooks.filter(handler => !drop(handler));
          return remaining.length || remaining.length === group.hooks.length ? [{ ...group, hooks: remaining }] : [];
        })
        : handlers.filter(handler => !drop(handler));
      if (!removed) continue;
      removedAny = true;
      if (kept.length) hookConfig[event] = kept;
      else delete hookConfig[event];
    }
    if (removedAny && Object.keys(hookConfig).length === 0) delete next[hookName];
  }

  if (operation === 'install') {
    if (!command?.trim() || /[\n\r\0]/.test(command)) throw new Error('a single-line hook command is required');
    const marked = command + HOOK_MARKER;
    // Append to an existing "tarmac" hook name rather than replacing what the user put there.
    if (next.tarmac !== undefined && !isObject(next.tarmac)) throw new Error('hook name "tarmac" must be an object');
    const tarmac: ObjectValue = isObject(next.tarmac) ? next.tarmac : {};
    for (const event of AGY_EVENTS) {
      const handler = { type: 'command', command: marked, timeout: 1 };
      const current = tarmac[event];
      if (current !== undefined && !Array.isArray(current)) throw new Error(`tarmac.${event} must be an array`);
      tarmac[event] = [...(Array.isArray(current) ? current : []),
        event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*', hooks: [handler] } : handler];
      changes.push({ event, command: marked, action: 'add' });
    }
    next.tarmac = tarmac;
  }

  return { data: next, changes };
}

export async function planAgyConfig(
  directory: string,
  operation: AgyPlan['operation'],
  command?: string,
): Promise<AgyPlan> {
  if (!path.isAbsolute(directory)) throw new Error('--dir must be an explicit absolute directory');
  const target = targetForAgy(path.resolve(directory));
  const { data, text } = await load(target);
  const { changes } = transformAgy(data, operation, command);
  return {
    version: 1,
    provider: 'agy',
    operation,
    directory: path.resolve(directory),
    target,
    beforeHash: text === null ? null : hash(text),
    ...(command ? { command } : {}),
    changes,
  };
}

export async function applyAgyPlan(plan: AgyPlan): Promise<{ target: string; changes: number }> {
  if (!path.isAbsolute(plan.target)) throw new Error('plan target must be absolute');
  const { data, text, mode } = await load(plan.target);
  const currentHash = text === null ? null : hash(text);
  if (currentHash !== plan.beforeHash) throw new Error('configuration changed since plan was generated');
  const { data: transformed } = transformAgy(data, plan.operation, plan.command);
  await mkdir(path.dirname(plan.target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(plan.target), `.hooks-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      await handle.writeFile(JSON.stringify(transformed, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, plan.target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { target: plan.target, changes: plan.changes.length };
}
