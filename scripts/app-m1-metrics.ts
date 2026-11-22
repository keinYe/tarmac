import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export function cpuPercent(ticks: number, elapsedMs: number, clockTicks: number): number {
  if (![ticks, elapsedMs, clockTicks].every(Number.isFinite) || ticks < 0 || elapsedMs <= 0 || clockTicks <= 0) throw new Error('invalid CPU sample');
  return ticks / clockTicks / (elapsedMs / 1000) * 100;
}

function cpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
  return Number(fields[11]) + Number(fields[12]);
}

export async function sampleProcess(pid: number, windowMs = 5000): Promise<{ rssMaxKb: number; rssFinalKb: number; cpuPercent: number }> {
  if (process.platform !== 'linux') throw new Error('resource sampling currently requires Linux /proc');
  const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const pageSize = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
  const samples: number[] = [];
  const startCpu = cpuTicks(pid);
  const start = performance.now();
  for (let i = 0; i < 5; i++) {
    await delay(windowMs / 5);
    const pages = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(/\s+/)[1]);
    samples.push(Math.round(pages * pageSize / 1024));
  }
  return { rssMaxKb: Math.max(...samples), rssFinalKb: samples.at(-1)!,
    cpuPercent: Number(cpuPercent(cpuTicks(pid) - startCpu, performance.now() - start, clockTicks).toFixed(2)) };
}
