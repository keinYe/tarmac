import { runHook } from './hook.ts';
import { runCtl } from './ctl.ts';
import { planConfig, applyConfigPlan, kimiConfigSnippet, type ConfigPlan } from './config.ts';
import { planAgyConfig, applyAgyPlan, type AgyPlan } from './agy-config.ts';
import type { Provider } from '../../protocol/src/index.ts';
import { statusline } from './statusline.ts';
import { applyShellRc, planShellRc, type RcPlan } from './shell-rc.ts';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { daemonEnv, runBridge } from './bridge.ts';
import { DAEMON_NODE_FLAGS } from '../../daemon/src/runtime.ts';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function provider(value: string | undefined): Provider {
  if (value !== 'claude' && value !== 'codex' && value !== 'kimi' && value !== 'agy') throw new Error('provider must be claude, codex, kimi or agy');
  return value;
}

async function main(args: string[]): Promise<void> {
  if (args[0] === 'ctl') {
    // One JSON line in every case, including argument errors; see packages/cli/src/ctl.ts.
    const result = await runCtl(args.slice(1), process.stdin);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (args[0] === 'bridge') {
    // Bundled layout: dist/cli.cjs beside dist/daemon.cjs and dist/app/package.json.
    const { version } = JSON.parse(await readFile(path.join(__dirname, 'app', 'package.json'), 'utf8')) as { version: string };
    await runBridge({ version, stdin: process.stdin, stdout: process.stdout, dataDir: option(args, '--data-dir'),
      startDaemon: dataDir => {
        spawn(process.execPath, [...DAEMON_NODE_FLAGS, path.join(__dirname, 'daemon.cjs'), '--data-dir', dataDir], {
          env: { ...daemonEnv(process.env), ELECTRON_RUN_AS_NODE: '1' }, cwd: dataDir, detached: true, stdio: 'ignore',
        }).unref();
      } });
    // stdin may stay open after the daemon went away; nothing else is left to copy.
    process.stdout.write('', () => process.exit(0));
    return;
  }
  if (args[0] === 'hook') {
    try { await runHook(provider(args[1]), process.stdin); }
    catch { /* Telemetry must not change agent decisions or leak payloads. */ }
    // Kimi appends stdout to model context, so its observational hooks stay silent.
    if (args[1] !== 'kimi') process.stdout.write('{}\n');
    process.exitCode = 0;
    return;
  }
  if (args[0] === 'statusline' && args[1] === 'claude') {
    const forward = option(args, '--forward');
    if (!forward?.trim()) throw new Error('--forward must name the existing statusLine command');
    try { await statusline(process.stdin, forward); }
    catch { /* Never leak statusLine stdin or inject a telemetry error into stdout. */ }
    return;
  }
  if (args[0] === 'config' && args[1] === 'snippet' && option(args, '--provider') === 'kimi') {
    process.stdout.write(kimiConfigSnippet(option(args, '--command') ?? ''));
    return;
  }
  if (args[0] === 'config' && args[1] === 'plan') {
    const directory = option(args, '--dir');
    if (!directory) throw new Error('--dir is required; no user configuration is selected by default');
    const operation = option(args, '--operation') ?? 'install';
    if (operation !== 'install' && operation !== 'uninstall') throw new Error('operation must be install or uninstall');
    const kind = provider(option(args, '--provider'));
    if (kind === 'kimi') throw new Error('Kimi uses explicit TOML hooks; see docs/app-hooks-usage.md');
    if (kind === 'agy') {
      const plan = await planAgyConfig(directory, operation, option(args, '--command'));
      process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      return;
    }
    const plan = await planConfig(kind, directory, operation, option(args, '--command'));
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  if (args[0] === 'config' && (args[1] === 'install' || args[1] === 'uninstall')) {
    const filename = option(args, '--plan');
    if (!filename) throw new Error('--plan is required; inspect config plan before applying it');
    const plan = JSON.parse(await readFile(filename, 'utf8')) as ConfigPlan | AgyPlan;
    if (plan.operation !== args[1]) throw new Error('plan operation does not match command');
    if (plan.provider === 'agy') {
      process.stdout.write(JSON.stringify(await applyAgyPlan(plan)) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify(await applyConfigPlan(plan)) + '\n');
    return;
  }
  if (args[0] === 'shell-rc' && args[1] === 'plan') {
    const operation = option(args, '--operation') ?? 'install';
    if (operation !== 'install' && operation !== 'uninstall') throw new Error('operation must be install or uninstall');
    const plan = await planShellRc(option(args, '--shell') ?? process.env.SHELL ?? '/bin/sh', operation);
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  if (args[0] === 'shell-rc' && (args[1] === 'install' || args[1] === 'uninstall')) {
    const filename = option(args, '--plan');
    const backups = option(args, '--backup-dir');
    if (!filename || !backups) throw new Error('--plan and --backup-dir are required; inspect shell-rc plan before applying it');
    const plan = JSON.parse(await readFile(filename, 'utf8')) as RcPlan;
    if (plan.operation !== args[1]) throw new Error('plan operation does not match command');
    process.stdout.write(JSON.stringify(await applyShellRc(plan, backups)) + '\n');
    return;
  }
  throw new Error('usage: tarmac ctl <list|screen|text|key|create|close> [...] | bridge [--data-dir <absolute-directory>] | hook <claude|codex|kimi> | statusline claude --forward <existing-command> | config snippet --provider kimi --command <hook-command> | config plan --provider <claude|codex> --dir <absolute-directory> --command <hook-command> [--operation install|uninstall] | config install|uninstall --plan <file> | shell-rc plan [--operation install|uninstall] [--shell <path>] | shell-rc install|uninstall --plan <file> --backup-dir <absolute-directory>');
}

main(process.argv.slice(2)).catch(error => {
  // Errors only describe configuration shape or transport classes, never hook stdin.
  process.stderr.write((error instanceof Error ? error.message : 'command failed') + '\n');
  process.exitCode = 1;
});
