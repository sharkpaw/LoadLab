import { describe, expect, test } from 'bun:test';
import { Aggregator, Histo, type Bucket } from '../src/worker/aggregator';

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

  test('empty histogram returns nulls', () => {
    expect(new Histo().quantile(0.5)).toBeNull();
    expect(new Histo().stats().p95).toBeNull();
  });
});

describe('Aggregator', () => {
  test('buckets per second, per-step stats and summary', () => {
    const buckets: Bucket[] = [];
    const agg = new Aggregator((b) => buckets.push(b));
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

    agg.flush(true);
    expect(buckets.map((b) => b.t)).toEqual([0, 1]);
    expect(buckets[0]).toMatchObject({ rps: 3, vus: 10, iters: 1, p50: 20, max: 30 });
    expect(buckets[0].err_rate).toBeCloseTo(1 / 3);
    expect(buckets[1]).toMatchObject({ rps: 1, vus: 10, checks_fail: 1 });

    const s = agg.summary(2);
    expect(s.requests).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.steps.map((x) => x.step).sort()).toEqual(['Cart', 'Home']);
    expect(s.statuses).toContainEqual({ key: '404', count: 1 });
    expect(s.abortedAt).toEqual([{ key: 'Shop → Cart', count: 1 }]);
    expect(s.checks).toEqual([{ name: 'Cart: status 200', pass: 0, fail: 1 }]);
  });

  test('flush waits for late data unless final', () => {
    const buckets: Bucket[] = [];
    const agg = new Aggregator((b) => buckets.push(b));
    for (let s = 0; s < 5; s++) agg.line(point('http_req_duration', s * 1000 + 10, 5));
    agg.flush(); // default 2 s lag → seconds 0..2
    expect(buckets.map((b) => b.t)).toEqual([0, 1, 2]);
    agg.flush(true);
    expect(buckets.map((b) => b.t)).toEqual([0, 1, 2, 3, 4]);
  });

  test('window() reports rolling rps, p95 and error rate', () => {
    const agg = new Aggregator(() => {});
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 10; i++) agg.line(point('http_req_duration', s * 1000 + i, s < 5 ? 10 : 500));
      agg.line(point('http_req_failed', s * 1000, s >= 5 ? 1 : 0));
    }
    agg.flush(true);
    const w = agg.window(5)!;
    expect(w.rps).toBe(10);
    expect(w.p95).toBe(500);
    expect(w.errRate).toBeCloseTo(0.1);
    expect(agg.window(50)).toBeNull();
  });
});
