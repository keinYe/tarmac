import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SystemSample } from '../../protocol/src/index.ts';

// `system` request: cumulative CPU, memory and network counters of this machine for the App
// title bar. The App asks the daemon of the session's host, so remote hosts report their own.

const run = promisify(execFile);
const TIMEOUT_MS = 1000;

// Loopback, containers, bridges and tunnels carry traffic that a physical interface also counts.
const VIRTUAL = /^(lo|veth|docker|br-|virbr|vnet|vmnet|vmenet|tun|tap|utun|wg|tailscale|zt|cni|flannel|cali|cilium|kube|lxc|lxd|podman|gif|stf|bridge|awdl|llw|anpi|ap\d|ipsec|feth)/;
export const physical = (name: string): boolean => !VIRTUAL.test(name);

type Net = NonNullable<SystemSample['net']>;

// /proc/net/dev: `name: rx_bytes rx_packets ... (8 receive fields) tx_bytes ...`.
export function parseProcNetDev(text: string): Net {
  const net = { rx: 0, tx: 0 };
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!name || !physical(name) || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    net.rx += fields[0];
    net.tx += fields[8];
  }
  return net;
}

// `netstat -ibn` (macOS): one <Link#n> row per interface; the address column may be empty, so the
// byte columns are taken from the right: ... Ibytes Opkts Oerrs Obytes Coll.
export function parseNetstat(text: string): Net {
  const net = { rx: 0, tx: 0 };
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || !fields[2]?.startsWith('<Link#') || !physical(fields[0])) continue;
    const rx = Number(fields[fields.length - 5]);
    const tx = Number(fields[fields.length - 2]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    net.rx += rx;
    net.tx += tx;
  }
  return net;
}

// `vm_stat` (macOS): os.freemem() there counts only free pages, so inactive and speculative pages,
// which the system hands out on demand, are added the way Activity Monitor treats them.
export function parseVmStat(text: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  if (!pageSize) return undefined;
  return (pages('free') + pages('inactive') + pages('speculative')) * pageSize;
}

async function readNet(platform: NodeJS.Platform): Promise<SystemSample['net']> {
  try {
    if (platform === 'linux') return parseProcNetDev(await readFile('/proc/net/dev', 'utf8'));
    if (platform === 'darwin') return parseNetstat((await run('netstat', ['-ibn'], { timeout: TIMEOUT_MS })).stdout);
  } catch { /* reported as not collected */ }
  return null;
}

async function readAvailable(platform: NodeJS.Platform): Promise<number> {
  // Linux: libuv reports MemAvailable; Windows: the available physical memory.
  if (platform !== 'darwin') return os.freemem();
  try { return parseVmStat((await run('vm_stat', [], { timeout: TIMEOUT_MS })).stdout) ?? os.freemem(); }
  catch { return os.freemem(); }
}

export async function sampleSystem(platform: NodeJS.Platform = process.platform): Promise<SystemSample> {
  const cpus = os.cpus();
  let cpuIdle = 0;
  let cpuTotal = 0;
  for (const { times } of cpus) {
    cpuIdle += times.idle;
    cpuTotal += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  const [memAvailable, net] = await Promise.all([readAvailable(platform), readNet(platform)]);
  const now = new Date();
  return { at: now.getTime(), utcOffset: -now.getTimezoneOffset(), cores: cpus.length, cpuIdle, cpuTotal, memTotal: os.totalmem(), memAvailable, net };
}
