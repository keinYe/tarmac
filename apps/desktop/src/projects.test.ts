import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { ProjectStore, readGitBranch, workspaceView } from './projects.ts';

const root = path.resolve(import.meta.dirname, '../../..');
async function scratch(): Promise<string> {
  const base = path.join(root, '.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'projects-'));
}

test('project history keeps most recent first, dedupes, persists and reports missing directories', async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, 'electron/projects.json');
    const store = new ProjectStore(file);
    assert.deepEqual(await store.list(), []);
    await store.touch(path.join(dir, 'a'));
    await store.touch(path.join(dir, 'b'));
    await store.touch(path.join(dir, 'a'));
    assert.deepEqual(await new ProjectStore(file).list(), [path.join(dir, 'a'), path.join(dir, 'b')]);
    await mkdir(path.join(dir, 'a'));
    const view = await workspaceView(new ProjectStore(file));
    assert.deepEqual(view.projects, [{ path: path.join(dir, 'a'), exists: true }, { path: path.join(dir, 'b'), exists: false }]);
    await writeFile(file, 'not json');
    await assert.rejects(new ProjectStore(file).list(), /项目历史读取失败/);
    assert.equal(await readFile(file, 'utf8'), 'not json', 'a corrupt file is never overwritten by reading');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('clearing project history keeps only the directories still open, and later touches start over', async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, 'projects.json');
    const store = new ProjectStore(file);
    for (const name of ['a', 'b', 'c']) await store.touch(path.join(dir, name));
    await store.clear([path.join(dir, 'b')]);
    assert.deepEqual(await new ProjectStore(file).list(), [path.join(dir, 'b')], 'persisted');
    await store.clear([]);
    assert.deepEqual(await store.list(), []);
    await store.touch(path.join(dir, 'a'));
    assert.deepEqual(await store.list(), [path.join(dir, 'a')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('git branch follows the TUI rules for branches, detached HEAD and worktree files', async () => {
  const dir = await scratch();
  try {
    await mkdir(path.join(dir, 'repo/.git'), { recursive: true });
    await mkdir(path.join(dir, 'repo/sub/deep'), { recursive: true });
    await writeFile(path.join(dir, 'repo/.git/HEAD'), 'ref: refs/heads/feat/x\n');
    assert.equal(await readGitBranch(path.join(dir, 'repo/sub/deep')), 'feat/x');
    await writeFile(path.join(dir, 'repo/.git/HEAD'), '0123456789abcdef\n');
    assert.equal(await readGitBranch(path.join(dir, 'repo')), 'HEAD:0123456');
    await mkdir(path.join(dir, 'gitdirs/wt'), { recursive: true });
    await writeFile(path.join(dir, 'gitdirs/wt/HEAD'), 'ref: refs/heads/wt-branch\n');
    await mkdir(path.join(dir, 'worktree'));
    await writeFile(path.join(dir, 'worktree/.git'), 'gitdir: ../gitdirs/wt\n');
    assert.equal(await readGitBranch(path.join(dir, 'worktree')), 'wt-branch');
    assert.equal(await readGitBranch('/'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent session directories are all preserved in project history', async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, 'projects.json');
    const store = new ProjectStore(file);
    const paths = Array.from({ length: 8 }, (_, index) => path.join(dir, `project-${index}`));
    await Promise.all(paths.map(value => store.touch(value)));
    assert.deepEqual(await store.list(), paths.toReversed());
    assert.deepEqual(await new ProjectStore(file).list(), paths.toReversed());
  } finally { await rm(dir, { recursive: true, force: true }); }
});
