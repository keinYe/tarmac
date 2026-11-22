import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyShellRc, guardText, planShellRc, unguardText } from './shell-rc.ts';

const USER_SNIPPET = [
  '# Load keys before starting tmux.',
  'if [[ -z "$TMUX" ]] && [[ -z "$SSH_CONNECTION" ]] && command -v tmux >/dev/null 2>&1; then',
  '  exec tmux new-session',
  'fi',
  'export PATH="$HOME/bin:$PATH"',
  '',
].join('\n');

test('guards the common if-block auto-start and reverts it byte for byte', () => {
  const result = guardText(USER_SNIPPET);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'if');
  assert.equal(result.changes[0].line, 2);
  assert.equal(result.text.split('\n')[1],
    'if [[ -z "$TARMAC_SESSION_ID" ]] && [[ -z "$TMUX" ]] && [[ -z "$SSH_CONNECTION" ]] && command -v tmux >/dev/null 2>&1; then # tarmac-app');
  assert.deepEqual(result.unrecognized, []);
  assert.equal(guardText(result.text).changes.length, 0, 'already guarded text is left alone');
  const reverted = unguardText(result.text);
  assert.equal(reverted.text, USER_SNIPPET);
  assert.equal(reverted.changes.length, 1);
});

test('wraps one-line auto-starts and oh-my-zsh autostart, keeping indentation and comments', () => {
  const text = '  [ -z "$TMUX" ] && exec tmux new -A -s main # auto\nZSH_TMUX_AUTOSTART=true\nplugins=(git tmux)\n';
  const result = guardText(text);
  assert.deepEqual(result.changes.map(change => [change.line, change.kind]), [[1, 'wrap'], [2, 'wrap']]);
  assert.deepEqual(result.text.split('\n').slice(0, 6), [
    '  if [[ -z "$TARMAC_SESSION_ID" ]]; then # tarmac-app', '  [ -z "$TMUX" ] && exec tmux new -A -s main # auto', '  fi # tarmac-app',
    'if [[ -z "$TARMAC_SESSION_ID" ]]; then # tarmac-app', 'ZSH_TMUX_AUTOSTART=true', 'fi # tarmac-app',
  ]);
  assert.equal(guardText(result.text).changes.length, 0);
  assert.equal(unguardText(result.text).text, text);
});

test('single-line if blocks are guarded in place', () => {
  const result = guardText('if [[ -z $TMUX ]]; then exec tmux; fi\n');
  assert.deepEqual(result.changes.map(change => change.kind), ['if']);
  assert.equal(unguardText(result.text).text, 'if [[ -z $TMUX ]]; then exec tmux; fi\n');
});

test('reports launches it cannot guard safely and ignores non-launches', () => {
  const text = [
    'if [ -z "$TMUX" ] || [ "$FORCE" = 1 ]; then', '  tmux attach', 'fi',
    'exec tmux',
    'alias t="tmux attach"',
    '# exec tmux',
    'tmux ls >/dev/null 2>&1',
    'if [[ -n $TMUX ]]; then echo inside; fi',
    'echo "$TMUX_PANE"',
  ].join('\n');
  const result = guardText(text);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unrecognized.map(item => item.line), [1, 4]);
  assert.equal(result.text, text);
});

test('CRLF files are never edited', () => {
  const result = guardText('if [[ -z "$TMUX" ]]; then\r\n  exec tmux\r\nfi\r\n');
  assert.deepEqual(result.changes, []);
  assert.equal(result.unrecognized.length, 1);
});

for (const shell of ['bash', 'zsh']) {
  const binary = `/bin/${shell}`;
  test(`guarded snippets skip only inside Tarmac (${shell})`, { skip: !existsSync(binary) && !existsSync(`/usr/bin/${shell}`) }, () => {
    // A function stands in for the tmux binary so the guarded launch lines really run.
    const source = 'tmux() { echo "START-$1"; }\nif [[ -z "$TMUX" ]] && true; then\n  tmux IF\nfi\n[[ -z "$TMUX" ]] && tmux INLINE\ntrue\n';
    const guarded = guardText(source);
    assert.equal(guarded.changes.length, 2);
    const run = (env: Record<string, string>) => execFileSync(shell, ['-c', guarded.text], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    assert.equal(run({}), 'START-IF\nSTART-INLINE\n');
    assert.equal(run({ TARMAC_SESSION_ID: 'session' }), '');
    assert.equal(run({ TMUX: '/tmp/tmux,1,0' }), '');
  });
}

test('plan and apply edit through symlinks, keep mode, back up, and refuse stale plans', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tarmac-rc-'));
  try {
    const dotfiles = path.join(home, 'dotfiles');
    await mkdir(dotfiles);
    const real = path.join(dotfiles, 'zshrc');
    await writeFile(real, USER_SNIPPET);
    await chmod(real, 0o640);
    await symlink(real, path.join(home, '.zshrc'));
    await writeFile(path.join(home, '.zprofile'), 'export EDITOR=vim\n');

    const plan = await planShellRc('/usr/bin/zsh', 'install', home, {});
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].symlink, true);
    assert.equal(plan.files[0].target, real);

    const backups = path.join(home, 'backups');
    const applied = await applyShellRc(plan, backups);
    assert.deepEqual(applied.changed, [path.join(home, '.zshrc')]);
    assert.ok((await lstat(path.join(home, '.zshrc'))).isSymbolicLink(), 'symlink kept');
    assert.equal((await stat(real)).mode & 0o777, 0o640);
    assert.match(await readFile(real, 'utf8'), /TARMAC_SESSION_ID/);
    assert.equal(await readFile(applied.backups[0], 'utf8'), USER_SNIPPET);
    await assert.rejects(applyShellRc(plan, backups), /changed since plan/);

    const undo = await planShellRc('/usr/bin/zsh', 'uninstall', home, {});
    await applyShellRc(undo, backups);
    assert.equal(await readFile(real, 'utf8'), USER_SNIPPET);
    assert.equal((await readdir(backups)).length, 2);
    assert.deepEqual((await planShellRc('/usr/bin/zsh', 'uninstall', home, {})).files, []);
    assert.equal((await planShellRc('/usr/bin/fish', 'install', home, {})).unsupported !== undefined, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
