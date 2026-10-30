import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { runMetrics, runs } from '../db/schema.js';
import { createRedis, keys, redis } from '../lib/redis.js';
import os from 'node:os';
import { cgroupInfo, ProcSampler } from '../lib/sysinfo.js';
import type { RunnerConfig } from '../lib/compiler.js';
import { Aggregator, round, type Bucket, type WindowStats } from './aggregator.js';

export interface RunRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  config: RunnerConfig;
}

export interface ActiveRun {
  id: string;
  name: string;
  startedAt: number;
  sampler: ProcSampler | null;
  stop: (mode: 'stop' | 'kill', reason?: string) => void;
}

export let active: ActiveRun | null = null;

async function insertBuckets(runId: string, buckets: Bucket[]) {
  for (let i = 0; i < buckets.length; i += 500) {
    const rows = buckets.slice(i, i + 500).map((b) => ({
      runId,
      t: b.t,
      ts: new Date(b.ts),
      vus: b.vus,
      rps: b.rps,
      iters: b.iters,
      errRate: b.err_rate,
      avg: b.avg,
      p50: b.p50,
      p90: b.p90,
      p95: b.p95,
      p99: b.p99,
      max: b.max,
      bytesIn: b.bytes_in,
      bytesOut: b.bytes_out,
      dropped: b.dropped,
      checksFail: b.checks_fail,
      genCpu: b.gen_cpu,
    }));
    await db.insert(runMetrics).values(rows).onConflictDoNothing();
  }
}

function publish(runId: string, type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  redis.publish(keys.live(runId), msg).catch(() => {});
  if (type === 'metric') {
    redis.multi().rpush(keys.latest(runId), msg).ltrim(keys.latest(runId), -180, -1).expire(keys.latest(runId), 3600).exec().catch(() => {});
  }
}

/** Releases a FIFO reader still waiting on exit (if k6 never opened the file). */
function unblockFifo(fifo: string) {
  try {
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.closeSync(fd);
  } catch {
    /* no reader or already closed */
  }
}

export async function executeRun(run: RunRow, workerId: string): Promise<void> {
  const cfg = run.config;
  const dir = path.join(config.workDir, run.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  const summaryPath = path.join(dir, 'summary.json');
  const fifo = path.join(dir, 'metrics.fifo');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  execFileSync('mkfifo', [fifo]);

  const pending: Bucket[] = [];
  const agg = new Aggregator((b) => {
    pending.push(b);
    publish(run.id, 'metric', b);
  });

  const logs: string[] = [];
  const debug: unknown[] = [];
  const pushLog = (s: string) => {
    logs.push(s.length > 2000 ? s.slice(0, 2000) + '…' : s);
    if (logs.length > 300) logs.shift();
  };

  // --- metrics stream (FIFO) ---
  const reader = fs.createReadStream(fifo, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let carry = '';
  const readerDone = new Promise<void>((resolve) => {
    reader.on('data', (chunk) => {
      const text = carry + (chunk as string);
      let start = 0;
      let nl: number;
      while ((nl = text.indexOf('\n', start)) !== -1) {
        agg.line(text.slice(start, nl));
        start = nl + 1;
      }
      carry = text.slice(start);
    });
    reader.on('end', () => {
      if (carry) agg.line(carry);
      resolve();
    });
    reader.on('error', (err) => {
      pushLog(`[metrics] ${err.message}`);
      resolve();
    });
  });

  const args = [
    'run',
    '--quiet',
    '--no-color',
    '--log-format=json',
    '--address=localhost:0',
    '--system-tags=status,method,name,check,error_code,expected_response,scenario',
    `--out=json=${fifo}`,
    '-e', `RUNNER_CONFIG=${cfgPath}`,
    '-e', `SUMMARY_PATH=${summaryPath}`,
    config.runnerPath,
  ];

  const startedAt = Date.now();
  const child: ChildProcess = spawn(config.k6Bin, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, K6_NO_USAGE_REPORT: 'true' } });
  const sampler = child.pid ? new ProcSampler(child.pid) : null;

  let stopReason: string | null = null;
  let stopMode: 'user' | 'autostop' | 'timeout' | 'shutdown' | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const stop = (mode: 'stop' | 'kill', reason?: string, by: typeof stopMode = 'user') => {
    if (child.exitCode !== null) return;
    if (!stopMode) {
      stopMode = by;
      stopReason = reason ?? (by === 'user' ? 'Stopped by user' : null);
      db.update(runs)
        .set({ status: 'stopping', stopReason })
        .where(and(eq(runs.id, run.id), inArray(runs.status, ['starting', 'running'])))
        .catch(() => {});
      publish(run.id, 'status', { status: 'stopping', stopReason });
    }
    if (mode === 'kill') {
      child.kill('SIGKILL');
      return;
    }
    child.kill('SIGINT');
    if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  };

  active = { id: run.id, name: run.name, startedAt, sampler, stop: (m, r) => stop(m, r, 'user') };

  // stdout: nearly empty with --quiet; log it anyway
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => d.split('\n').filter(Boolean).forEach((l) => pushLog(l)));

  // stderr: JSON log lines; debug traces are separated out
  let errCarry = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => {
    const text = errCarry + d;
    const lines = text.split('\n');
    errCarry = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const j = JSON.parse(l);
        const msg = String(j.msg ?? '');
        if (msg.startsWith('__LLDBG__')) {
          if (debug.length < 500) {
            const entry = JSON.parse(msg.slice(9));
            debug.push(entry);
            publish(run.id, 'debug', entry);
          }
          continue;
        }
        const line = `[${j.level ?? 'info'}] ${msg}${j.error ? ` — ${j.error}` : ''}`;
        pushLog(line);
        if (j.level === 'error' || j.level === 'warning') publish(run.id, 'log', line);
      } catch {
        pushLog(l);
      }
    }
  });

  // control channel (stop / force stop)
  const ctl = createRedis();
  ctl.on('message', (_ch: string, msg: string) => {
    if (msg === 'stop') stop('stop');
    if (msg === 'kill') stop('kill');
  });
  await ctl.subscribe(keys.control(run.id));

  await db
    .update(runs)
    .set({ status: 'running', startedAt: new Date(), workerId })
    .where(and(eq(runs.id, run.id), eq(runs.status, 'starting')));
  publish(run.id, 'status', { status: 'running' });

  // a stop may have been requested before starting
  const [pre] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, run.id));
  if (pre?.status === 'stopping') stop('stop');

  // --- auto-stop / capacity ---
  const as = cfg.meta.autoStop;
  let bestHealthy: (WindowStats & { t: number }) | null = null;
  let breach: (WindowStats & { t: number; reason: string }) | null = null;

  const hardLimitMs = (cfg.meta.estDurationSec + 600) * 1000;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const s = sampler?.sample();
    if (s) agg.genCpu = round(s.cpu, 1);
    agg.flush();

    if (as.enabled && !stopMode) {
      const w = agg.window(as.windowSec);
      if (w && agg.emitted.length >= as.graceSec + as.windowSec) {
        const t = agg.emitted[agg.emitted.length - 1].t;
        const p95Bad = as.p95Ms !== undefined && w.p95 !== null && w.p95 > as.p95Ms;
        const errBad = as.errorRate !== undefined && w.errRate > as.errorRate;
        if (p95Bad || errBad) {
          const ms = (v: number) => (v < 10 ? v.toFixed(2) : String(Math.round(v)));
          const reason = p95Bad
            ? `p95 ${ms(w.p95!)} ms > ${as.p95Ms} ms (last ${as.windowSec}s)`
            : `error rate ${(w.errRate * 100).toFixed(2)}% > ${(as.errorRate! * 100).toFixed(2)}% (last ${as.windowSec}s)`;
          breach = { ...w, t, reason };
          publish(run.id, 'breach', breach);
          stop('stop', `Threshold exceeded: ${reason}`, 'autostop');
        } else if (w.rps > 0 && (!bestHealthy || w.rps > bestHealthy.rps)) {
          bestHealthy = { ...w, t };
        }
      }
    }

    if (tick % 2 === 0) {
      const steps = agg.stepsSnapshot();
      publish(run.id, 'steps', steps);
      redis.set(keys.steps(run.id), JSON.stringify(steps), 'EX', 3600).catch(() => {});
    }
    if (tick % 5 === 0 && pending.length) {
      insertBuckets(run.id, pending.splice(0)).catch((e) => pushLog(`[db] ${e.message}`));
    }
    if (Date.now() - startedAt > hardLimitMs && !stopMode) stop('stop', 'Maximum duration exceeded', 'timeout');
  }, 1000);

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('error', (err) => {
      pushLog(`[spawn] ${err.message}`);
      resolve(-1);
    });
    child.on('exit', (code, signal) => {
      if (signal) pushLog(`[k6] terminated by signal: ${signal}`);
      resolve(code);
    });
  });
  clearInterval(timer);
  if (killTimer) clearTimeout(killTimer);
  unblockFifo(fifo);
  await Promise.race([readerDone, new Promise((r) => setTimeout(r, 5000))]);
  reader.destroy();
  await ctl.quit().catch(() => {});

  agg.flush(true);
  await insertBuckets(run.id, pending.splice(0)).catch((e) => pushLog(`[db] ${e.message}`));

  // --- summary ---
  let k6Summary: any = null;
  try {
    k6Summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    /* missing if force-stopped */
  }

  const durationSec = agg.emitted.length || Math.round((Date.now() - startedAt) / 1000);
  const summary: any = agg.summary(durationSec);

  const thresholds: { metric: string; expr: string; ok: boolean }[] = [];
  if (k6Summary?.metrics) {
    for (const [metric, m] of Object.entries<any>(k6Summary.metrics)) {
      for (const [expr, r] of Object.entries<any>(m.thresholds ?? {})) thresholds.push({ metric, expr, ok: !!r.ok });
    }
    const it = k6Summary.metrics.iteration_duration?.values;
    if (it) summary.iterationDuration = { avg: round(it.avg), p95: round(it['p(95)']) };
  }
  summary.thresholds = thresholds;

  const warnings: string[] = [];
  if (summary.droppedIterations > 0) {
    warnings.push(`${summary.droppedIterations} iterations could not start (dropped). The VU pool was too small for the target rate, or the system slowed down; increase maxVUs.`);
  }
  const cores = cgroupInfo()?.cpuLimitCores ?? os.cpus().length;
  if (sampler && sampler.maxCpu > 85 * cores) {
    warnings.push(`Load generator (k6) CPU reached ${Math.round(sampler.maxCpu)}% (${cores} cores). Results may be limited by the load generator; give the worker more CPU.`);
  }
  summary.warnings = warnings;
  summary.generator = sampler
    ? { maxCpuPct: round(sampler.maxCpu, 1), avgCpuPct: round(sampler.samples ? sampler.sumCpu / sampler.samples : 0, 1), maxRssBytes: sampler.maxRss }
    : null;
  if (cfg.debug) summary.debug = debug;

  let capacity: any = null;
  if (as.enabled) {
    const bh = bestHealthy as (WindowStats & { t: number }) | null;
    const br = breach as (WindowStats & { t: number; reason: string }) | null;
    capacity = {
      limits: { p95Ms: as.p95Ms ?? null, errorRate: as.errorRate ?? null, windowSec: as.windowSec },
      breached: !!br,
      reason: br?.reason ?? null,
      maxHealthy: bh ? { t: bh.t, rps: round(bh.rps, 1), iterRate: round(bh.iterRate, 2), vus: bh.vus, p95: round(bh.p95), errRate: round(bh.errRate, 4) } : null,
      breachAt: br ? { t: br.t, rps: round(br.rps, 1), iterRate: round(br.iterRate, 2), vus: br.vus, p95: round(br.p95), errRate: round(br.errRate, 4) } : null,
    };
  }

  let status: 'completed' | 'stopped' | 'failed';
  let error: string | null = null;
  if (stopMode === 'user' || stopMode === 'shutdown') status = 'stopped';
  else if (stopMode === 'autostop' || stopMode === 'timeout') status = 'completed';
  else if (exitCode === 0 || exitCode === 99) status = 'completed';
  else {
    status = 'failed';
    error = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[spawn]')).slice(-5).join('\n') || `k6 exit code: ${exitCode}`;
  }
  const thresholdsPassed = thresholds.length ? thresholds.every((t) => t.ok) : null;

  await db
    .update(runs)
    .set({
      status,
      finishedAt: new Date(),
      summary,
      capacity,
      thresholdsPassed,
      // keep the existing value if there's no stop reason (undefined fields aren't updated)
      stopReason: stopReason ?? undefined,
      error,
      logs: logs.join('\n'),
    })
    .where(eq(runs.id, run.id));
  publish(run.id, 'status', { status, done: true });
  active = null;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[worker] ${run.id} finished: ${status} (k6 exit=${exitCode}, requests=${summary.requests})`);
}
