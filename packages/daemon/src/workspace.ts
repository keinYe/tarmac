import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

// Read-only directory facts for the App sidebar: whether a project directory still exists and
// its git branch. The App asks the daemon (`workspace` request) when the directory is on
// another machine; for its own machine it calls these directly (apps/desktop/src/projects.ts).

export const WORKSPACE_PATHS = 64;

export async function isDirectory(dir: string): Promise<boolean> {
  try { return (await stat(dir)).isDirectory(); } catch { return false; }
}

async function locateHead(start: string): Promise<string | undefined> {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const git = path.join(dir, '.git');
    try {
      const info = await stat(git);
      if (info.isDirectory()) return path.join(git, 'HEAD');
      // Worktrees and submodules use a `.git` file pointing at the real git dir.
      const line = (await readFile(git, 'utf8')).trim();
      if (line.startsWith('gitdir:')) {
        const target = line.slice(7).trim();
        return path.join(path.isAbsolute(target) ? target : path.join(dir, target), 'HEAD');
      }
    } catch { /* keep walking up */ }
    if (path.dirname(dir) === dir) return undefined;
  }
}

// Same rules as the TUI: branch name, or HEAD:<short sha> when detached.
export async function readGitBranch(dir: string): Promise<string> {
  const head = await locateHead(dir);
  if (!head) return '';
  try {
    const content = (await readFile(head, 'utf8')).trim();
    if (content.startsWith('ref: refs/heads/')) return content.slice('ref: refs/heads/'.length);
    return content.length >= 7 ? 'HEAD:' + content.slice(0, 7) : '';
  } catch { return ''; }
}

export interface DirectoryFacts { path: string; exists: boolean; branch: string }

export async function inspectDirectories(paths: unknown): Promise<DirectoryFacts[]> {
  if (!Array.isArray(paths) || paths.length > WORKSPACE_PATHS
    || !paths.every(dir => typeof dir === 'string' && dir.length <= 4096 && !dir.includes('\0') && path.isAbsolute(dir))) {
    throw new Error('invalid workspace request');
  }
  return Promise.all((paths as string[]).map(async dir => {
    const exists = await isDirectory(dir);
    return { path: dir, exists, branch: exists ? await readGitBranch(dir) : '' };
  }));
}
