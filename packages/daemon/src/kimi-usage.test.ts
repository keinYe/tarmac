import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { kimiTranscript } from './kimi-usage.ts';

test('Kimi finds only a unique exact hook ID, never the newest session in the same project', async () => {
  const base = path.resolve('.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, 'kimi-'));
  const env = { KIMI_CODE_HOME: home };
  const wire = (bucket: string, id: string) => path.join(home, 'sessions', bucket, id, 'agents/main/wire.jsonl');
  const add = async (bucket: string, id: string) => { const file = wire(bucket, id); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, ''); return file; };
  try {
    const expected = await add('project', 'exact');
    await add('project', 'newest');
    assert.equal(await kimiTranscript('exact', env, home, home), expected);
    assert.equal(await kimiTranscript('missing', env, home, home), undefined);
    assert.equal(await kimiTranscript('../exact', env, home, home), undefined);
    await add('another-project', 'exact');
    assert.equal(await kimiTranscript('exact', env, home, home), undefined);
  } finally { await rm(home, { recursive: true }); }
});
