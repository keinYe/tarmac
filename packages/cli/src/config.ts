import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rename, mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
export type ConfigProvider = 'claude' | 'codex';

export const HOOK_MARKER = ' # tarmac-app';
const EVENTS = {
  claude: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure'],
  codex: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PreModelRequest', 'PostModelRequest', 'Stop', 'Interrupt'],
} as const;
const KIMI_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'TurnStarted', 'PermissionRequest',
  'PermissionResult', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'Interrupt'];

// Generate a reviewable snippet only. Existing TOML is never parsed or rewritten.
export function kimiConfigSnippet(command: string): string {
  if (!command.trim() || /[\n\r\0]/.test(command)) throw new Error('a single-line hook command is required');
  return KIMI_EVENTS.map(event => `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command + HOOK_MARKER)}\ntimeout = 1\n`).join('\n');
}
type ObjectValue = Record<string, unknown>;
interface HookHandler extends ObjectValue { type: 'command'; command: string; timeout: number }
interface HookGroup extends ObjectValue { hooks: unknown[] }
export interface ConfigPlan {
  version: 1;
  provider: ConfigProvider;
  operation: 'install' | 'uninstall';
  directory: string;
  target: string;
  beforeHash: string | null;
  command?: string;
  changes: { event: string; command: string; action: 'add' | 'remove' }[];
  requiresAgentTrust: boolean;
}
function isObject(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hash(data: string): string { return createHash('sha256').update(data).digest('hex'); }
function owned(value: unknown): value is HookHandler {
  return isObject(value) && value.type === 'command' && typeof value.command === 'string' && value.command.endsWith(HOOK_MARKER);
}
function targetFor(provider: ConfigProvider, directory: string): string {
  return path.join(directory, provider === 'claude' ? 'settings.json' : 'hooks.json');
}
async function load(target: string): Promise<{ data: ObjectValue; text: string | null; mode: number }> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('configuration must be a regular file');
    const text = await readFile(target, 'utf8');
    const data: unknown = JSON.parse(text);
    if (!isObject(data)) throw new Error('configuration must be a JSON object');
    if (data.hooks !== undefined && !isObject(data.hooks)) throw new Error('hooks must be an object');
    return { data, text, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, text: null, mode: 0o600 };
    throw error;
  }
}

function transform(data: ObjectValue, provider: ConfigProvider, operation: ConfigPlan['operation'], command?: string): { data: ObjectValue; changes: ConfigPlan['changes'] } {
  const next = structuredClone(data);
  const hooks = (next.hooks ?? {}) as ObjectValue;
  const changes: ConfigPlan['changes'] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error('hook event must contain an array');
    const kept = groups.flatMap(group => {
      if (!isObject(group) || !Array.isArray(group.hooks)) throw new Error('hook group must contain a hooks array');
      let removed = false;
      const remaining = group.hooks.filter(handler => {
        if (!owned(handler)) return true;
        removed = true;
        changes.push({ event, command: handler.command, action: 'remove' });
        return false;
      });
      if (!removed) return [group];
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (operation === 'install') {
    if (!command?.trim() || /[\n\r\0]/.test(command)) throw new Error('a single-line hook command is required');
    const marked = command + HOOK_MARKER;
    for (const event of EVENTS[provider]) {
      const handler: HookHandler = { type: 'command', command: marked, timeout: 1 };
      const group: HookGroup = { hooks: [handler] };
      hooks[event] = [...(hooks[event] as unknown[] | undefined ?? []), group];
      changes.push({ event, command: marked, action: 'add' });
    }
  }
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { data: next, changes };
}

export async function planConfig(provider: ConfigProvider, directory: string, operation: ConfigPlan['operation'], command?: string): Promise<ConfigPlan> {
  if (!path.isAbsolute(directory)) throw new Error('--dir must be an explicit absolute directory');
  const target = targetFor(provider, path.resolve(directory));
  const { data, text } = await load(target);
  const { changes } = transform(data, provider, operation, command);
  return {
    version: 1, provider, operation, directory: path.resolve(directory), target,
    beforeHash: text === null ? null : hash(text), ...(command ? { command } : {}), changes,
    requiresAgentTrust: provider === 'codex' && operation === 'install',
  };
}

export async function applyConfigPlan(plan: ConfigPlan): Promise<{ target: string; changed: boolean }> {
  if (plan.version !== 1 || (plan.provider !== 'claude' && plan.provider !== 'codex')
    || (plan.operation !== 'install' && plan.operation !== 'uninstall') || !path.isAbsolute(plan.directory)
    || plan.target !== targetFor(plan.provider, plan.directory)) throw new Error('invalid configuration plan');
  // A target symlink or a symlink directory must not redirect an inspected plan.
  await mkdir(plan.directory, { recursive: true, mode: 0o700 });
  if (await realpath(plan.directory) !== path.resolve(plan.directory)) throw new Error('configuration directory cannot contain symlinks');
  const current = await load(plan.target);
  if ((current.text === null ? null : hash(current.text)) !== plan.beforeHash) throw new Error('configuration changed since plan; generate a new plan');
  const result = transform(current.data, plan.provider, plan.operation, plan.command);
  if (JSON.stringify(result.changes) !== JSON.stringify(plan.changes)) throw new Error('configuration plan changes do not match');
  if (result.changes.length === 0) return { target: plan.target, changed: false };
  const temporary = path.join(plan.directory, `.tarmac-config-${randomUUID()}.json`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, current.mode);
    try {
      await file.writeFile(JSON.stringify(result.data, null, 2) + '\n');
      await file.sync();
    } finally { await file.close(); }
    const latest = await load(plan.target);
    if ((latest.text === null ? null : hash(latest.text)) !== plan.beforeHash) throw new Error('configuration changed while applying plan; target left unchanged');
    await rename(temporary, plan.target);
  } finally { await unlink(temporary).catch(() => {}); }
  return { target: plan.target, changed: true };
}
