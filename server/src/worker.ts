import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { config, env } from './lib/config.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, migrate, waitForDb } from './lib/db.js';
import { runs } from './db/schema.js';
import { createRedis, keys, redis } from './lib/redis.js';
import { startReporter } from './lib/sysinfo.js';
import { active, executeRun, type RunRow } from './worker/executor.js';

const workerId = env.WORKER_ID ?? `worker-${os.hostname()}-${process.pid}`;
let shuttingDown = false;
let k6Version = 'unknown';

/** Locks and claims the oldest queued run; multiple workers can't take the same run (SKIP LOCKED). */
async function claim(): Promise<RunRow | null> {
  const next = db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, 'queued'))
    .orderBy(asc(runs.createdAt))
    .limit(1)
    .for('update', { skipLocked: true });
  const [r] = await db
    .update(runs)
    .set({ status: 'starting', workerId })
    .where(and(inArray(runs.id, next), eq(runs.status, 'queued')))
    .returning({ id: runs.id, name: runs.name, kind: runs.kind, status: runs.status, config: runs.config });
  return r ?? null;
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
  console.log(`[worker] ${workerId} ready — ${k6Version}`);

  const hb = async () => {
    await redis.set(keys.workerHb(workerId), JSON.stringify({ activeRun: active?.id ?? null, at: Date.now() }), 'EX', 30).catch(() => {});
  };
  await hb();
  setInterval(hb, 5000).unref();

  startReporter('worker', workerId, () => {
    const s = active?.sampler;
    return {
      k6Version,
      activeRun: active ? { id: active.id, name: active.name, startedAt: new Date(active.startedAt).toISOString() } : null,
      k6: s ? { maxCpuPct: Math.round(s.maxCpu), lastAvgCpuPct: s.samples ? Math.round(s.sumCpu / s.samples) : 0, maxRssBytes: s.maxRss } : null,
    };
  });

  const blocking = createRedis();
  while (!shuttingDown) {
    let run: RunRow | null = null;
    try {
      run = await claim();
    } catch (err) {
      console.error('[worker] claim error', (err as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (run) {
      console.log(`[worker] starting: ${run.id} (${run.name})`);
      try {
        await executeRun(run, workerId);
      } catch (err) {
        console.error('[worker] run error', err);
        await db.update(runs).set({ status: 'failed', finishedAt: new Date(), error: (err as Error).message }).where(eq(runs.id, run.id)).catch(() => {});
        await redis.publish(keys.live(run.id), JSON.stringify({ type: 'status', data: { status: 'failed', done: true } })).catch(() => {});
      }
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
