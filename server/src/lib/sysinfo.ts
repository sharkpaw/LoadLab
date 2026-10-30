import fs from 'node:fs';
import os from 'node:os';
import { redis, keys } from './redis.js';
import type { Role } from './config.js';

function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/** cgroup v2 (container) limits and usage; null if unavailable. */
export function cgroupInfo() {
  const memCur = readFile('/sys/fs/cgroup/memory.current');
  if (memCur === null) return null;
  const memMax = readFile('/sys/fs/cgroup/memory.max');
  const cpuMax = readFile('/sys/fs/cgroup/cpu.max');
  const cpuStat = readFile('/sys/fs/cgroup/cpu.stat');
  let cpuLimit: number | null = null;
  if (cpuMax) {
    const [q, p] = cpuMax.split(' ');
    if (q !== 'max') cpuLimit = Number(q) / Number(p);
  }
  const usageUsec = cpuStat ? Number(/usage_usec (\d+)/.exec(cpuStat)?.[1] ?? 0) : 0;
  return {
    memoryBytes: Number(memCur),
    memoryLimitBytes: memMax && memMax !== 'max' ? Number(memMax) : null,
    cpuLimitCores: cpuLimit,
    cpuUsageUsec: usageUsec,
  };
}

/** Reads a process's CPU ticks and RSS on Linux. */
export function procStat(pid: number): { cpuTicks: number; rssBytes: number } | null {
  const stat = readFile(`/proc/${pid}/stat`);
  if (!stat) return null;
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // after[0]=state (field 3) → utime=field 14 => index 11, stime => 12, rss => 21
  const utime = Number(after[11]);
  const stime = Number(after[12]);
  const rssPages = Number(after[21]);
  return { cpuTicks: utime + stime, rssBytes: rssPages * 4096 };
}

const CLK_TCK = 100;

/** Periodic CPU% sampler for a PID. */
export class ProcSampler {
  private last: { ticks: number; at: number } | null = null;
  maxCpu = 0;
  maxRss = 0;
  samples = 0;
  sumCpu = 0;

  constructor(private pid: number) {}

  sample(): { cpu: number; rss: number } | null {
    const s = procStat(this.pid);
    if (!s) return null;
    const now = Date.now();
    let cpu = 0;
    if (this.last) {
      const dt = (now - this.last.at) / 1000;
      if (dt > 0) cpu = ((s.cpuTicks - this.last.ticks) / CLK_TCK / dt) * 100;
    }
    this.last = { ticks: s.cpuTicks, at: now };
    if (cpu > this.maxCpu) this.maxCpu = cpu;
    if (s.rssBytes > this.maxRss) this.maxRss = s.rssBytes;
    this.samples++;
    this.sumCpu += cpu;
    return { cpu, rss: s.rssBytes };
  }
}

let lastCg: { usec: number; at: number } | null = null;
let lastProc: { usage: NodeJS.CpuUsage; at: number } | null = null;

export function nodeStats(role: Role, id: string, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  const cg = cgroupInfo();
  let containerCpuPct: number | null = null;
  if (cg) {
    if (lastCg) containerCpuPct = ((cg.cpuUsageUsec - lastCg.usec) / 1000 / (now - lastCg.at)) * 100;
    lastCg = { usec: cg.cpuUsageUsec, at: now };
  }
  const usage = process.cpuUsage();
  let processCpuPct: number | null = null;
  if (lastProc) {
    const d = (usage.user - lastProc.usage.user + usage.system - lastProc.usage.system) / 1000;
    processCpuPct = (d / (now - lastProc.at)) * 100;
  }
  lastProc = { usage, at: now };
  const mem = process.memoryUsage();
  return {
    id,
    role,
    hostname: os.hostname(),
    at: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    hostMemTotal: os.totalmem(),
    hostMemFree: os.freemem(),
    processCpuPct,
    processRss: mem.rss,
    heapUsed: mem.heapUsed,
    container: cg ? { cpuPct: containerCpuPct, cpuLimitCores: cg.cpuLimitCores, memoryBytes: cg.memoryBytes, memoryLimitBytes: cg.memoryLimitBytes } : null,
    ...extra,
  };
}

/** Writes node stats to Redis every 5s (for the system page). */
export function startReporter(role: Role, id: string, extra: () => Record<string, unknown> = () => ({})) {
  const tick = async () => {
    try {
      const s = nodeStats(role, id, extra());
      await redis.hset(keys.nodes, id, JSON.stringify(s));
    } catch (err) {
      console.error('[reporter]', (err as Error).message);
    }
  };
  nodeStats(role, id); // initialize the CPU baseline
  const h = setInterval(tick, 5000);
  h.unref();
  setTimeout(tick, 1000).unref();
  return () => {
    clearInterval(h);
    redis.hdel(keys.nodes, id).catch(() => {});
  };
}
