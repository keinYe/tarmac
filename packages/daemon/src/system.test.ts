import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Daemon } from './server.ts';
import { Client } from '../../protocol/src/client.ts';
import type { SystemSample } from '../../protocol/src/index.ts';
import { parseNetstat, parseProcNetDev, parseVmStat, physical } from './system.ts';

test('/proc/net/dev sums physical interfaces only', () => {
  const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000 10 0 0 0 0 0 0 9000 10 0 0 0 0 0 0
  eth0: 1000 5 0 0 0 0 0 0 200 3 0 0 0 0 0 0
wlp2s0: 500 5 0 0 0 0 0 0 50 3 0 0 0 0 0 0
docker0: 7000 5 0 0 0 0 0 0 7000 3 0 0 0 0 0 0
vethab12: 7000 5 0 0 0 0 0 0 7000 3 0 0 0 0 0 0
tailscale0: 7000 5 0 0 0 0 0 0 7000 3 0 0 0 0 0 0
`;
  assert.deepEqual(parseProcNetDev(text), { rx: 1500, tx: 250 });
  assert.deepEqual(parseProcNetDev(''), { rx: 0, tx: 0 });
});

test('netstat -ibn reads byte columns from the right of each link row', () => {
  const text = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         2222     0     900000     2222     0     900000     0
lo0        16384 127           127.0.0.1          2222     -     900000     2222     -     900000     -
en0        1500  <Link#6>    a4:83:e7:00:00:01  1000     0     300000      900     0     100000     0
en0        1500  192.168.1     192.168.1.5        1000     -     300000      900     -     100000     -
en1        1500  <Link#7>                            10     0       4000       10     0       1000     0
utun3      1380  <Link#20>                          500     0     300000      400     0     100000     0
`;
  assert.deepEqual(parseNetstat(text), { rx: 304000, tx: 101000 });
});

test('vm_stat available memory counts free, inactive and speculative pages', () => {
  const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10.
Pages active:                            999.
Pages inactive:                           20.
Pages speculative:                         5.
Pages wired down:                        999.
`;
  assert.equal(parseVmStat(text), 35 * 16384);
  assert.equal(parseVmStat('garbage'), undefined);
});

test('virtual interface names are excluded', () => {
  for (const name of ['lo', 'lo0', 'veth1', 'docker0', 'br-1a2b', 'virbr0', 'tun0', 'utun2', 'wg0', 'awdl0', 'bridge0']) assert.equal(physical(name), false, name);
  for (const name of ['eth0', 'enp3s0', 'wlp2s0', 'wlan0', 'en0', 'en1']) assert.equal(physical(name), true, name);
});

test('the daemon answers system with counters of its machine', async () => {
  const base = path.resolve(import.meta.dirname, '../../../.tmp/app-m0-validation');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'd-'));
  const daemon = new Daemon(dir);
  await daemon.start();
  const client = await Client.connect(daemon.socketPath);
  try {
    const sample = await client.request<SystemSample>({ type: 'system' });
    assert.equal(sample.utcOffset, -new Date(sample.at).getTimezoneOffset());
    assert.ok(sample.cores > 0 && sample.cpuTotal >= sample.cpuIdle && sample.cpuIdle >= 0);
    assert.ok(sample.memTotal > 0 && sample.memAvailable > 0 && sample.memAvailable <= sample.memTotal);
    if (process.platform === 'win32') assert.equal(sample.net, null);
    else assert.ok(sample.net && sample.net.rx >= 0 && sample.net.tx >= 0);
  } finally {
    client.close();
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
