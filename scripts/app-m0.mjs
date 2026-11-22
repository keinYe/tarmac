import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, readdir, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const task = process.argv[2];
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}
async function bundle() {
  await mkdir(path.join(dist, 'app'), { recursive: true });
  const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'info' };
  for (const [entry, output] of [
    ['packages/daemon/src/main.ts', 'daemon.cjs'],
    ['packages/cli/src/main.ts', 'cli.cjs'],
    ['apps/desktop/src/main.ts', 'app/main.cjs'],
    ['apps/desktop/src/preload.ts', 'app/preload.cjs'],
  // ssh2's native helpers are optional and not built (pnpm-workspace.yaml); its requires of them are
  // guarded, so they stay unresolved and ssh2 uses its pure JS path.
  ]) await build({ ...common, entryPoints: [path.join(root, entry)], outfile: path.join(dist, output),
    external: ['electron', 'node-pty', 'cpu-features', '*.node'] });
  await build({ entryPoints: [path.join(root, 'apps/desktop/src/renderer.tsx')], bundle: true,
    platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic', loader: { '.svg': 'dataurl', '.ttf': 'file' },
    assetNames: 'fonts/[name]-[hash]', outfile: path.join(dist, 'app/renderer.js'), logLevel: 'info' });
  await cp(path.join(root, 'apps/desktop/index.html'), path.join(dist, 'app/index.html'));
  // Both font licences require their text to travel with every copy of the fonts.
  for (const name of ['ubuntu-font-licence.txt', 'misans-license.pdf']) {
    await cp(path.join(root, 'apps/desktop/assets/fonts', name), path.join(dist, 'app/fonts', name));
  }
  // Window icon (Linux/Windows need a bitmap), 128 px so _NET_WM_ICON fits X servers without
  // BIG-REQUESTS; rendered from assets/tarmac.svg by scripts/render-icon.py.
  await cp(path.join(root, 'apps/desktop/assets/tarmac.png'), path.join(dist, 'app/tarmac.png'));
  // Launched as a directory, Electron derives WM_CLASS "tarmac" from productName; launched as a
  // bare script it is "electron", which no desktop entry can claim (scripts/desktop-entry.mjs).
  const app = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(dist, 'app/package.json'), JSON.stringify({ name: app.name, productName: app.productName,
    version: app.version, main: 'main.cjs', private: true }) + '\n');
}
async function testsIn(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') files.push(...await testsIn(target));
    else if (entry.name.endsWith('.test.ts')) files.push(target);
  }
  return files.sort();
}
// `package --platform win32 [--arch x64]` cross-packages from Linux or macOS: node-pty ships
// Node-API prebuilds for Windows, and the process helper is plain Go (no cgo).
async function packageLocal() {
  const platform = option('--platform') ?? process.platform;
  const arch = option('--arch') ?? process.arch;
  if (platform === 'win32' && arch !== 'x64') throw new Error('Windows packages currently target x64 only');
  await bundle();
  const stage = path.join(root, '.tmp/app-m0-validation/package-stage');
  // Start clean and copy only the runtime outputs: dist/ also holds earlier packages, which
  // would otherwise be nested into every new package.
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'dist'), { recursive: true });
  for (const name of ['app', 'daemon.cjs', 'cli.cjs']) await cp(path.join(dist, name), path.join(stage, 'dist', name), { recursive: true });
  const source = await realpath(path.join(root, 'node_modules/node-pty'));
  // A host build in build/ cannot load on another platform; the target uses its prebuild.
  const foreign = platform !== process.platform || arch !== process.arch;
  await cp(source, path.join(stage, 'node_modules/node-pty'), { recursive: true, dereference: true,
    filter: file => !foreign || path.relative(source, file).split(path.sep)[0] !== 'build' });
  if (platform === 'win32') {
    await run(process.env.TARMAC_GO || 'go', ['build', '-trimpath', '-ldflags=-s -w',
      '-o', path.join(stage, 'dist/native/tarmac-native.exe'), './cmd/tarmac-native'],
    { env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' } });
  }
  // node-pty 1.1 uses Node-API. Its runtime only requires builtins plus its own native addon.
  const app = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: app.name, productName: app.productName, version: app.version, main: 'dist/app/main.cjs', private: true }));
  const { packager } = await import('@electron/packager');
  const { version } = JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8'));
  const outputs = await packager({ dir: stage, out: path.join(dist, 'package'), name: 'Tarmac',
    electronVersion: version, platform, arch,
    // Windows shows the exe's own icon resource in Explorer, the taskbar and Task Manager.
    ...(platform === 'win32' ? { icon: path.join(root, 'apps/desktop/assets/tarmac.ico') } : {}),
    // Offline packaging: a directory holding electron-v<version>-<platform>-<arch>.zip skips the
    // download, including the SHASUMS256.txt fetch it otherwise makes even when the zip is cached.
    ...(process.env.TARMAC_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.TARMAC_ELECTRON_ZIP_DIR } : {}),
    asar: false, prune: false, overwrite: true });
  console.log(outputs.join('\n'));
}

try {
  if (task === 'test') {
    const files = [...await testsIn(path.join(root, 'packages')), ...await testsIn(path.join(root, 'apps'))];
    if (!files.length) throw new Error('no tests found');
    const report = path.join(root, '.tmp/app-m0-validation/tests.tap');
    await mkdir(path.dirname(report), { recursive: true });
    try {
      await run(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1',
        '--test-reporter=tap', `--test-reporter-destination=${report}`, ...files]);
    } finally {
      const lines = (await readFile(report, 'utf8')).split('\n');
      console.log(lines.filter(line => /^(?:not ok |# (?:tests |pass |fail |cancelled |skipped |duration_ms ))/.test(line)).join('\n'));
      console.log(`Full test report: ${report}`);
    }
  } else if (task === 'build') await bundle();
  else if (task === 'package') await packageLocal();
  else if (task === 'desktop' || task === 'smoke') {
    await bundle();
    const { default: electron } = await import('electron');
    await run(electron, [path.join(dist, 'app')], {
      env: { ...process.env, ...(task === 'smoke' ? { TARMAC_SMOKE: '1', TARMAC_DATA_DIR: path.join(root, '.tmp/app-m0-validation/desktop-smoke') } : {}) },
    });
  } else throw new Error('usage: node scripts/app-m0.mjs test|build|desktop|smoke|package');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
