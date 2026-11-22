import path from 'node:path';

export interface PackagedApp { platform: NodeJS.Platform; execPath: string; resourcesPath: string }

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// The command prefix that runs the packaged CLI on the App's own Electron in Node mode.
// Windows uses the native launcher, quoted with forward slashes: that form runs unchanged under
// Git Bash and cmd, which agents use for hooks; PowerShell would need a call operator.
export function packagedCli(app: PackagedApp): string {
  if (app.platform === 'win32') {
    return `"${path.win32.join(app.resourcesPath, 'app', 'dist', 'native', 'tarmac-native.exe').replaceAll('\\', '/')}" cli`;
  }
  return `env ELECTRON_RUN_AS_NODE=1 ${shellQuote(app.execPath)} ${shellQuote(path.posix.join(app.resourcesPath, 'app', 'dist', 'cli.cjs'))}`;
}

export const packagedHookCommand = (app: PackagedApp, provider: 'claude' | 'kimi' | 'agy'): string => `${packagedCli(app)} hook ${provider}`;
