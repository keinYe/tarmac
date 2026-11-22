import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Kimi's data directory as the agent itself resolves it from its launch environment.
export function kimiHome(env: Record<string, string | undefined>, home: string, cwd: string): string {
  return path.resolve(cwd, env.KIMI_CODE_HOME || path.join(home, '.kimi-code'));
}

// Native hook session_id is authoritative; neither cwd nor mtime selects a run.
export async function kimiTranscript(sessionId: string, env: Record<string, string | undefined>, home: string,
  cwd: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) return;
  const root = path.join(kimiHome(env, home, cwd), 'sessions');
  try {
    const dirs = await readdir(root, { withFileTypes: true });
    if (dirs.length > 1000) return;
    const found = (await Promise.all(dirs.filter(dir => dir.isDirectory()).map(async dir => {
      const file = path.join(root, dir.name, sessionId, 'agents/main/wire.jsonl');
      return (await stat(file).catch(() => undefined))?.isFile() ? file : undefined;
    }))).filter((file): file is string => Boolean(file));
    return found.length === 1 ? found[0] : undefined;
  } catch { return; }
}
