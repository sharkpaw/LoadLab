export interface HistoJSON {
  b: [number, number][];
  n: number;
  sum: number;
  min: number;
  max: number;
}

/** Log-bucketed histogram (~1% precision) for mergeable percentile computation. */
export class Histo {
  private static readonly LN = Math.log(1.02);
  private buckets = new Map<number, number>();
  n = 0;
  sum = 0;
  min = Infinity;
  max = 0;

  add(v: number) {
    const idx = v <= 0 ? 0 : Math.floor(Math.log1p(v) / Histo.LN);
    this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + 1);
    this.n++;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  quantile(q: number): number | null {
    if (!this.n) return null;
    const target = q * this.n;
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    let acc = 0;
    for (const k of keys) {
      acc += this.buckets.get(k)!;
      if (acc >= target) {
        const lo = Math.expm1(k * Histo.LN);
        const hi = Math.expm1((k + 1) * Histo.LN);
        return Math.min(this.max, Math.max(this.min, (lo + hi) / 2));
      }
    }
    return this.max;
  }

  merge(o: Histo): this {
    for (const [k, c] of o.buckets) this.buckets.set(k, (this.buckets.get(k) ?? 0) + c);
    this.n += o.n;
    this.sum += o.sum;
    if (o.min < this.min) this.min = o.min;
    if (o.max > this.max) this.max = o.max;
    return this;
  }

  toJSON(): HistoJSON {
    return { b: [...this.buckets], n: this.n, sum: this.sum, min: this.n ? this.min : 0, max: this.max };
  }

  static from(j: HistoJSON): Histo {
    const h = new Histo();
    h.buckets = new Map(j.b);
    h.n = j.n;
    h.sum = j.sum;
    h.min = j.n ? j.min : Infinity;
    h.max = j.max;
    return h;
  }

  static of(values: number[]): Histo {
    const h = new Histo();
    for (const v of values) h.add(v);
    return h;
  }

  get avg(): number | null {
    return this.n ? this.sum / this.n : null;
  }

  stats() {
    return {
      count: this.n,
      avg: round(this.avg),
      min: this.n ? round(this.min) : null,
      p50: round(this.quantile(0.5)),
      p90: round(this.quantile(0.9)),
      p95: round(this.quantile(0.95)),
      p99: round(this.quantile(0.99)),
      max: this.n ? round(this.max) : null,
    };
  }
}

export function round(v: number | null | undefined, d = 2): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function exactQuantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

export interface Bucket {
  t: number;
  ts: string;
  vus: number;
  rps: number;
  iters: number;
  err_rate: number;
  avg: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  bytes_in: number;
  bytes_out: number;
  dropped: number;
  checks_fail: number;
  gen_cpu: number | null;
}

/**
 * One shard's data for one second. Slices from several workers (a distributed run) are merged
 * into a Bucket by Timeline. A local slice carries the raw durations (exact percentiles);
 * one sent over Redis carries a histogram instead.
 */
export interface Slice {
  t: number;
  ts: number;
  reqs: number;
  fails: number;
  iters: number;
  bytesIn: number;
  bytesOut: number;
  dropped: number;
  checksFail: number;
  vus: number | null;
  durations?: number[];
  h?: HistoJSON;
}

/** Compact form of a slice for sending to the lead worker. */
export function sliceToWire(s: Slice): Slice {
  const { durations, ...rest } = s;
  return durations ? { ...rest, h: Histo.of(durations).toJSON() } : rest;
}

export interface StepState {
  flow: string;
  step: string;
  h: HistoJSON;
  fails: number;
}

/** Everything a shard has counted; merged on the lead worker for the final summary. */
export interface AggState {
  total: HistoJSON;
  reqs: number;
  fails: number;
  iters: number;
  dropped: number;
  bytesIn: number;
  bytesOut: number;
  maxVus: number;
  steps: StepState[];
  flows: { name: string; completed: number; aborted: number; h: HistoJSON }[];
  statuses: [string, number][];
  errorCodes: [string, number][];
  checks: [string, { pass: number; fail: number }][];
  abortSteps: [string, number][];
}

function addCounts(into: Map<string, number>, from: [string, number][]) {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
}

interface RawBucket {
  durations: number[];
  reqs: number;
  fails: number;
  iters: number;
  bytesIn: number;
  bytesOut: number;
  dropped: number;
  checksFail: number;
  vus: number | null;
}

interface StepAgg {
  flow: string;
  step: string;
  histo: Histo;
  fails: number;
}

export interface WindowStats {
  seconds: number;
  rps: number;
  iterRate: number;
  vus: number;
  p95: number | null;
  errRate: number;
}

/**
 * Converts k6 JSON output (line by line) into per-second slices and per-step summaries.
 */
export class Aggregator {
  /** Second 0 of the run. Set up front on distributed runs so every worker counts from the same moment. */
  startMs: number | null = null;
  private raw = new Map<number, RawBucket>();
  private maxSec = -1;
  private nextEmit = 0;

  total = new Histo();
  totalReqs = 0;
  totalFails = 0;
  totalIters = 0;
  totalDropped = 0;
  bytesIn = 0;
  bytesOut = 0;
  maxVus = 0;
  steps = new Map<string, StepAgg>();
  flows = new Map<string, { completed: number; aborted: number; duration: Histo }>();
  statuses = new Map<string, number>();
  errorCodes = new Map<string, number>();
  checks = new Map<string, { pass: number; fail: number }>();
  abortSteps = new Map<string, number>();

  constructor(private onSlice: (s: Slice) => void) {}

  private bucket(sec: number): RawBucket {
    let b = this.raw.get(sec);
    if (!b) {
      b = { durations: [], reqs: 0, fails: 0, iters: 0, bytesIn: 0, bytesOut: 0, dropped: 0, checksFail: 0, vus: null };
      this.raw.set(sec, b);
    }
    return b;
  }

  private flow(name: string) {
    let f = this.flows.get(name);
    if (!f) {
      f = { completed: 0, aborted: 0, duration: new Histo() };
      this.flows.set(name, f);
    }
    return f;
  }

  /** Processes one JSON line. Only the needed metrics are parsed. */
  line(line: string) {
    // fast pre-filter: definition lines and sub-timings we don't care about
    if (line.indexOf('"type":"Point"') === -1) return;
    let metric: string;
    if (line.startsWith('{"metric":"')) {
      metric = line.slice(11, line.indexOf('"', 11));
    } else {
      // slow path if the field order differs
      const m = /"metric":"([^"]+)"/.exec(line);
      if (!m) return;
      metric = m[1];
    }
    switch (metric) {
      case 'http_req_duration':
      case 'http_req_failed':
      case 'iterations':
      case 'vus':
      case 'data_received':
      case 'data_sent':
      case 'dropped_iterations':
      case 'checks':
      case 'flow_completed':
      case 'flow_aborted':
      case 'flow_duration':
        break;
      default:
        return;
    }
    let p: { data: { time: string; value: number; tags: Record<string, string> } };
    try {
      p = JSON.parse(line);
    } catch {
      return;
    }
    const ts = Date.parse(p.data.time);
    if (this.startMs === null) this.startMs = ts;
    const sec = Math.max(0, Math.floor((ts - this.startMs) / 1000));
    if (sec > this.maxSec) this.maxSec = sec;
    const v = p.data.value;
    const tags = p.data.tags ?? {};
    const b = this.bucket(sec);

    switch (metric) {
      case 'http_req_duration': {
        b.durations.push(v);
        b.reqs++;
        this.totalReqs++;
        this.total.add(v);
        const key = `${tags.flow ?? '-'}\u001f${tags.step ?? tags.name ?? '-'}`;
        let s = this.steps.get(key);
        if (!s) {
          s = { flow: tags.flow ?? '-', step: tags.step ?? tags.name ?? '-', histo: new Histo(), fails: 0 };
          this.steps.set(key, s);
        }
        s.histo.add(v);
        const st = tags.status ?? '0';
        this.statuses.set(st, (this.statuses.get(st) ?? 0) + 1);
        if (tags.error_code) this.errorCodes.set(tags.error_code, (this.errorCodes.get(tags.error_code) ?? 0) + 1);
        break;
      }
      case 'http_req_failed':
        if (v) {
          b.fails++;
          this.totalFails++;
          const s = this.steps.get(`${tags.flow ?? '-'}\u001f${tags.step ?? tags.name ?? '-'}`);
          if (s) s.fails++;
        }
        break;
      case 'iterations':
        b.iters += v;
        this.totalIters += v;
        break;
      case 'vus':
        b.vus = v;
        if (v > this.maxVus) this.maxVus = v;
        break;
      case 'data_received':
        b.bytesIn += v;
        this.bytesIn += v;
        break;
      case 'data_sent':
        b.bytesOut += v;
        this.bytesOut += v;
        break;
      case 'dropped_iterations':
        b.dropped += v;
        this.totalDropped += v;
        break;
      case 'checks': {
        const name = tags.check ?? '?';
        let c = this.checks.get(name);
        if (!c) {
          c = { pass: 0, fail: 0 };
          this.checks.set(name, c);
        }
        if (v) c.pass++;
        else {
          c.fail++;
          b.checksFail++;
        }
        break;
      }
      case 'flow_completed':
        this.flow(tags.flow ?? '-').completed += v;
        break;
      case 'flow_aborted': {
        this.flow(tags.flow ?? '-').aborted += v;
        const k = `${tags.flow ?? '-'} → ${tags.step ?? '-'}`;
        this.abortSteps.set(k, (this.abortSteps.get(k) ?? 0) + v);
        break;
      }
      case 'flow_duration':
        this.flow(tags.flow ?? '-').duration.add(v);
        break;
    }
  }

  /** Emits completed seconds, allowing for late data (lag seconds). */
  flush(final = false, lag = 2) {
    if (this.startMs === null) return;
    const upTo = final ? this.maxSec : this.maxSec - lag;
    for (let s = this.nextEmit; s <= upTo; s++) {
      const r = this.raw.get(s);
      this.raw.delete(s);
      this.onSlice({
        t: s,
        ts: this.startMs + s * 1000,
        reqs: r?.reqs ?? 0,
        fails: r?.fails ?? 0,
        iters: r?.iters ?? 0,
        bytesIn: r?.bytesIn ?? 0,
        bytesOut: r?.bytesOut ?? 0,
        dropped: r?.dropped ?? 0,
        checksFail: r?.checksFail ?? 0,
        vus: r?.vus ?? null,
        durations: r ? r.durations.sort((a, b) => a - b) : [],
      });
    }
    this.nextEmit = Math.max(this.nextEmit, upTo + 1);
  }

  stepsState(): StepState[] {
    return [...this.steps.values()].map((s) => ({ flow: s.flow, step: s.step, h: s.histo.toJSON(), fails: s.fails }));
  }

  exportState(): AggState {
    return {
      total: this.total.toJSON(),
      reqs: this.totalReqs,
      fails: this.totalFails,
      iters: this.totalIters,
      dropped: this.totalDropped,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      maxVus: this.maxVus,
      steps: this.stepsState(),
      flows: [...this.flows.entries()].map(([name, f]) => ({ name, completed: f.completed, aborted: f.aborted, h: f.duration.toJSON() })),
      statuses: [...this.statuses],
      errorCodes: [...this.errorCodes],
      checks: [...this.checks],
      abortSteps: [...this.abortSteps],
    };
  }

  private mergeSteps(into: Map<string, StepAgg>, steps: StepState[]) {
    for (const s of steps) {
      const key = `${s.flow}\u001f${s.step}`;
      const cur = into.get(key);
      if (cur) {
        cur.histo.merge(Histo.from(s.h));
        cur.fails += s.fails;
      } else into.set(key, { flow: s.flow, step: s.step, histo: Histo.from(s.h), fails: s.fails });
    }
  }

  /** Adds another shard's totals (the lead worker merges every helper's state before the summary). */
  mergeState(o: AggState) {
    this.total.merge(Histo.from(o.total));
    this.totalReqs += o.reqs;
    this.totalFails += o.fails;
    this.totalIters += o.iters;
    this.totalDropped += o.dropped;
    this.bytesIn += o.bytesIn;
    this.bytesOut += o.bytesOut;
    this.mergeSteps(this.steps, o.steps);
    for (const f of o.flows) {
      const cur = this.flow(f.name);
      cur.completed += f.completed;
      cur.aborted += f.aborted;
      cur.duration.merge(Histo.from(f.h));
    }
    addCounts(this.statuses, o.statuses);
    addCounts(this.errorCodes, o.errorCodes);
    addCounts(this.abortSteps, o.abortSteps);
    for (const [name, c] of o.checks) {
      const cur = this.checks.get(name) ?? { pass: 0, fail: 0 };
      this.checks.set(name, { pass: cur.pass + c.pass, fail: cur.fail + c.fail });
    }
  }

  /** Per-step stats; `others` are live step states from helper workers. */
  stepsSnapshot(others: StepState[][] = []) {
    let steps = this.steps;
    if (others.length) {
      steps = new Map([...this.steps].map(([k, s]) => [k, { ...s, histo: new Histo().merge(s.histo) }]));
      for (const o of others) this.mergeSteps(steps, o);
    }
    return [...steps.values()]
      .map((s) => ({ flow: s.flow, step: s.step, fails: s.fails, errRate: s.histo.n ? round(s.fails / s.histo.n, 4) : 0, ...s.histo.stats() }))
      .sort((a, b) => a.flow.localeCompare(b.flow));
  }

  /** `peak` comes from the Timeline: per-second values summed across workers. */
  summary(durationSec: number, peak: { rps: number; vus: number }) {
    const top = (m: Map<string, number>, n = 20) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
    return {
      durationSec,
      requests: this.totalReqs,
      failed: this.totalFails,
      errorRate: this.totalReqs ? round(this.totalFails / this.totalReqs, 5) : 0,
      iterations: this.totalIters,
      droppedIterations: this.totalDropped,
      rpsAvg: durationSec ? round(this.totalReqs / durationSec) : null,
      rpsPeak: peak.rps,
      maxVus: Math.max(this.maxVus, peak.vus),
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      latency: this.total.stats(),
      steps: this.stepsSnapshot(),
      flows: [...this.flows.entries()].map(([name, f]) => ({ name, completed: f.completed, aborted: f.aborted, duration: f.duration.stats() })),
      statuses: top(this.statuses),
      errorCodes: top(this.errorCodes),
      abortedAt: top(this.abortSteps),
      checks: [...this.checks.entries()].map(([name, c]) => ({ name, ...c })),
    };
  }
}

/**
 * Merges per-second slices from one or more workers into Buckets (chart points), and answers the
 * rolling-window questions auto-stop asks. With one worker the percentiles are exact; across
 * workers they come from merged histograms (~1%).
 */
export class Timeline {
  private pending = new Map<number, Map<number, Slice>>();
  private reported: number[];
  private finished: boolean[];
  private lastVus: number[];
  private nextEmit = 0;
  private maxT = -1;
  private t0: number | null = null;
  /** Latest k6 CPU % per worker; the bucket shows the busiest one. */
  cpu: (number | null)[];
  emitted: Bucket[] = [];
  private recent: { t: number; durations: number[] | null; h: Histo | null }[] = [];

  constructor(
    private shards: number,
    private onBucket: (b: Bucket) => void,
  ) {
    this.reported = Array(shards).fill(-1);
    this.finished = Array(shards).fill(false);
    this.lastVus = Array(shards).fill(0);
    this.cpu = Array(shards).fill(null);
  }

  add(shard: number, s: Slice) {
    if (s.t < this.nextEmit) return; // too late: the second was already emitted (totals still include it)
    let parts = this.pending.get(s.t);
    if (!parts) {
      parts = new Map();
      this.pending.set(s.t, parts);
    }
    parts.set(shard, s);
    if (this.t0 === null) this.t0 = s.ts - s.t * 1000;
    if (s.t > this.reported[shard]) this.reported[shard] = s.t;
    if (s.t > this.maxT) this.maxT = s.t;
  }

  /** A worker has sent everything (or is gone); seconds no longer wait for it. A lost worker's VUs stop counting. */
  finish(shard: number, lost = false) {
    this.finished[shard] = true;
    if (lost) this.lastVus[shard] = 0;
  }

  /** Emits each second once every worker has reported it, or once it is `straggle` seconds behind. */
  flush(final = false, straggle = 5) {
    while (this.nextEmit <= this.maxT) {
      const t = this.nextEmit;
      const complete = this.reported.every((r, i) => r >= t || this.finished[i]);
      if (!final && !complete && this.maxT - t < straggle) break;
      this.emit(t);
      this.nextEmit++;
    }
  }

  private emit(t: number) {
    const parts = [...(this.pending.get(t) ?? new Map<number, Slice>())];
    this.pending.delete(t);
    let reqs = 0;
    let fails = 0;
    let iters = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    let dropped = 0;
    let checksFail = 0;
    for (const [shard, p] of parts) {
      if (p.vus !== null) this.lastVus[shard] = p.vus;
      reqs += p.reqs;
      fails += p.fails;
      iters += p.iters;
      bytesIn += p.bytesIn;
      bytesOut += p.bytesOut;
      dropped += p.dropped;
      checksFail += p.checksFail;
    }
    let durations: number[] | null = null;
    let h: Histo | null = null;
    if (this.shards === 1) durations = parts[0]?.[1].durations ?? [];
    else {
      h = new Histo();
      for (const [, p] of parts) h.merge(p.h ? Histo.from(p.h) : Histo.of(p.durations ?? []));
    }
    const q = (x: number) => round(durations ? exactQuantile(durations, x) : h!.quantile(x));
    let avg: number | null = null;
    if (durations?.length) avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    else if (h?.n) avg = h.avg;
    const cpus = this.cpu.filter((c): c is number => c !== null);
    const bk: Bucket = {
      t,
      ts: new Date((this.t0 ?? 0) + t * 1000).toISOString(),
      vus: this.lastVus.reduce((a, b) => a + b, 0),
      rps: reqs,
      iters,
      err_rate: reqs ? fails / reqs : 0,
      avg: round(avg),
      p50: q(0.5),
      p90: q(0.9),
      p95: q(0.95),
      p99: q(0.99),
      max: round(durations ? (durations.length ? durations[durations.length - 1] : null) : h!.n ? h!.max : null),
      bytes_in: Math.round(bytesIn),
      bytes_out: Math.round(bytesOut),
      dropped: Math.round(dropped),
      checks_fail: checksFail,
      gen_cpu: cpus.length ? Math.max(...cpus) : null,
    };
    this.recent.push({ t, durations, h });
    if (this.recent.length > 130) this.recent.shift();
    this.emitted.push(bk);
    this.onBucket(bk);
  }

  /** Stats for the last `seconds`-second window (auto-stop / breakpoint). */
  window(seconds: number): WindowStats | null {
    const bs = this.emitted.slice(-seconds);
    if (bs.length < seconds) return null;
    const fromT = bs[0].t;
    const recent = this.recent.filter((r) => r.t >= fromT);
    let p95: number | null;
    if (this.shards === 1) {
      const all: number[] = [];
      for (const r of recent) for (const d of r.durations ?? []) all.push(d);
      all.sort((a, b) => a - b);
      p95 = exactQuantile(all, 0.95);
    } else {
      const h = new Histo();
      for (const r of recent) if (r.h) h.merge(r.h);
      p95 = h.quantile(0.95);
    }
    const reqs = bs.reduce((a, b) => a + b.rps, 0);
    const fails = bs.reduce((a, b) => a + b.rps * b.err_rate, 0);
    return {
      seconds,
      rps: reqs / seconds,
      iterRate: bs.reduce((a, b) => a + b.iters, 0) / seconds,
      vus: bs[bs.length - 1].vus,
      p95,
      errRate: reqs ? fails / reqs : 0,
    };
  }

  get peak(): { rps: number; vus: number } {
    let rps = 0;
    let vus = 0;
    for (const b of this.emitted) {
      if (b.rps > rps) rps = b.rps;
      if (b.vus > vus) vus = b.vus;
    }
    return { rps, vus };
  }
}
