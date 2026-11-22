// Install or remove the per-user Linux desktop entry for Tarmac.
// GNOME Shell 46 shows a generic dock icon for windows it cannot match to a desktop entry,
// even when the window carries _NET_WM_ICON, so the entry claims WM_CLASS "tarmac".
// Default: the entry runs the dev build in this repository (dist/app).
// --package: copies the `pnpm package:local` output to ~/.local/opt/tarmac and runs that copy, so
// the App and its hook CLI keep working while the repository is rebuilt or moved.
// Usage: node scripts/desktop-entry.mjs install [--package] | uninstall
// Windows: only --package is supported; it copies the win32 package to %LOCALAPPDATA%\Programs\Tarmac
// and adds a Start menu shortcut.
import { cp, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { packagedCli } from '../packages/cli/src/hook-command.ts';

const root = path.resolve(import.meta.dirname, '..');
const share = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'));
const entry = path.join(share, 'applications/tarmac.desktop');
const icon = path.join(share, 'icons/tarmac.svg');
const installed = path.join(os.homedir(), '.local/opt/tarmac');
const action = process.argv[2];
const packaged = process.argv.includes('--package');

async function windows() {
  if (!packaged) throw new Error('on Windows only the packaged App can be installed: pnpm desktop:entry install --package');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const target = path.join(local, 'Programs', 'Tarmac');
  const shortcut = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Tarmac.lnk');
  if (action === 'install') {
    const source = path.join(root, `dist/package/Tarmac-win32-${process.arch}`);
    if (!(await stat(source).catch(() => null))?.isDirectory()) throw new Error(`${source} is missing; run pnpm package:local first`);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
    // Paths go through the environment, so no PowerShell quoting is involved.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:TARMAC_LNK); $s.TargetPath = $env:TARMAC_EXE; $s.WorkingDirectory = $env:TARMAC_DIR; $s.Save()'],
    { env: { ...process.env, TARMAC_LNK: shortcut, TARMAC_EXE: path.join(target, 'Tarmac.exe'), TARMAC_DIR: target }, stdio: 'inherit', windowsHide: true });
    // Agents run hooks through Git Bash, PowerShell or cmd; a real executable works in all three.
    const cli = packagedCli({ platform: 'win32', execPath: path.join(target, 'Tarmac.exe'), resourcesPath: path.join(target, 'resources') });
    console.log(`installed ${target}\ninstalled ${shortcut}\nhook command prefix: ${cli}`);
  } else if (action === 'uninstall') {
    await rm(shortcut, { force: true });
    await rm(target, { recursive: true, force: true });
    console.log(`removed ${shortcut}\nremoved ${target}`);
  } else throw new Error('usage: node scripts/desktop-entry.mjs install --package | uninstall --package');
}

if (process.platform === 'win32') await windows();
else if (process.platform !== 'linux') throw new Error('desktop entries are Linux and Windows only');
else if (action === 'install') {
  let exec = `"${path.join(root, 'node_modules/electron/dist/electron')}" --no-sandbox "${path.join(root, 'dist/app')}"`;
  if (packaged) {
    const source = path.join(root, `dist/package/Tarmac-${process.platform}-${process.arch}`);
    if (!(await stat(source).catch(() => null))?.isDirectory()) throw new Error(`${source} is missing; run pnpm package:local first`);
    await rm(installed, { recursive: true, force: true });
    await mkdir(path.dirname(installed), { recursive: true });
    await cp(source, installed, { recursive: true, verbatimSymlinks: true });
    exec = `"${path.join(installed, 'Tarmac')}" --no-sandbox`;
  }
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.dirname(icon), { recursive: true });
  await copyFile(path.join(root, 'apps/desktop/assets/tarmac.svg'), icon);
  // --no-sandbox: Electron's chrome-sandbox helper is not setuid root on this machine;
  // the App loads only its own local files. Remove it once the helper is installed properly.
  // LP_NUM_THREADS: without a hardware GPU (e.g. xrdp) Mesa's llvmpipe otherwise starts up
  // to 32 raster threads and terminal output can occupy ~10 cores. Hardware drivers ignore
  // it. It must be in the environment before Electron starts; setting it in main.ts is too late.
  await writeFile(entry, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Tarmac',
    'Comment=AI coding agent sessions in native terminals',
    `Exec=env LP_NUM_THREADS=2 ${exec}`,
    `Icon=${icon}`,
    'StartupWMClass=tarmac',
    'Terminal=false',
    'Categories=Development;',
    '',
  ].join('\n'), { mode: 0o644 });
  console.log(`installed ${entry}\ninstalled ${icon}`);
  if (packaged) {
    // The hook CLI runs on the bundled Electron in Node mode; no system Node is required.
    const cli = packagedCli({ platform: 'linux', execPath: path.join(installed, 'Tarmac'), resourcesPath: path.join(installed, 'resources') });
    console.log(`installed ${installed}\nhook command prefix: ${cli}`);
  }
} else if (action === 'uninstall') {
  await rm(entry, { force: true });
  await rm(icon, { force: true });
  console.log(`removed ${entry}\nremoved ${icon}`);
  if (packaged) {
    await rm(installed, { recursive: true, force: true });
    console.log(`removed ${installed}`);
  }
} else throw new Error('usage: node scripts/desktop-entry.mjs install [--package] | uninstall [--package]');
