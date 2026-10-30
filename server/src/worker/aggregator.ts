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
 * Converts k6 JSON output (line by line) into per-second buckets and per-step summaries.
 */
export class Aggregator {
  startMs: number | null = null;
  private raw = new Map<number, RawBucket>();
  private maxSec = -1;
  private nextEmit = 0;
  private lastVus = 0;
  emitted: Bucket[] = [];
  /** Raw durations of the last few buckets (for window p95) */
  private recentDurations: { t: number; d: number[] }[] = [];

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
  genCpu: number | null = null;

  constructor(private onBucket: (b: Bucket) => void) {}

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

  /** Emits completed buckets, allowing for late data (lag seconds). */
  flush(final = false, lag = 2) {
    if (this.startMs === null) return;
    const upTo = final ? this.maxSec : this.maxSec - lag;
    for (let s = this.nextEmit; s <= upTo; s++) {
      const r = this.raw.get(s);
      this.raw.delete(s);
      const durations = r ? r.durations.sort((a, b) => a - b) : [];
      if (r?.vus !== null && r?.vus !== undefined) this.lastVus = r.vus;
      const reqs = r?.reqs ?? 0;
      let sum = 0;
      for (const d of durations) sum += d;
      const bk: Bucket = {
        t: s,
        ts: new Date(this.startMs + s * 1000).toISOString(),
        vus: this.lastVus,
        rps: reqs,
        iters: r?.iters ?? 0,
        err_rate: reqs ? (r!.fails / reqs) : 0,
        avg: round(durations.length ? sum / durations.length : null),
        p50: round(exactQuantile(durations, 0.5)),
        p90: round(exactQuantile(durations, 0.9)),
        p95: round(exactQuantile(durations, 0.95)),
        p99: round(exactQuantile(durations, 0.99)),
        max: round(durations.length ? durations[durations.length - 1] : null),
        bytes_in: Math.round(r?.bytesIn ?? 0),
        bytes_out: Math.round(r?.bytesOut ?? 0),
        dropped: Math.round(r?.dropped ?? 0),
        checks_fail: r?.checksFail ?? 0,
        gen_cpu: this.genCpu,
      };
      this.recentDurations.push({ t: s, d: durations });
      if (this.recentDurations.length > 130) this.recentDurations.shift();
      this.emitted.push(bk);
      this.onBucket(bk);
    }
    this.nextEmit = Math.max(this.nextEmit, upTo + 1);
  }

  /** Stats for the last `seconds`-second window (auto-stop / breakpoint). */
  window(seconds: number): WindowStats | null {
    const bs = this.emitted.slice(-seconds);
    if (bs.length < seconds) return null;
    const fromT = bs[0].t;
    const all: number[] = [];
    for (const r of this.recentDurations) if (r.t >= fromT) for (const d of r.d) all.push(d);
    all.sort((a, b) => a - b);
    const reqs = bs.reduce((a, b) => a + b.rps, 0);
    const fails = bs.reduce((a, b) => a + b.rps * b.err_rate, 0);
    return {
      seconds,
      rps: reqs / seconds,
      iterRate: bs.reduce((a, b) => a + b.iters, 0) / seconds,
      vus: bs[bs.length - 1].vus,
      p95: exactQuantile(all, 0.95),
      errRate: reqs ? fails / reqs : 0,
    };
  }

  stepsSnapshot() {
    return [...this.steps.values()]
      .map((s) => ({ flow: s.flow, step: s.step, fails: s.fails, errRate: s.histo.n ? round(s.fails / s.histo.n, 4) : 0, ...s.histo.stats() }))
      .sort((a, b) => a.flow.localeCompare(b.flow));
  }

  summary(durationSec: number) {
    const top = (m: Map<string, number>, n = 20) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
    const peak = this.emitted.reduce((a, b) => (b.rps > a ? b.rps : a), 0);
    return {
      durationSec,
      requests: this.totalReqs,
      failed: this.totalFails,
      errorRate: this.totalReqs ? round(this.totalFails / this.totalReqs, 5) : 0,
      iterations: this.totalIters,
      droppedIterations: this.totalDropped,
      rpsAvg: durationSec ? round(this.totalReqs / durationSec) : null,
      rpsPeak: peak,
      maxVus: this.maxVus,
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
