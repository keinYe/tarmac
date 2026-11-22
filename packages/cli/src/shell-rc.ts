// Shell startup files that auto-start tmux take over the Tarmac terminal: the agent then runs in
// the tmux server, outside the PTY, and cannot be identified. With the user's consent, this module
// guards recognized auto-start lines so they are skipped inside Tarmac (TARMAC_SESSION_ID is set
// in every Tarmac PTY). Same contract as config.ts: plan -> review -> apply with a hash check;
// only edits carrying the marker are ever reverted.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOOK_MARKER } from './config.ts';

export const GUARD = '[[ -z "$TARMAC_SESSION_ID" ]]';
const IF_GUARD = `if ${GUARD} && `;
const WRAP_OPEN = `if ${GUARD}; then${HOOK_MARKER}`;
const WRAP_CLOSE = `fi${HOOK_MARKER}`;
const FILES: Record<string, string[]> = {
  zsh: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'],
  bash: ['.bash_profile', '.bash_login', '.profile', '.bashrc'],
};

export interface RcChange { line: number; kind: 'if' | 'wrap'; before: string; after: string[] }
export interface RcUnrecognized { line: number; text: string }
export interface RcFilePlan { file: string; target: string; symlink: boolean; beforeHash: string; changes: RcChange[]; unrecognized: RcUnrecognized[] }
export interface RcPlan { version: 1; operation: 'install' | 'uninstall'; shell: string; files: RcFilePlan[]; unsupported?: string }

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const comment = (line: string) => /^\s*#/.test(line);
const indent = (line: string) => /^\s*/.exec(line)![0];
// A command position that starts tmux: `tmux`, `exec tmux`, `command tmux`, optionally with arguments.
const LAUNCH = /(?:^|[;&|({!]|\bthen|\bdo|\belse)\s*(?:exec\s+|command\s+)?tmux(?=\s|$|;|\)|\})(?!\s+(?:has-session|ls|list-\w+|-V)\b)/;
const TMUX_VAR = /\$\{?TMUX\b(?!_)/;
const OMZ = /^\s*(?:export\s+)?ZSH_TMUX_AUTOSTART=(?:true|"true"|'true')\s*(?:#.*)?$/;

/** Pure: the guarded text plus every change, and tmux launches it cannot safely guard. */
export function guardText(text: string): { text: string; changes: RcChange[]; unrecognized: RcUnrecognized[] } {
  const lines = text.split('\n');
  const changes: RcChange[] = [];
  const unrecognized: RcUnrecognized[] = [];
  const covered = new Set<number>();
  if (text.includes('\r')) {
    lines.forEach((line, index) => { if (!comment(line) && LAUNCH.test(line)) unrecognized.push({ line: index + 1, text: line.trim() }); });
    return { text, changes, unrecognized };
  }
  const guarded = (index: number) => lines[index].includes('TARMAC_SESSION_ID') || (index > 0 && lines[index - 1].trim() === WRAP_OPEN);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (comment(line) || covered.has(index)) continue;
    if (guarded(index)) { covered.add(index); continue; }
    if (/^\s*if\s/.test(line) && TMUX_VAR.test(line)) {
      // Body: up to the first `fi` at the same or lower indentation.
      let end = index;
      if (!/\bfi\s*(?:#.*)?$/.test(line)) {
        for (end = index + 1; end < lines.length; end++) {
          if (/^\s*fi\b/.test(lines[end]) && indent(lines[end]).length <= indent(line).length) break;
        }
      }
      const body = lines.slice(index, Math.min(end + 1, lines.length));
      if (!body.some(item => !comment(item) && LAUNCH.test(item.replace(/^\s*if\s.*?;\s*then/, 'then')))) continue;
      // `if a || b` would bind as `(guard && a) || b`; a continued line cannot carry the marker.
      const condition = line.replace(/;\s*then\b.*$/, '');
      if (condition.includes('||') || /\\\s*$/.test(line)) { unrecognized.push({ line: index + 1, text: line.trim() }); }
      else {
        changes.push({ line: index + 1, kind: 'if', before: line, after: [line.replace(/^(\s*)if\s+/, (_match, pad: string) => pad + IF_GUARD) + HOOK_MARKER] });
      }
      for (let item = index; item <= Math.min(end, lines.length - 1); item++) covered.add(item);
      continue;
    }
    if ((TMUX_VAR.test(line) && LAUNCH.test(line) && !/^\s*(?:alias|function)\s/.test(line) && !/\\\s*$/.test(line)) || OMZ.test(line)) {
      const pad = indent(line);
      changes.push({ line: index + 1, kind: 'wrap', before: line, after: [pad + WRAP_OPEN, line, pad + WRAP_CLOSE] });
      covered.add(index);
    }
  }
  lines.forEach((line, index) => {
    if (!covered.has(index) && !comment(line) && !/^\s*alias\s/.test(line) && LAUNCH.test(line)) unrecognized.push({ line: index + 1, text: line.trim() });
  });
  const output: string[] = [];
  const byLine = new Map(changes.map(change => [change.line - 1, change]));
  lines.forEach((line, index) => output.push(...(byLine.get(index)?.after ?? [line])));
  return { text: output.join('\n'), changes, unrecognized };
}

/** Pure inverse of guardText: removes only marked edits. */
export function unguardText(text: string): { text: string; changes: RcChange[] } {
  const lines = text.split('\n');
  const output: string[] = [];
  const changes: RcChange[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === WRAP_OPEN && index + 2 < lines.length && lines[index + 2].trim() === WRAP_CLOSE) {
      changes.push({ line: index + 1, kind: 'wrap', before: lines[index + 1], after: lines.slice(index, index + 3) });
      output.push(lines[index + 1]);
      index += 2;
      continue;
    }
    if (line.endsWith(HOOK_MARKER) && line.trimStart().startsWith(IF_GUARD)) {
      const original = line.slice(0, -HOOK_MARKER.length).replace(IF_GUARD, 'if ');
      changes.push({ line: index + 1, kind: 'if', before: original, after: [line] });
      output.push(original);
      continue;
    }
    output.push(line);
  }
  return { text: output.join('\n'), changes };
}

function startupFiles(shell: string, home: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const name = path.basename(shell);
  const names = FILES[name];
  if (!names) return;
  const base = name === 'zsh' && env.ZDOTDIR && path.isAbsolute(env.ZDOTDIR) ? env.ZDOTDIR : home;
  return names.map(file => path.join(base, file));
}

async function readTarget(file: string): Promise<{ target: string; symlink: boolean; text: string } | undefined> {
  let link;
  try { link = await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const target = link.isSymbolicLink() ? await realpath(file) : file;
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`${file} is not a regular file`);
  if (info.size > 1024 * 1024) throw new Error(`${file} is too large to review`);
  return { target, symlink: link.isSymbolicLink(), text: await readFile(target, 'utf8') };
}

export async function planShellRc(shell: string, operation: RcPlan['operation'], home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<RcPlan> {
  const files = startupFiles(shell, home, env);
  if (!files) return { version: 1, operation, shell, files: [], unsupported: `暂不支持 ${path.basename(shell) || 'unknown'} 的启动文件` };
  const plans: RcFilePlan[] = [];
  for (const file of files) {
    const current = await readTarget(file);
    if (!current) continue;
    const result = operation === 'install' ? guardText(current.text) : { ...unguardText(current.text), unrecognized: [] };
    if (!result.changes.length && !result.unrecognized.length) continue;
    plans.push({ file, target: current.target, symlink: current.symlink, beforeHash: hash(current.text),
      changes: result.changes, unrecognized: result.unrecognized });
  }
  return { version: 1, operation, shell, files: plans };
}

/** Applies only files with changes; each target is backed up, re-verified and replaced atomically. */
export async function applyShellRc(plan: RcPlan, backupDir: string): Promise<{ changed: string[]; backups: string[] }> {
  if (plan?.version !== 1 || (plan.operation !== 'install' && plan.operation !== 'uninstall') || !Array.isArray(plan.files)) throw new Error('invalid shell startup plan');
  if (!path.isAbsolute(backupDir)) throw new Error('backup directory must be absolute');
  const changed: string[] = [];
  const backups: string[] = [];
  for (const entry of plan.files.filter(item => item.changes.length)) {
    const current = await readTarget(entry.file);
    if (!current || current.target !== entry.target || hash(current.text) !== entry.beforeHash) throw new Error(`${entry.file} changed since plan; review it again`);
    const info = await stat(current.target);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${entry.target} is owned by another user`);
    const result = plan.operation === 'install' ? guardText(current.text) : unguardText(current.text);
    if (JSON.stringify(result.changes) !== JSON.stringify(entry.changes)) throw new Error(`${entry.file} plan does not match its content`);
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backup = path.join(backupDir, `${path.basename(entry.target)}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
    await copyFile(current.target, backup, constants.COPYFILE_EXCL);
    backups.push(backup);
    // Write next to the real file so a symlinked dotfile keeps its link and the rename stays atomic.
    const temporary = path.join(path.dirname(current.target), `.tarmac-rc-${randomUUID()}`);
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, info.mode & 0o777);
      try { await file.chmod(info.mode & 0o777); await file.writeFile(result.text); await file.sync(); } finally { await file.close(); }
      if (hash(await readFile(current.target, 'utf8')) !== entry.beforeHash) throw new Error(`${entry.file} changed while applying; left unchanged`);
      await rename(temporary, current.target);
    } finally { await unlink(temporary).catch(() => {}); }
    changed.push(entry.file);
  }
  return { changed, backups };
}
