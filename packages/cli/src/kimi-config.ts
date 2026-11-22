import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HOOK_MARKER, kimiConfigSnippet } from './config.ts';

// Kimi keeps hooks as [[hooks]] tables in config.toml next to the user's providers and models.
// Without a TOML parser in the project, the file is edited at block level only: owned blocks
// (command ending in the marker) are removed whole, new ones are appended at the end, and every
// other byte stays as it was. Anything that block-level editing cannot handle safely is refused.

export interface KimiPlan {
  version: 1;
  provider: 'kimi';
  operation: 'install' | 'uninstall';
  directory: string;
  target: string;
  beforeHash: string;
  command?: string;
  changes: { event: string; command: string; action: 'add' | 'remove' }[];
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const HEADER = /^\s*\[/;
const HOOKS_HEADER = /^\s*\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/;
const KEY_VALUE = /^\s*[A-Za-z0-9_.\-"']+\s*=/;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/;

function stringValue(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`).exec(line);
  if (!match) return;
  if (match[1].startsWith("'")) return match[1].slice(1, -1);
  try { return JSON.parse(match[1]) as string; } catch { return; }
}

export function kimiTransform(text: string, operation: KimiPlan['operation'], command?: string): { text: string; changes: KimiPlan['changes'] } {
  // A table header inside a multi-line string would be indistinguishable from a real one.
  if (text.includes('"""') || text.includes("'''")) throw new Error('Kimi config.toml uses multi-line strings; edit its hooks manually');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const changes: KimiPlan['changes'] = [];
  const kept: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!HOOKS_HEADER.test(lines[index])) { kept.push(lines[index++]); continue; }
    let end = index + 1;
    while (end < lines.length && !HEADER.test(lines[end])) end++;
    // Comments right above the next header belong to that header, not to this block.
    let last = end - 1;
    while (last > index && BLANK_OR_COMMENT.test(lines[last])) last--;
    const body = lines.slice(index + 1, last + 1);
    const value = body.map(line => stringValue(line, 'command')).find(item => item !== undefined);
    if (!value?.endsWith(HOOK_MARKER)) { kept.push(...lines.slice(index, end)); index = end; continue; }
    if (body.some(line => !KEY_VALUE.test(line) && !BLANK_OR_COMMENT.test(line)) || body.some(line => /^\s*#/.test(line))) {
      throw new Error('a Tarmac hook entry in Kimi config.toml was edited by hand; remove it manually');
    }
    changes.push({ event: body.map(line => stringValue(line, 'event')).find(item => item !== undefined) ?? '', command: value, action: 'remove' });
    // Keep trailing comments; drop the block's own blank lines.
    let tail = last + 1;
    while (tail < end && /^\s*$/.test(lines[tail])) tail++;
    kept.push(...lines.slice(tail, end));
    index = end;
  }
  let next = kept.join(eol);
  if (changes.length) next = next.replace(/(?:\r?\n)+$/, '') + (next.trim() ? eol : '');
  if (operation === 'install') {
    const snippet = kimiConfigSnippet(command ?? '');
    for (const match of snippet.matchAll(/event = ("[^"]*")\ncommand = ("(?:[^"\\]|\\.)*")/g)) {
      changes.push({ event: JSON.parse(match[1]), command: JSON.parse(match[2]), action: 'add' });
    }
    const body = next.replace(/(?:\r?\n)+$/, '');
    next = (body ? body + eol + eol : '') + snippet.replaceAll('\n', eol);
  }
  return { text: next, changes };
}

async function load(target: string): Promise<{ text: string; mode: number }> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Kimi config.toml must be a regular file');
  return { text: await readFile(target, 'utf8'), mode: stat.mode & 0o777 };
}

// A missing config.toml means Kimi has not been set up; Tarmac does not create it.
export async function planKimiConfig(directory: string, operation: KimiPlan['operation'], command?: string): Promise<KimiPlan> {
  if (!path.isAbsolute(directory)) throw new Error('Kimi config directory must be absolute');
  const target = path.join(path.resolve(directory), 'config.toml');
  let current;
  try { current = await load(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`未找到 Kimi 配置文件 ${target}，请先运行一次 Kimi`);
    throw error;
  }
  const { changes } = kimiTransform(current.text, operation, command);
  return { version: 1, provider: 'kimi', operation, directory: path.resolve(directory), target, beforeHash: hash(current.text),
    ...(command ? { command } : {}), changes };
}

export async function applyKimiPlan(plan: KimiPlan): Promise<{ target: string; changed: boolean }> {
  if (plan.version !== 1 || plan.provider !== 'kimi' || (plan.operation !== 'install' && plan.operation !== 'uninstall')
    || !path.isAbsolute(plan.directory) || plan.target !== path.join(plan.directory, 'config.toml')) throw new Error('invalid configuration plan');
  if (await realpath(plan.directory) !== path.resolve(plan.directory)) throw new Error('configuration directory cannot contain symlinks');
  const current = await load(plan.target);
  if (hash(current.text) !== plan.beforeHash) throw new Error('configuration changed since plan; generate a new plan');
  const result = kimiTransform(current.text, plan.operation, plan.command);
  if (JSON.stringify(result.changes) !== JSON.stringify(plan.changes)) throw new Error('configuration plan changes do not match');
  if (!result.changes.length) return { target: plan.target, changed: false };
  const temporary = path.join(plan.directory, `.tarmac-config-${randomUUID()}.toml`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, current.mode);
    try { await file.writeFile(result.text); await file.sync(); } finally { await file.close(); }
    if (hash((await load(plan.target)).text) !== plan.beforeHash) throw new Error('configuration changed while applying plan; target left unchanged');
    await rename(temporary, plan.target);
  } finally { await unlink(temporary).catch(() => {}); }
  return { target: plan.target, changed: true };
}
