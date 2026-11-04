import { describe, expect, test } from 'bun:test';
import { Aggregator, Histo, sliceToWire, Timeline, type Bucket } from '../src/worker/aggregator';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString().replace('Z', '123Z');

/** A k6 JSON-output Point line, same field order k6 uses. */
function point(metric: string, ms: number, value: number, tags: Record<string, string> = {}) {
  return JSON.stringify({ metric, type: 'Point', data: { time: iso(ms), value, tags } });
}

describe('Histo', () => {
  test('quantiles are within ~2% of the exact value', () => {
    const h = new Histo();
    for (let i = 1; i <= 10_000; i++) h.add(i);
    expect(h.n).toBe(10_000);
    expect(h.quantile(0.5)!).toBeCloseTo(5000, -2);
    expect(Math.abs(h.quantile(0.95)! - 9500) / 9500).toBeLessThan(0.02);
    expect(Math.abs(h.quantile(0.99)! - 9900) / 9900).toBeLessThan(0.02);
    expect(h.stats().max).toBe(10_000);
    expect(h.stats().min).toBe(1);
  });

  test('merge and JSON round-trip keep the counts and quantiles', () => {
    const a = Histo.of([1, 2, 3, 4, 5]);
    const b = Histo.from(JSON.parse(JSON.stringify(Histo.of([100, 200]).toJSON())));
    a.merge(b);
    expect(a.n).toBe(7);
    expect(a.stats()).toMatchObject({ min: 1, max: 200 });
    expect(Math.abs(a.quantile(0.99)! - 200) / 200).toBeLessThan(0.02);
    expect(Histo.from(new Histo().toJSON()).stats().min).toBeNull();
  });

  test('empty histogram returns nulls', () => {
    expect(new Histo().quantile(0.5)).toBeNull();
    expect(new Histo().stats().p95).toBeNull();
  });
});

/** Aggregator feeding a one-worker Timeline, the way a normal run is wired. */
function local() {
  const buckets: Bucket[] = [];
  const tl = new Timeline(1, (b) => buckets.push(b));
  const agg = new Aggregator((s) => tl.add(0, s));
  const flush = (final = false) => {
    agg.flush(final);
    tl.flush(final);
  };
  return { agg, tl, buckets, flush };
}

describe('Aggregator', () => {
  test('buckets per second, per-step stats and summary', () => {
    const { agg, tl, buckets, flush } = local();
    const tags = { flow: 'Shop', step: 'Home', status: '200' };
    // ignored lines: metric definitions and unrelated metrics
    agg.line(JSON.stringify({ type: 'Metric', data: { name: 'vus' }, metric: 'vus' }));
    agg.line(point('http_req_waiting', 0, 5));
    // second 0: 3 requests, one failed
    agg.line(point('vus', 0, 10));
    for (const [ms, d] of [[100, 10], [200, 20], [300, 30]]) agg.line(point('http_req_duration', ms, d, tags));
    agg.line(point('http_req_failed', 300, 1, tags));
    agg.line(point('http_req_failed', 200, 0, tags));
    agg.line(point('iterations', 400, 1));
    // second 1: 1 request on another step with a 404
    agg.line(point('http_req_duration', 1500, 100, { flow: 'Shop', step: 'Cart', status: '404' }));
    agg.line(point('checks', 1500, 0, { check: 'Cart: status 200' }));
    agg.line(point('flow_aborted', 1600, 1, { flow: 'Shop', step: 'Cart' }));

    flush(true);
    expect(buckets.map((b) => b.t)).toEqual([0, 1]);
    expect(buckets[0]).toMatchObject({ rps: 3, vus: 10, iters: 1, p50: 20, max: 30 });
    expect(buckets[0].err_rate).toBeCloseTo(1 / 3);
    expect(buckets[1]).toMatchObject({ rps: 1, vus: 10, checks_fail: 1 });

    const s = agg.summary(2, tl.peak);
    expect(s.requests).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.steps.map((x) => x.step).sort()).toEqual(['Cart', 'Home']);
    expect(s.statuses).toContainEqual({ key: '404', count: 1 });
    expect(s.abortedAt).toEqual([{ key: 'Shop → Cart', count: 1 }]);
    expect(s.checks).toEqual([{ name: 'Cart: status 200', pass: 0, fail: 1 }]);
  });

  test('flush waits for late data unless final', () => {
    const { agg, buckets, flush } = local();
    for (let s = 0; s < 5; s++) agg.line(point('http_req_duration', s * 1000 + 10, 5));
    flush(); // default 2 s lag → seconds 0..2
    expect(buckets.map((b) => b.t)).toEqual([0, 1, 2]);
    flush(true);
    expect(buckets.map((b) => b.t)).toEqual([0, 1, 2, 3, 4]);
  });

  test('window() reports rolling rps, p95 and error rate', () => {
    const { agg, tl, flush } = local();
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 10; i++) agg.line(point('http_req_duration', s * 1000 + i, s < 5 ? 10 : 500));
      agg.line(point('http_req_failed', s * 1000, s >= 5 ? 1 : 0));
    }
    flush(true);
    const w = tl.window(5)!;
    expect(w.rps).toBe(10);
    expect(w.p95).toBe(500);
    expect(w.errRate).toBeCloseTo(0.1);
    expect(tl.window(50)).toBeNull();
  });
});

describe('distributed runs', () => {
  /** Two workers, each with its own Aggregator; worker 2's slices travel in wire form like over Redis. */
  function twoWorkers() {
    const buckets: Bucket[] = [];
    const tl = new Timeline(2, (b) => buckets.push(b));
    const lead = new Aggregator((s) => tl.add(0, s));
    const helper = new Aggregator((s) => tl.add(1, JSON.parse(JSON.stringify(sliceToWire(s)))));
    lead.startMs = helper.startMs = T0;
    return { buckets, tl, lead, helper };
  }

  test('a second is emitted once both workers reported it, with summed counts and VUs', () => {
    const { buckets, tl, lead, helper } = twoWorkers();
    for (let s = 0; s < 4; s++) {
      lead.line(point('vus', s * 1000, 5));
      helper.line(point('vus', s * 1000, 5));
      for (let i = 0; i < 10; i++) lead.line(point('http_req_duration', s * 1000 + i, 10));
      for (let i = 0; i < 10; i++) helper.line(point('http_req_duration', s * 1000 + i, 1000));
    }
    lead.flush(true);
    tl.flush();
    expect(buckets).toHaveLength(0); // the helper hasn't reported yet
    helper.flush(true);
    tl.flush();
    expect(buckets.map((b) => b.t)).toEqual([0, 1, 2, 3]);
    expect(buckets[0]).toMatchObject({ rps: 20, vus: 10 });
    expect(Math.abs(buckets[0].p95! - 1000) / 1000).toBeLessThan(0.02);
    expect(buckets[0].p50).toBeLessThan(20);
    expect(tl.window(4)!.rps).toBe(20);
    expect(tl.peak).toEqual({ rps: 20, vus: 10 });
  });

  test('a silent worker holds seconds back only for a few seconds', () => {
    const { buckets, tl, lead } = twoWorkers();
    for (let s = 0; s < 10; s++) lead.line(point('http_req_duration', s * 1000, 5));
    lead.flush(true);
    tl.flush(); // seconds 0..4 are 5+ s behind the newest one
    expect(buckets.map((b) => b.t)).toEqual([0, 1, 2, 3, 4]);
    tl.finish(1);
    tl.flush();
    expect(buckets).toHaveLength(10);
  });

  test('merged state adds up totals, steps and checks', () => {
    const { lead, helper } = twoWorkers();
    const tags = { flow: 'Shop', step: 'Home', status: '200' };
    lead.line(point('http_req_duration', 10, 10, tags));
    helper.line(point('http_req_duration', 20, 30, tags));
    helper.line(point('http_req_failed', 20, 1, tags));
    helper.line(point('checks', 20, 0, { check: 'ok' }));
    lead.line(point('checks', 10, 1, { check: 'ok' }));
    const live = lead.stepsSnapshot([helper.stepsState()]);
    expect(live).toMatchObject([{ step: 'Home', count: 2, fails: 1 }]);
    expect(lead.stepsSnapshot()[0].count).toBe(1); // a live snapshot doesn't change the lead's own state
    lead.mergeState(JSON.parse(JSON.stringify(helper.exportState())));
    const s = lead.summary(1, { rps: 2, vus: 2 });
    expect(s).toMatchObject({ requests: 2, failed: 1, maxVus: 2 });
    expect(s.checks).toEqual([{ name: 'ok', pass: 1, fail: 1 }]);
    expect(s.steps[0]).toMatchObject({ count: 2, fails: 1 });
  });
});

describe('browser steps', () => {
  test('join the step table and blocked hosts, but stay out of the request totals', () => {
    const agg = new Aggregator(() => {});
    const t = { flow: 'UI', step: 'Home' };
    agg.line(point('browser_step_duration', 100, 420, t));
    agg.line(point('browser_step_duration', 1100, 380, t));
    agg.line(point('browser_step_failed', 1100, 1, t));
    agg.line(point('browser_blocked', 1200, 2, { host: 'cdn.example.net' }));
    const other = new Aggregator(() => {});
    other.line(point('browser_blocked', 300, 1, { host: 'cdn.example.net' }));
    agg.mergeState(other.exportState());
    const s = agg.summary(2, { rps: 0, vus: 1 });
    expect(s.requests).toBe(0);
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ flow: 'UI', step: 'Home', count: 2, fails: 1 });
    expect(s.blockedHosts).toEqual([{ key: 'cdn.example.net', count: 3 }]);
  });
});
