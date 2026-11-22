import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { applyConfigPlan, planConfig, type ConfigPlan } from '../../../packages/cli/src/config.ts';
import { applyKimiPlan, planKimiConfig, type KimiPlan } from '../../../packages/cli/src/kimi-config.ts';
import { applyAgyPlan, planAgyConfig, type AgyPlan } from '../../../packages/cli/src/agy-config.ts';
import type { HookProvider, HookStatus, HookPlanView, HookApplied } from './bridge.ts';

// One-click install of the App's own hooks into the user's agent configuration. The user sees
// the plan first; only entries carrying the tarmac marker are added or removed; the previous
// file is backed up and an undo restores it exactly while nothing else has changed it since.

type Plan = ConfigPlan | KimiPlan | AgyPlan;

export interface InstallerOptions {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  backupDir: string;
  // Absent when the App cannot name a stable command, e.g. when it runs from the repository.
  command?: (provider: HookProvider) => string;
  unavailable?: string;
}

export function configDirectory(provider: HookProvider, env: NodeJS.ProcessEnv, homeDir: string): string {
  return path.resolve(provider === 'claude' ? env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
    : provider === 'kimi' ? env.KIMI_CODE_HOME || path.join(homeDir, '.kimi-code')
    : path.join(homeDir, '.gemini/config'));
}

// An install plan that only re-adds the entries it removes means the hooks are already current.
export function statusOf(plan: Plan): 'missing' | 'stale' | 'current' {
  const removes = plan.changes.filter(change => change.action === 'remove');
  const adds = plan.changes.filter(change => change.action === 'add');
  if (!removes.length) return 'missing';
  const key = (change: Plan['changes'][number]) => `${change.event}\0${change.command}`;
  const removed = new Set(removes.map(key));
  return removes.length === adds.length && removed.size === adds.length && adds.every(change => removed.has(key(change))) ? 'current' : 'stale';
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function readOptional(file: string): Promise<{ text: string; mode: number } | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} must be a regular file`);
    return { text: await readFile(file, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}

async function writeAtomic(target: string, text: string, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(target), `.tarmac-restore-${randomUUID()}`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

export class HookInstaller {
  private pending: Plan | undefined;
  private applied: { target: string; backup?: string; afterHash: string } | undefined;
  private readonly options: InstallerOptions;
  constructor(options: InstallerOptions) { this.options = options; }

  private plan(provider: HookProvider, operation: 'install' | 'uninstall'): Promise<Plan> {
    const command = this.options.command?.(provider);
    if (!command) throw new Error(this.options.unavailable ?? 'hook command unavailable');
    const directory = configDirectory(provider, this.options.env, this.options.homeDir);
    if (provider === 'kimi') return planKimiConfig(directory, operation, command);
    if (provider === 'agy') return planAgyConfig(directory, operation, command);
    return planConfig('claude', directory, operation, command);
  }

  async status(provider: HookProvider): Promise<HookStatus> {
    if (!this.options.command) return { state: 'unavailable', reason: this.options.unavailable ?? 'hook command unavailable' };
    try { return { state: statusOf(await this.plan(provider, 'install')) }; }
    catch (error) { return { state: 'unavailable', reason: message(error) }; }
  }

  async preview(provider: HookProvider): Promise<HookPlanView> {
    const plan = await this.plan(provider, 'install');
    this.pending = plan;
    return { provider, target: plan.target, command: plan.command!,
      adds: plan.changes.filter(change => change.action === 'add').map(change => change.event),
      removes: plan.changes.filter(change => change.action === 'remove').map(({ event, command }) => ({ event, command })) };
  }

  // Applies only the plan the user was shown; a changed file makes the plan fail, not merge.
  async apply(): Promise<HookApplied> {
    const plan = this.pending;
    this.pending = undefined;
    if (!plan) throw new Error('请先查看安装方案');
    const before = await readOptional(plan.target);
    let backup: string | undefined;
    if (before) {
      await mkdir(this.options.backupDir, { recursive: true, mode: 0o700 });
      backup = path.join(this.options.backupDir, `${plan.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(plan.target)}`);
      const file = await open(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await file.writeFile(before.text); await file.sync(); } finally { await file.close(); }
    }
    if (plan.provider === 'kimi') await applyKimiPlan(plan);
    else if (plan.provider === 'agy') await applyAgyPlan(plan);
    else await applyConfigPlan(plan);
    const after = await readOptional(plan.target);
    if (!after) throw new Error(`${plan.target} disappeared after writing`);
    this.applied = { target: plan.target, ...(backup ? { backup } : {}), afterHash: hash(after.text) };
    return { target: plan.target, ...(backup ? { backup } : {}) };
  }

  // Restores the file as it was before the last apply; a later edit by anyone blocks it.
  async undo(): Promise<{ target: string }> {
    const applied = this.applied;
    if (!applied) throw new Error('没有可撤销的安装');
    const current = await readOptional(applied.target);
    if (!current || hash(current.text) !== applied.afterHash) throw new Error(`${applied.target} 在安装后又被修改过，请手动处理；备份在 ${applied.backup ?? '（安装前文件不存在）'}`);
    if (applied.backup) await writeAtomic(applied.target, await readFile(applied.backup, 'utf8'), current.mode);
    else await rm(applied.target);
    this.applied = undefined;
    return { target: applied.target };
  }
}
