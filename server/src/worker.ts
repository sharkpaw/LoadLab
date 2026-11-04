import os from 'node:os';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config, env } from './lib/config.js';
import { and, asc, eq, gt, inArray, lte, or } from 'drizzle-orm';
import { db, migrate, waitForDb } from './lib/db.js';
import { runs } from './db/schema.js';
import { createRedis, keys, redis } from './lib/redis.js';
import { startReporter } from './lib/sysinfo.js';
import { active, executeRun, reportShardCrash, type RunRow } from './worker/executor.js';

const workerId = env.WORKER_ID ?? `worker-${os.hostname()}-${process.pid}`;
let shuttingDown = false;
let k6Version = 'unknown';
/** Chromium is installed (the -browser image), so this worker can run browser workflows */
const hasBrowser = existsSync(config.browserPath);

const runColumns = { id: runs.id, name: runs.name, kind: runs.kind, status: runs.status, config: runs.config, shards: runs.shards, browser: runs.browser };

/** Workers whose heartbeat says they're free (this one included); `browser` counts only those with Chromium. */
async function idleWorkers(): Promise<{ all: number; browser: number }> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', keys.workerHb('*'), 'COUNT', 200);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  const values = found.length ? await redis.mget(...found) : [];
  let all = 0;
  let browser = 0;
  for (const v of values) {
    try {
      const hb = v === null ? null : JSON.parse(v);
      if (hb?.activeRun !== null) continue;
      all++;
      if (hb.browser) browser++;
    } catch {
      /* malformed heartbeat */
    }
  }
  return { all: Math.max(1, all), browser: hasBrowser ? Math.max(1, browser) : browser };
}

/**
 * Locks and claims the oldest queued run; multiple workers can't take the same run (SKIP LOCKED).
 * A distributed run is only taken once enough workers are free, so it waits in the queue instead of
 * holding a worker while the others finish.
 */
async function claim(): Promise<RunRow | null> {
  const idle = await idleWorkers();
  // a worker without Chromium leaves browser runs to the ones that have it
  const fits = hasBrowser
    ? or(and(eq(runs.browser, false), lte(runs.shards, idle.all)), and(eq(runs.browser, true), lte(runs.shards, idle.browser)))
    : and(eq(runs.browser, false), lte(runs.shards, idle.all));
  const next = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, 'queued'), fits))
    .orderBy(asc(runs.createdAt))
    .limit(1)
    .for('update', { skipLocked: true });
  const [r] = await db
    .update(runs)
    .set({ status: 'starting', workerId })
    .where(and(inArray(runs.id, next), eq(runs.status, 'queued')))
    .returning(runColumns);
  return r ?? null;
}

/** Takes a free helper slot (shard 1..N-1) of a distributed run whose lead is waiting for workers. */
async function claimHelper(): Promise<{ run: RunRow; shard: number } | null> {
  const waiting = await db
    .select({ ...runColumns, workerId: runs.workerId })
    .from(runs)
    .where(and(eq(runs.status, 'starting'), gt(runs.shards, 1)))
    .orderBy(asc(runs.createdAt))
    .limit(10);
  for (const { workerId: leadId, ...run } of waiting) {
    if (leadId === workerId || (run.browser && !hasBrowser)) continue;
    for (let i = 1; i < run.shards; i++) {
      if ((await redis.set(keys.shard(run.id, i), workerId, 'EX', 86400, 'NX')) === 'OK') return { run, shard: i };
    }
  }
  return null;
}

async function main() {
  try {
    k6Version = execFileSync(config.k6Bin, ['version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch (err) {
    console.error(`[worker] k6 not found (${config.k6Bin}). Set K6_BIN.`);
    process.exit(1);
  }
  await waitForDb();
  await migrate();
  console.log(`[worker] ${workerId} ready — ${k6Version}${hasBrowser ? ' + browser' : ''}`);

  // `busyWith` marks the worker busy right after a claim, before the next 5 s beat
  const hb = async (busyWith?: string) => {
    await redis.set(keys.workerHb(workerId), JSON.stringify({ activeRun: busyWith ?? active?.id ?? null, browser: hasBrowser, at: Date.now() }), 'EX', 30).catch(() => {});
  };
  await hb();
  setInterval(hb, 5000).unref();

  startReporter('worker', workerId, () => {
    const s = active?.sampler;
    return {
      k6Version,
      browser: hasBrowser,
      activeRun: active ? { id: active.id, name: active.name, startedAt: new Date(active.startedAt).toISOString() } : null,
      k6: s ? { maxCpuPct: Math.round(s.maxCpu), lastAvgCpuPct: s.samples ? Math.round(s.sumCpu / s.samples) : 0, maxRssBytes: s.maxRss } : null,
    };
  });

  const blocking = createRedis();
  while (!shuttingDown) {
    let run: RunRow | null = null;
    let help: { run: RunRow; shard: number } | null = null;
    try {
      // helping a run that is waiting for workers comes before starting a new one
      help = await claimHelper();
      if (!help) run = await claim();
    } catch (err) {
      console.error('[worker] claim error', (err as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (help) {
      const { run: r, shard } = help;
      await hb(r.id);
      console.log(`[worker] helping: ${r.id} (${r.name}) as worker ${shard + 1}/${r.shards}`);
      try {
        await executeRun(r, workerId, shard);
      } catch (err) {
        console.error('[worker] shard error', err);
        await reportShardCrash(r, shard, workerId, err as Error).catch(() => {});
      }
      await hb();
      continue;
    }
    if (run) {
      await hb(run.id);
      // wake idle workers so they pick up the helper slots right away
      if (run.shards > 1) await redis.lpush(keys.queueWake, ...Array(run.shards - 1).fill(run.id)).catch(() => {});
      console.log(`[worker] starting: ${run.id} (${run.name})${run.shards > 1 ? ` on ${run.shards} workers` : ''}`);
      try {
        await executeRun(run, workerId);
      } catch (err) {
        console.error('[worker] run error', err);
        await db.update(runs).set({ status: 'failed', finishedAt: new Date(), error: (err as Error).message }).where(eq(runs.id, run.id)).catch(() => {});
        await redis.publish(keys.live(run.id), JSON.stringify({ type: 'status', data: { status: 'failed', done: true } })).catch(() => {});
        if (run.shards > 1) await redis.publish(keys.control(run.id), 'kill').catch(() => {});
      }
      await hb();
      continue;
    }
    await blocking.blpop(keys.queueWake, 5).catch(() => null);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[worker] shutting down…');
  if (active) {
    active.stop('stop', 'Worker shut down');
    const deadline = Date.now() + 60_000;
    while (active && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  }
  await redis.del(keys.workerHb(workerId)).catch(() => {});
  await redis.hdel(keys.nodes, workerId).catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
