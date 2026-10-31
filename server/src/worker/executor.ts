import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../lib/config.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { runMetrics, runs } from '../db/schema.js';
import { createRedis, keys, redis } from '../lib/redis.js';
import { cgroupInfo, ProcSampler } from '../lib/sysinfo.js';
import type { RunnerConfig } from '../lib/compiler.js';
import { Aggregator, round, sliceToWire, Timeline, type AggState, type Bucket, type Slice, type StepState, type WindowStats } from './aggregator.js';

export interface RunRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  config: RunnerConfig;
  /** Workers the run is split across; shard 0 is the lead worker */
  shards: number;
}

export interface ActiveRun {
  id: string;
  name: string;
  shard: number;
  startedAt: number;
  sampler: ProcSampler | null;
  stop: (mode: 'stop' | 'kill', reason?: string) => void;
}

export let active: ActiveRun | null = null;

/** What one worker reports about its own k6 process. Helpers send it to the lead worker. */
interface ShardResult {
  shard: number;
  workerId: string;
  exitCode: number | null;
  failed: boolean;
  error: string | null;
  requests: number;
  thresholds: { metric: string; expr: string; ok: boolean }[];
  iteration: { avg: number; p95: number; count: number } | null;
  generator: { maxCpuPct: number | null; avgCpuPct: number | null; maxRssBytes: number } | null;
  warnings: string[];
  logs: string[];
  state?: AggState;
}

/** Helper → lead messages, sent through a Redis list (unlike pub/sub, nothing is lost if the lead reads late). */
type ShardMsg =
  | { k: 'ready'; i: number; w: string }
  | { k: 'slices'; i: number; cpu: number | null; slices: Slice[] }
  | { k: 'steps'; i: number; steps: StepState[] }
  | { k: 'final'; i: number; result: ShardResult };

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

function send(runId: string, m: ShardMsg) {
  return redis.multi().rpush(keys.inbox(runId), JSON.stringify(m)).expire(keys.inbox(runId), 86400).exec().catch(() => {});
}

/** Tells the lead worker that this helper crashed outside k6 (so it doesn't wait for it). */
export async function reportShardCrash(run: RunRow, shard: number, workerId: string, err: Error) {
  const result: ShardResult = {
    shard,
    workerId,
    exitCode: null,
    failed: true,
    error: err.message,
    requests: 0,
    thresholds: [],
    iteration: null,
    generator: null,
    warnings: [],
    logs: [`[error] ${err.message}`],
  };
  await send(run.id, { k: 'final', i: shard, result });
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** k6 execution segment boundary i/n, written the way k6 expects ("0", "1/3", "1"). */
const frac = (i: number, n: number) => (i === 0 ? '0' : i === n ? '1' : `${i}/${n}`);

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

/** k6 REST API (only enabled on distributed runs, for the paused start). */
async function k6Api(port: number, body?: unknown): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      method: body ? 'PATCH' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** k6 status 4 = initialized and paused before the run */
const K6_PAUSED_BEFORE_RUN = 4;

function readK6Summary(summaryPath: string) {
  let k6Summary: any = null;
  try {
    k6Summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    /* missing if force-stopped */
  }
  const thresholds: ShardResult['thresholds'] = [];
  for (const [metric, m] of Object.entries<any>(k6Summary?.metrics ?? {})) {
    for (const [expr, r] of Object.entries<any>(m.thresholds ?? {})) thresholds.push({ metric, expr, ok: !!r.ok });
  }
  const it = k6Summary?.metrics?.iteration_duration?.values;
  const iteration = it ? { avg: it.avg, p95: it['p(95)'], count: k6Summary.metrics.iterations?.values?.count ?? 0 } : null;
  return { thresholds, iteration };
}

/**
 * Runs one k6 process. A normal run has one shard. A distributed run has N: every worker runs
 * 1/N of the load (k6 execution segments), all resume from a paused state at the same moment,
 * and the lead worker (shard 0) merges what the helpers send into the run's metrics and summary.
 */
export async function executeRun(run: RunRow, workerId: string, shard = 0): Promise<void> {
  const cfg = run.config;
  const n = Math.max(1, run.shards || 1);
  const distributed = n > 1;
  const lead = shard === 0;
  const dir = path.join(config.workDir, distributed ? `${run.id}-${shard}` : run.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  const summaryPath = path.join(dir, 'summary.json');
  const fifo = path.join(dir, 'metrics.fifo');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  execFileSync('mkfifo', [fifo]);

  const pending: Bucket[] = [];
  const timeline = new Timeline(n, (b) => {
    pending.push(b);
    publish(run.id, 'metric', b);
  });
  const outbox: Slice[] = [];
  const agg = new Aggregator((s) => (lead ? timeline.add(0, s) : outbox.push(s)));
  const tag = distributed ? `[worker ${shard + 1}/${n}] ` : '';

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

  const port = distributed ? await freePort() : 0;
  const args = [
    'run',
    '--quiet',
    '--no-color',
    '--log-format=json',
    distributed ? `--address=127.0.0.1:${port}` : '--address=localhost:0',
    ...(distributed
      ? [
          '--paused',
          `--execution-segment=${frac(shard, n)}:${frac(shard + 1, n)}`,
          `--execution-segment-sequence=${Array.from({ length: n + 1 }, (_, i) => frac(i, n)).join(',')}`,
        ]
      : []),
    '--system-tags=status,method,name,check,error_code,expected_response,scenario',
    `--out=json=${fifo}`,
    '-e', `RUNNER_CONFIG=${cfgPath}`,
    '-e', `SUMMARY_PATH=${summaryPath}`,
    config.runnerPath,
  ];

  let startedAt = Date.now();
  const child: ChildProcess = spawn(config.k6Bin, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, K6_NO_USAGE_REPORT: 'true' } });
  const sampler = child.pid ? new ProcSampler(child.pid) : null;
  // listen right away: on a distributed run k6 can exit while we are still waiting for the other workers
  let k6Exited = false;
  const exited: Promise<number | null> = new Promise((resolve) => {
    child.on('error', (err) => {
      pushLog(`[spawn] ${err.message}`);
      k6Exited = true;
      resolve(-1);
    });
    child.on('exit', (code, signal) => {
      if (signal) pushLog(`[k6] terminated by signal: ${signal}`);
      k6Exited = true;
      resolve(code);
    });
  });

  type StopMode = 'user' | 'autostop' | 'timeout' | 'failure';
  let stopReason: string | null = null;
  let stopMode: StopMode | null = null;
  let interrupted = false;
  let killTimer: NodeJS.Timeout | null = null;

  const stop = (mode: 'stop' | 'kill', reason?: string, by: StopMode = 'user') => {
    if (k6Exited) return;
    if (!stopMode) {
      stopMode = by;
      stopReason = reason ?? (by === 'user' ? 'Stopped by user' : null);
      if (lead) {
        db.update(runs)
          .set({ status: 'stopping', stopReason })
          .where(and(eq(runs.id, run.id), inArray(runs.status, ['starting', 'running'])))
          .catch(() => {});
        publish(run.id, 'status', { status: 'stopping', stopReason });
        // helpers follow the lead's decision (a user stop already reaches them on the same channel)
        if (distributed && by !== 'user') redis.publish(keys.control(run.id), mode).catch(() => {});
      }
    }
    if (mode === 'kill') {
      child.kill('SIGKILL');
      return;
    }
    // a second SIGINT makes k6 abort without writing its summary
    if (interrupted) return;
    interrupted = true;
    child.kill('SIGINT');
    if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  };

  active = { id: run.id, name: run.name, shard, startedAt, sampler, stop: (m, r) => stop(m, r, 'user') };

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
        if (j.level === 'error' || j.level === 'warning') publish(run.id, 'log', tag + line);
      } catch {
        pushLog(l);
      }
    }
  });

  // control channel (stop / force stop), shared by every worker of the run
  const ctl = createRedis();
  ctl.on('message', (_ch: string, msg: string) => {
    if (msg === 'stop') stop('stop');
    if (msg === 'kill') stop('kill');
  });
  await ctl.subscribe(keys.control(run.id));

  // --- lead: what the helpers report ---
  const helpers = new Map<number, string>();
  const results = new Map<number, ShardResult>();
  const remoteSteps = new Map<number, StepState[]>();
  const ready = new Set<number>();
  const lastSeen = new Map<number, number>();
  const lost = new Set<number>();
  const handle = (m: ShardMsg) => {
    lastSeen.set(m.i, Date.now());
    if (m.k === 'ready') {
      ready.add(m.i);
      helpers.set(m.i, m.w);
    } else if (m.k === 'slices') {
      timeline.cpu[m.i] = m.cpu;
      for (const s of m.slices) timeline.add(m.i, s);
    } else if (m.k === 'steps') {
      remoteSteps.set(m.i, m.steps);
    } else if (m.k === 'final') {
      results.set(m.i, m.result);
      helpers.set(m.i, m.result.workerId);
      timeline.finish(m.i);
      if (m.result.failed && !stopMode) stop('stop', `Worker ${m.result.workerId}: ${m.result.error ?? 'k6 exited'}`, 'failure');
    }
  };
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      const res = await redis.multi().lrange(keys.inbox(run.id), 0, -1).del(keys.inbox(run.id)).exec();
      for (const raw of (res?.[0]?.[1] as string[] | undefined) ?? []) {
        try {
          handle(JSON.parse(raw));
        } catch {
          /* malformed message */
        }
      }
    } catch {
      /* Redis hiccup: the messages stay in the list for the next drain */
    } finally {
      draining = false;
    }
  };

  // --- synchronized start (distributed) ---
  let startError: string | null = null;
  let goAt: number | null = null;
  if (distributed && lead) {
    const t0 = Date.now();
    let last = '';
    for (;;) {
      if (stopMode) {
        startError = stopReason;
        break;
      }
      if (k6Exited) {
        startError = 'k6 exited before the test started';
        break;
      }
      await drain();
      if (!ready.has(0) && (await k6Api(port))?.data?.attributes?.status === K6_PAUSED_BEFORE_RUN) ready.add(0);
      const owners = await redis.mget(...Array.from({ length: n - 1 }, (_, i) => keys.shard(run.id, i + 1)));
      const claimed = 1 + owners.filter(Boolean).length;
      const state = `${claimed}/${ready.size}`;
      if (state !== last) {
        last = state;
        publish(run.id, 'status', { status: 'starting', workers: { total: n, claimed, ready: ready.size } });
      }
      if (ready.size === n) break;
      const waited = Date.now() - t0;
      if (claimed < n && waited > 60_000) {
        startError = `Only ${claimed} of ${n} workers were free within 60 s`;
        break;
      }
      if (waited > 300_000) {
        startError = `Workers were not ready within 5 minutes (${ready.size} of ${n})`;
        break;
      }
      await sleep(500);
    }
    if (startError === null) {
      goAt = Date.now() + 1000;
      await redis.set(keys.go(run.id), String(goAt), 'EX', 86400);
    } else {
      await redis.set(keys.go(run.id), 'abort', 'EX', 86400);
      if (!stopMode) stop('kill', startError, 'failure');
      await redis.publish(keys.control(run.id), 'kill');
      child.kill('SIGKILL');
    }
  } else if (distributed) {
    const t0 = Date.now();
    let announced = false;
    while (!stopMode && !k6Exited && Date.now() - t0 < 600_000) {
      if (!announced && (await k6Api(port))?.data?.attributes?.status === K6_PAUSED_BEFORE_RUN) {
        announced = true;
        await send(run.id, { k: 'ready', i: shard, w: workerId });
      }
      const go = await redis.get(keys.go(run.id));
      if (go === 'abort') break;
      if (go && announced) {
        goAt = Number(go);
        break;
      }
      await sleep(250);
    }
    if (goAt === null) stop('kill');
  }
  if (goAt !== null) {
    agg.startMs = goAt;
    await sleep(goAt - Date.now());
    if (!(await k6Api(port, { data: { type: 'status', id: 'default', attributes: { paused: false } } }))) {
      stop('kill', `Worker ${workerId}: could not resume the paused k6 process`, 'failure');
    }
    startedAt = goAt;
    active.startedAt = goAt;
  }

  if (lead && (!distributed || goAt !== null)) {
    await db
      .update(runs)
      .set({ status: 'running', startedAt: new Date(startedAt), workerId })
      .where(and(eq(runs.id, run.id), eq(runs.status, 'starting')));
    publish(run.id, 'status', { status: 'running' });

    // a stop may have been requested before starting
    const [pre] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, run.id));
    if (pre?.status === 'stopping') stop('stop');
  }

  // --- auto-stop / capacity ---
  const as = cfg.meta.autoStop;
  let bestHealthy: (WindowStats & { t: number }) | null = null;
  let breach: (WindowStats & { t: number; reason: string }) | null = null;

  // a helper sends data every second; silence or a missing heartbeat means it is gone
  const checkHelpers = async () => {
    for (const [i, w] of helpers) {
      if (results.has(i) || lost.has(i)) continue;
      const silent = Date.now() - (lastSeen.get(i) ?? startedAt) > 15_000;
      if (!silent && (await redis.exists(keys.workerHb(w)))) continue;
      lost.add(i);
      timeline.finish(i, true);
      if (!stopMode) stop('stop', `Worker ${w} stopped responding`, 'failure');
    }
  };

  const hardLimitMs = (cfg.meta.estDurationSec + 600) * 1000;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const s = sampler?.sample();
    const cpu = s ? round(s.cpu, 1) : null;
    agg.flush();
    if (Date.now() - startedAt > hardLimitMs && !stopMode) stop('stop', 'Maximum duration exceeded', 'timeout');

    if (!lead) {
      if (outbox.length) send(run.id, { k: 'slices', i: shard, cpu, slices: outbox.splice(0).map(sliceToWire) });
      if (tick % 2 === 0) send(run.id, { k: 'steps', i: shard, steps: agg.stepsState() });
      return;
    }
    timeline.cpu[0] = cpu;
    void leadTick();
  }, 1000);

  // read what the helpers sent before merging, so their seconds aren't held back a tick
  async function leadTick() {
    if (distributed) await drain();
    timeline.flush();

    if (as.enabled && !stopMode) {
      const w = timeline.window(as.windowSec);
      if (w && timeline.emitted.length >= as.graceSec + as.windowSec) {
        const t = timeline.emitted[timeline.emitted.length - 1].t;
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
      const steps = agg.stepsSnapshot([...remoteSteps.values()]);
      publish(run.id, 'steps', steps);
      redis.set(keys.steps(run.id), JSON.stringify(steps), 'EX', 3600).catch(() => {});
    }
    if (tick % 5 === 0 && pending.length) {
      insertBuckets(run.id, pending.splice(0)).catch((e) => pushLog(`[db] ${e.message}`));
    }
    if (distributed && tick % 5 === 0) void checkHelpers();
  }

  const exitCode = await exited;
  clearInterval(timer);
  if (killTimer) clearTimeout(killTimer);
  unblockFifo(fifo);
  await Promise.race([readerDone, new Promise((r) => setTimeout(r, 5000))]);
  reader.destroy();
  await ctl.quit().catch(() => {});
  agg.flush(true);

  // --- this worker's own result ---
  const k6 = readK6Summary(summaryPath);
  // a helper that hit a failure (e.g. could not resume) reports it; the lead's own failure decides the run status below
  const failed = (stopMode === 'failure' && !lead) || (!stopMode && exitCode !== 0 && exitCode !== 99);
  const cores = cgroupInfo()?.cpuLimitCores ?? os.cpus().length;
  const own: ShardResult = {
    shard,
    workerId,
    exitCode,
    failed,
    error: failed ? (stopMode ? stopReason : null) || logs.filter((l) => l.startsWith('[error]') || l.startsWith('[spawn]')).slice(-5).join('\n') || `k6 exit code: ${exitCode}` : null,
    requests: agg.totalReqs,
    thresholds: k6.thresholds,
    iteration: k6.iteration,
    generator: sampler
      ? { maxCpuPct: round(sampler.maxCpu, 1), avgCpuPct: round(sampler.samples ? sampler.sumCpu / sampler.samples : 0, 1), maxRssBytes: sampler.maxRss }
      : null,
    warnings:
      sampler && sampler.maxCpu > 85 * cores
        ? [`Load generator (k6) CPU reached ${Math.round(sampler.maxCpu)}% (${cores} cores). Results may be limited by the load generator; give the worker more CPU.`]
        : [],
    logs,
  };

  if (!lead) {
    if (outbox.length) await send(run.id, { k: 'slices', i: shard, cpu: null, slices: outbox.splice(0).map(sliceToWire) });
    await send(run.id, { k: 'final', i: shard, result: { ...own, logs: logs.slice(-100), state: agg.exportState() } });
    active = null;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[worker] ${run.id} shard ${shard + 1}/${n} finished (k6 exit=${exitCode}, requests=${own.requests})`);
    return;
  }

  const warnings: string[] = [];
  if (distributed) {
    // helpers stop at the same time as the lead; give them a moment to send their last data
    timeline.finish(0);
    const deadline = Date.now() + (goAt === null ? 15_000 : 60_000);
    const waiting = () => [...helpers.keys()].filter((i) => !results.has(i) && !lost.has(i));
    while (waiting().length && Date.now() < deadline) {
      await drain();
      await sleep(500);
    }
    await drain();
    for (const i of helpers.keys()) if (!results.has(i)) warnings.push(`Worker ${helpers.get(i)} sent no results; its share of the load is missing from the summary`);
  }
  timeline.flush(true);
  await insertBuckets(run.id, pending.splice(0)).catch((e) => pushLog(`[db] ${e.message}`));

  // --- summary ---
  const all = [own, ...[...results.values()].sort((a, b) => a.shard - b.shard)];
  for (const r of all) if (r.state) agg.mergeState(r.state);

  const durationSec = timeline.emitted.length || Math.round((Date.now() - startedAt) / 1000);
  const summary: any = agg.summary(durationSec, timeline.peak);

  // k6 evaluates thresholds per process; across workers a threshold passes only if it passed everywhere
  const thresholds = new Map<string, { metric: string; expr: string; ok: boolean }>();
  for (const r of all) {
    for (const th of r.thresholds) {
      const key = `${th.metric}\u001f${th.expr}`;
      const cur = thresholds.get(key);
      thresholds.set(key, { ...th, ok: (cur?.ok ?? true) && th.ok });
    }
  }
  summary.thresholds = [...thresholds.values()];
  const its = all.map((r) => r.iteration).filter((x): x is NonNullable<ShardResult['iteration']> => !!x);
  const itCount = its.reduce((a, x) => a + x.count, 0);
  if (its.length) {
    summary.iterationDuration = {
      avg: round(itCount ? its.reduce((a, x) => a + x.avg * x.count, 0) / itCount : its[0].avg),
      p95: round(Math.max(...its.map((x) => x.p95))),
    };
  }

  if (summary.droppedIterations > 0) {
    warnings.unshift(`${summary.droppedIterations} iterations could not start (dropped). The VU pool was too small for the target rate, or the system slowed down; increase maxVUs.`);
  }
  for (const r of all) for (const w of r.warnings) warnings.push(distributed ? `Worker ${r.workerId}: ${w}` : w);
  summary.warnings = warnings;
  const gens = all.map((r) => r.generator).filter((g): g is NonNullable<ShardResult['generator']> => !!g);
  summary.generator = gens.length
    ? {
        maxCpuPct: Math.max(...gens.map((g) => g.maxCpuPct ?? 0)),
        avgCpuPct: round(gens.reduce((a, g) => a + (g.avgCpuPct ?? 0), 0) / gens.length, 1),
        maxRssBytes: Math.max(...gens.map((g) => g.maxRssBytes)),
      }
    : null;
  if (distributed) {
    summary.workers = all.map((r) => ({ shard: r.shard + 1, workerId: r.workerId, requests: r.requests, exitCode: r.exitCode, error: r.error, ...r.generator }));
  }
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
  const mode = stopMode as StopMode | null;
  if (mode === 'user') status = 'stopped';
  else if (mode === 'failure') {
    status = 'failed';
    error = startError ?? stopReason;
  } else if (all.some((r) => r.failed)) {
    status = 'failed';
    error = all
      .filter((r) => r.failed)
      .map((r) => (distributed ? `Worker ${r.workerId}: ${r.error}` : r.error))
      .join('\n');
  } else status = 'completed';
  const thresholdsPassed = summary.thresholds.length ? summary.thresholds.every((t: { ok: boolean }) => t.ok) : null;

  let allLogs = logs.join('\n');
  for (const r of all.slice(1)) allLogs += `\n\n--- worker ${r.shard + 1}/${n}: ${r.workerId} ---\n${r.logs.join('\n')}`;

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
      logs: allLogs,
    })
    .where(eq(runs.id, run.id));
  publish(run.id, 'status', { status, done: true });
  if (distributed) {
    await redis.del(keys.inbox(run.id), keys.go(run.id), ...Array.from({ length: n - 1 }, (_, i) => keys.shard(run.id, i + 1))).catch(() => {});
  }
  active = null;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[worker] ${run.id} finished: ${status} (k6 exit=${exitCode}, requests=${summary.requests}${distributed ? `, workers=${n}` : ''})`);
}
