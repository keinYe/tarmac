import { open } from 'node:fs/promises';
import path from 'node:path';
import { HOOK_MARKER } from './config.ts';
import type { Provider } from '../../protocol/src/index.ts';

export interface InspectOptions {
  env: Record<string, string | undefined>;
  homeDir: string;
  cwd: string;
  args?: string[];
}
export interface HookConfigInspection { configured: boolean; source?: string; error?: string }
type JsonObject = Record<string, unknown>;
interface Source { label: string; filename?: string; inline?: string; required?: boolean }
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }

async function readSource(source: Source): Promise<JsonObject | undefined> {
  let bytes: Buffer;
  if (source.inline !== undefined) bytes = Buffer.from(source.inline);
  else {
    const handle = await open(source.filename!, 'r').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !source.required) return undefined;
      const code = (error as NodeJS.ErrnoException).code ?? 'READ_FAILED';
      throw new Error(`Cannot read ${source.label} (${code})`);
    });
    if (!handle) return;
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Not a regular settings file: ${source.label}`);
      const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      bytes = buffer.subarray(0, length);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Not a regular')) throw error;
      throw new Error(`Cannot read ${source.label} (${(error as NodeJS.ErrnoException).code ?? 'READ_FAILED'})`);
    } finally { await handle.close(); }
  }
  if (bytes.length > MAX_SETTINGS_BYTES) throw new Error(`Settings exceed 2 MiB: ${source.label}`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid JSON in ${source.label}`); }
  if (!object(value)) throw new Error(`Settings must be a JSON object: ${source.label}`);
  return value;
}

function ownsHook(settings: JsonObject, label: string): boolean {
  if (settings.hooks === undefined) return false;
  if (!object(settings.hooks)) throw new Error(`Invalid hooks object in ${label}`);
  let found = false;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid hook event list in ${label}`);
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`Invalid hook group in ${label}`);
      for (const handler of group.hooks) {
        if (!object(handler)) throw new Error(`Invalid hook handler in ${label}`);
        if (handler.type === 'command' && typeof handler.command === 'string'
          && handler.command.endsWith(HOOK_MARKER) && handler.disabled !== true && handler.enabled !== false
          && group.disabled !== true && group.enabled !== false) found = true;
      }
    }
  }
  return found;
}

function ownsAgyHook(settings: JsonObject): boolean {
  for (const hookConfig of Object.values(settings)) {
    if (!object(hookConfig)) continue;
    if (hookConfig.enabled === false) continue;
    for (const [eventName, handlers] of Object.entries(hookConfig)) {
      if (eventName === 'enabled' || !Array.isArray(handlers)) continue;
      for (const item of handlers) {
        if (!object(item)) continue;
        if (item.type === 'command' && typeof item.command === 'string'
          && item.command.endsWith(HOOK_MARKER) && item.disabled !== true && item.enabled !== false) return true;
        if (Array.isArray(item.hooks)) {
          for (const sub of item.hooks) {
            if (object(sub) && sub.type === 'command' && typeof sub.command === 'string'
              && sub.command.endsWith(HOOK_MARKER) && sub.disabled !== true && sub.enabled !== false) return true;
          }
        }
      }
    }
  }
  return false;
}

function flags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break;
    if (args[index] === name) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
      values.push(value);
    } else if (args[index].startsWith(name + '=')) values.push(args[index].slice(name.length + 1));
  }
  return values;
}

// This inspects only on-disk/explicit JSON configuration. Finding an owned
// command is not proof of trust, policy eligibility, or actual event delivery.
export async function inspectHookConfig(provider: Provider, options: InspectOptions): Promise<HookConfigInspection> {
  if (provider === 'kimi') return { configured: false, source: 'Kimi TOML hooks require runtime verification; configuration is not inspected' };
  const sources: Source[] = [];
  const scope = provider === 'codex'
    ? 'JSON hooks file only; TOML, project/plugin/managed layers and trust are not inspected'
    : provider === 'agy'
      ? 'user/workspace JSON hooks only; plugin and sidecar layers are not inspected'
      : 'user/current-directory/explicit JSON only; ancestor/worktree/managed/plugin layers and trust are not inspected';
  const report = () => `${scope}; checked: ${sources.map(source => source.label).join(', ') || 'none'}`;
  try {
    if (!path.isAbsolute(options.homeDir) || !path.isAbsolute(options.cwd)) throw new Error('homeDir and cwd must be absolute');
    const args = options.args ?? [];
    if (provider === 'codex') {
      const directory = path.resolve(options.cwd, options.env.CODEX_HOME || path.join(options.homeDir, '.codex'));
      const filename = path.join(directory, 'hooks.json');
      sources.push({ filename, label: filename });
      const settings = await readSource(sources[0]);
      return { configured: settings ? ownsHook(settings, filename) : false, source: report() };
    }
    if (provider === 'agy') {
      const globalFile = path.join(options.homeDir, '.gemini/config/hooks.json');
      sources.push({ filename: globalFile, label: globalFile });
      const projectFile = path.join(options.cwd, '.agents/hooks.json');
      sources.push({ filename: projectFile, label: projectFile });
      let configured = false;
      for (const source of sources) {
        const settings = await readSource(source);
        if (settings && ownsAgyHook(settings)) configured = true;
      }
      return { configured, source: report() };
    }
    const directory = path.resolve(options.cwd, options.env.CLAUDE_CONFIG_DIR || path.join(options.homeDir, '.claude'));
    const selections = flags(args, '--setting-sources');
    const selected = new Set((selections.at(-1) ?? 'user,project,local').split(',').filter(Boolean));
    if ([...selected].some(value => !['user', 'project', 'local'].includes(value))) throw new Error('Unsupported --setting-sources value');
    if (selected.has('user')) {
      const filename = path.join(directory, 'settings.json'); sources.push({ filename, label: filename });
    }
    if (selected.has('project')) {
      const filename = path.join(options.cwd, '.claude/settings.json'); sources.push({ filename, label: filename });
    }
    if (selected.has('local')) {
      const filename = path.join(options.cwd, '.claude/settings.local.json'); sources.push({ filename, label: filename });
    }
    const extraSettings = flags(args, '--settings');
    if (extraSettings.length > 1) throw new Error('Multiple --settings arguments require runtime verification');
    for (const value of extraSettings) {
      if (/^\s*[\[{]/.test(value)) sources.push({ inline: value, label: '--settings (inline JSON)' });
      else {
        const filename = path.resolve(options.cwd, value);
        sources.push({ filename, label: filename, required: true });
      }
    }
    let found = false;
    let disabled = false;
    for (const source of sources) {
      const settings = await readSource(source);
      if (!settings) continue;
      found = ownsHook(settings, source.label) || found;
      if (settings.disableAllHooks !== undefined) {
        if (typeof settings.disableAllHooks !== 'boolean') throw new Error(`Invalid disableAllHooks in ${source.label}`);
        disabled = settings.disableAllHooks;
      }
      if (settings.allowManagedHooksOnly === true) throw new Error(`allowManagedHooksOnly observed in ${source.label}; cannot establish local hook eligibility`);
    }
    const safeMode = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--')).includes('--safe-mode')
      || /^(?:1|true)$/i.test(options.env.CLAUDE_CODE_SAFE_MODE ?? '');
    const bareMode = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--')).includes('--bare')
      || /^(?:1|true)$/i.test(options.env.CLAUDE_CODE_SIMPLE ?? '');
    if (bareMode) return { configured: false, source: report(), error: 'Bare mode skips hook discovery; explicit-hook eligibility requires runtime verification' };
    if (safeMode || disabled) return { configured: false, source: report(), error: safeMode ? 'Custom hooks disabled by safe mode' : 'Custom hooks disabled by disableAllHooks' };
    return { configured: found, source: report() };
  } catch (error) {
    return { configured: false, source: report(), error: error instanceof Error ? error.message : 'Hook configuration inspection failed' };
  }
}
