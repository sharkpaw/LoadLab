import { describe, expect, test } from 'bun:test';
import { CompileError, buildScenario, compileRun, hostAllowed, inlineIncludes, siteHosts, type SiteRow, type WorkflowRow } from '../src/lib/compiler';

const site: SiteRow = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Shop',
  baseUrl: 'https://shop.example.com/',
  allowedHosts: ['api.example.com', '*.cdn.example.com'],
  headers: {},
  variables: {},
  datasets: {},
};

const ID = {
  main: '11111111-1111-4111-8111-111111111111',
  login: '22222222-2222-4222-8222-222222222222',
  loopA: '33333333-3333-4333-8333-333333333333',
  loopB: '44444444-4444-4444-8444-444444444444',
};

const workflows: Record<string, WorkflowRow> = {
  [ID.main]: {
    id: ID.main,
    name: 'Checkout',
    status: 'active',
    definition: { steps: [{ type: 'page', name: 'Home', url: '/' }, { type: 'include', workflowId: ID.login }, { type: 'think', min: 1, max: 2 }] },
  },
  [ID.login]: { id: ID.login, name: 'Sign in', status: 'active', definition: { variables: { user: 'a' }, steps: [{ type: 'request', name: 'Login', method: 'POST', url: '/api/login' }] } },
  [ID.loopA]: { id: ID.loopA, name: 'A', status: 'active', definition: { steps: [{ type: 'include', workflowId: ID.loopB }] } },
  [ID.loopB]: { id: ID.loopB, name: 'B', status: 'active', definition: { steps: [{ type: 'include', workflowId: ID.loopA }] } },
};
const load = async (id: string) => workflows[id] ?? null;

describe('host allowlist', () => {
  test('exact hosts and wildcards', () => {
    const allowed = siteHosts(site);
    expect(allowed).toEqual(['shop.example.com', 'api.example.com', '*.cdn.example.com']);
    expect(hostAllowed('api.example.com', allowed)).toBe(true);
    expect(hostAllowed('img.cdn.example.com', allowed)).toBe(true);
    expect(hostAllowed('cdn.example.com', allowed)).toBe(true);
    expect(hostAllowed('evil.com', allowed)).toBe(false);
    expect(hostAllowed('example.com', allowed)).toBe(false);
  });
});

describe('inlineIncludes', () => {
  test('replaces include with a group carrying the module variables', async () => {
    const steps = await inlineIncludes(workflows[ID.main].definition.steps, load);
    expect(steps[1]).toMatchObject({ type: 'group', name: 'Sign in' });
    const group = steps[1] as any;
    expect(group.steps[0]).toEqual({ type: 'set', vars: { user: 'a' } });
    expect(group.steps[1]).toMatchObject({ type: 'request', name: 'Login' });
  });

  test('detects include cycles', async () => {
    await expect(inlineIncludes(workflows[ID.loopA].definition.steps, load, [ID.loopA])).rejects.toBeInstanceOf(CompileError);
  });
});

describe('buildScenario', () => {
  test('maps profiles to k6 executors', () => {
    expect(buildScenario({ kind: 'constant_vus', vus: 5, duration: 30 }, 10).scenario).toMatchObject({ executor: 'constant-vus', vus: 5, duration: '30s' });
    expect(buildScenario({ kind: 'constant_rate', rate: 2.5, duration: 60 }, 10).scenario).toMatchObject({ executor: 'constant-arrival-rate', rate: 150, timeUnit: '1m' });
    const ramp = buildScenario({ kind: 'stress', vus: 100 }, 10);
    expect(ramp.scenario.executor).toBe('ramping-vus');
    expect(ramp.peakVus).toBe(100);
    const bp = buildScenario({ kind: 'breakpoint', startRate: 1, maxRate: 200, duration: 300, maxVUs: 400 }, 10);
    expect(bp.scenario).toMatchObject({ executor: 'ramping-arrival-rate', startRate: 1, stages: [{ duration: '300s', target: 200 }] });
    expect(bp.arrival).toBe(true);
  });

  test('enforces server limits', () => {
    expect(() => buildScenario({ kind: 'constant_vus', vus: 10_000_000, duration: 10 }, 10)).toThrow(CompileError);
  });
});

describe('compileRun', () => {
  test('produces runner config with flows, thresholds and options', async () => {
    const { runner } = await compileRun(site, { flows: [{ workflowId: ID.main, weight: 3 }], profile: { kind: 'smoke' }, thresholds: { p95Ms: 500, errorRate: 0.01 } }, load);
    expect(runner.baseUrl).toBe('https://shop.example.com');
    expect(runner.flows).toHaveLength(1);
    expect(runner.flows[0]).toMatchObject({ name: 'Checkout', weight: 3, resetSession: true });
    expect(runner.options.thresholds).toEqual({ http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.01'] });
    expect(runner.meta.kind).toBe('smoke');
  });

  test('rejects static URLs to hosts outside the allowlist', async () => {
    workflows['55555555-5555-4555-8555-555555555555'] = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Evil',
      status: 'draft',
      definition: { steps: [{ type: 'request', name: 'x', method: 'GET', url: 'https://evil.com/' }] },
    };
    await expect(compileRun(site, { flows: [{ workflowId: '55555555-5555-4555-8555-555555555555', weight: 1 }], profile: { kind: 'smoke' } }, load)).rejects.toBeInstanceOf(CompileError);
  });

  test('breakpoint requires an auto-stop threshold', async () => {
    const cfg = { flows: [{ workflowId: ID.main, weight: 1 }], profile: { kind: 'breakpoint', maxRate: 50 } };
    await expect(compileRun(site, cfg, load)).rejects.toBeInstanceOf(CompileError);
    const ok = await compileRun(site, { ...cfg, autoStop: { p95Ms: 800 } }, load);
    expect(ok.runner.meta.autoStop.enabled).toBe(true);
  });

  test('workers split the run, but never below one VU each; debug stays on one worker', async () => {
    const flows = [{ workflowId: ID.main, weight: 1 }];
    const split = await compileRun(site, { flows, profile: { kind: 'constant_vus', vus: 10 }, options: { workers: 3 } }, load);
    expect(split.runner.meta.shards).toBe(3);
    expect((await compileRun(site, { flows, profile: { kind: 'smoke' } }, load)).runner.meta.shards).toBe(1);
    await expect(compileRun(site, { flows, profile: { kind: 'constant_vus', vus: 2 }, options: { workers: 3 } }, load)).rejects.toBeInstanceOf(CompileError);
    const dbg = await compileRun(site, { flows, profile: { kind: 'debug' }, options: { workers: 4 } }, load);
    expect(dbg.runner.meta.shards).toBe(1);
  });
});
