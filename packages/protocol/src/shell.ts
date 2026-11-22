import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ShellCommand { command: string; args: string[] }

// PowerShell writes Unicode to the console, but decodes native programs' piped output with the
// OEM code page unless told otherwise; agents and git print UTF-8.
const POWERSHELL_UTF8 = '[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)';

function onPath(name: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | undefined {
  const value = env.PATH ?? env.Path ?? '';
  for (const directory of value.split(path.win32.delimiter)) {
    if (!directory || !path.win32.isAbsolute(directory)) continue;
    const file = path.win32.join(directory, name);
    if (exists(file)) return file;
  }
}

// The shell and its arguments are chosen together: a Windows shell has no login flag.
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync): ShellCommand {
  if (platform !== 'win32') return { command: env.SHELL || '/bin/sh', args: ['-l'] };
  const system = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const bundled = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const powershell = onPath('pwsh.exe', env, exists) ?? (exists(bundled) ? bundled : onPath('powershell.exe', env, exists));
  if (powershell) return { command: powershell, args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_UTF8] };
  return { command: env.ComSpec ?? env.COMSPEC ?? path.win32.join(system, 'System32', 'cmd.exe'), args: [] };
}
