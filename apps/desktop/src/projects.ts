import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { inspectDirectories, readGitBranch, type DirectoryFacts } from '../../../packages/daemon/src/workspace.ts';

const STORED_LIMIT = 50;

export interface WorkspaceView {
  branch: string;
  // Most recently opened first.
  projects: { path: string; exists: boolean }[];
}

// The App's own project history; it never reads the TUI registry.
export class ProjectStore {
  private readonly file: string;
  private cache: string[] | undefined;
  private queue: Promise<void> = Promise.resolve();
  constructor(file: string) { this.file = file; }

  async list(): Promise<string[]> {
    if (!this.cache) {
      let saved: unknown;
      try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`项目历史读取失败：${(error as Error).message}`);
        saved = { recent: [] };
      }
      const recent = (saved as { recent?: unknown }).recent;
      if (!Array.isArray(recent)) throw new Error('项目历史格式无效');
      this.cache = recent.filter((dir): dir is string => typeof dir === 'string' && path.isAbsolute(dir));
    }
    return [...this.cache];
  }

  async touch(dir: string): Promise<void> {
    await this.update(list => list[0] === dir ? undefined : [dir, ...list.filter(item => item !== dir)].slice(0, STORED_LIMIT));
  }

  // Empties the history except the directories still open: they are not listed as history while
  // open, and return to it when their sessions end.
  async clear(keep: string[]): Promise<void> {
    await this.update(list => list.filter(dir => keep.includes(dir)));
  }

  // Changes are queued so concurrent touches and clears each see the previous result.
  private async update(change: (list: string[]) => string[] | undefined): Promise<void> {
    const task = this.queue.then(async () => {
      const recent = change(await this.list());
      if (!recent) return;
      const content = JSON.stringify({ v: 1, recent }) + '\n';
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp';
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.file);
      this.cache = recent;
    });
    this.queue = task.catch(() => {});
    await task;
  }
}

export { readGitBranch };

// inspect answers for another machine through its daemon (`workspace` request); by default the
// directories are on this machine.
export async function workspaceView(store: ProjectStore, current?: string,
  inspect: (paths: string[]) => Promise<DirectoryFacts[]> = inspectDirectories): Promise<WorkspaceView> {
  const recent = await store.list();
  const facts = await inspect(current ? [current, ...recent] : recent);
  return {
    branch: current ? facts[0]?.branch ?? '' : '',
    projects: (current ? facts.slice(1) : facts).map(fact => ({ path: fact.path, exists: fact.exists })),
  };
}
