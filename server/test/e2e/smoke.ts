// End-to-end smoke test against a running stack (see docker-compose.ci.yml).
//   BASE_URL=http://localhost:8080 TARGET_URL=http://target ADMIN_EMAIL=… ADMIN_PASSWORD=… bun test/e2e/smoke.ts
const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const TARGET = process.env.TARGET_URL ?? 'http://target';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';

let cookie = '';

async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

async function ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await call<T>(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function waitRun(id: string, until: string[], timeoutSec = 180) {
  const end = Date.now() + timeoutSec * 1000;
  while (Date.now() < end) {
    const r = await ok(`GET`, `/api/runs/${id}`);
    if (until.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`run ${id} did not reach ${until.join('/')} in ${timeoutSec}s`);
}

const steps: [string, () => Promise<void>][] = [];
const step = (name: string, fn: () => Promise<void>) => steps.push([name, fn]);
const ctx: Record<string, any> = {};

step('health', async () => {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/api/health`).catch(() => null);
    if (r?.ok) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('API not healthy');
});

step('anonymous access is rejected; public sign-up is disabled', async () => {
  assert((await call('GET', '/api/me')).status === 401, '/api/me without session must be 401');
  assert((await call('POST', '/api/auth/sign-up/email', { email: 'x@example.com', password: 'xxxxxxxxxxxx', name: 'x' })).status === 403, 'sign-up must be 403');
});

step('password reset does not reveal unknown accounts', async () => {
  const r = await call('POST', '/api/auth/request-password-reset', { email: 'nobody@example.com', redirectTo: '/reset-password' });
  assert(r.status === 200, `reset request for unknown e-mail must look successful (${r.status})`);
});

step('sign in', async () => {
  await ok('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  const me = await ok('GET', '/api/me');
  assert(me.user.email === EMAIL, 'signed-in user');
});

step('create site and workflow', async () => {
  ctx.site = await ok('POST', '/api/sites', { name: `CI target ${Date.now()}`, baseUrl: TARGET });
  ctx.wf = await ok('POST', '/api/workflows', {
    name: 'CI browse',
    siteId: ctx.site.id,
    status: 'active',
    definition: {
      steps: [
        { type: 'page', name: 'Home', url: '/', checks: [{ type: 'status', value: 200 }] },
        { type: 'request', name: 'Missing page', url: '/missing-{{$randomInt 1 9}}', abortOnFail: false, probability: 0.5 },
        { type: 'think', min: 0.1, max: 0.2 },
      ],
    },
  });
  const v = await ok('POST', '/api/workflows/validate', { definition: { steps: [{ type: 'request', name: 'x', url: 'https://evil.example/' }] }, siteId: ctx.site.id });
  assert(v.ok === false, 'foreign host must be rejected');
});

step('debug run records a step trace', async () => {
  const r = await ok('POST', `/api/workflows/${ctx.wf.id}/debug`, { siteId: ctx.site.id });
  const done = await waitRun(r.id, ['completed', 'failed']);
  assert(done.status === 'completed', `debug run status ${done.status}: ${done.error}`);
  assert(done.summary.debug?.[0]?.status === 200, 'first debug step returned 200');
});

step('constant load run completes with metrics', async () => {
  const plan = await ok('POST', '/api/plans', {
    name: 'CI load',
    siteId: ctx.site.id,
    config: { flows: [{ workflowId: ctx.wf.id, weight: 1 }], profile: { kind: 'constant_vus', vus: 5, duration: 10 }, thresholds: { p95Ms: 2000 } },
  });
  const r = await ok('POST', `/api/plans/${plan.id}/start`);
  const done = await waitRun(r.id, ['completed', 'failed', 'stopped']);
  assert(done.status === 'completed', `load run status ${done.status}: ${done.error}`);
  assert(done.summary.requests > 0, 'requests were made');
  assert(done.thresholdsPassed === true, 'thresholds passed');
  const metrics = await ok<any[]>('GET', `/api/runs/${r.id}/metrics`);
  assert(metrics.length >= 5, `per-second metrics stored (${metrics.length})`);
});

step('a running test can be stopped', async () => {
  const plan = await ok('POST', '/api/plans', {
    name: 'CI stop',
    siteId: ctx.site.id,
    config: { flows: [{ workflowId: ctx.wf.id, weight: 1 }], profile: { kind: 'constant_vus', vus: 2, duration: 300 } },
  });
  const r = await ok('POST', `/api/plans/${plan.id}/start`);
  await waitRun(r.id, ['running']);
  await new Promise((res) => setTimeout(res, 3000));
  await ok('POST', `/api/runs/${r.id}/stop`);
  const done = await waitRun(r.id, ['stopped', 'completed', 'failed'], 60);
  assert(done.status === 'stopped', `stopped status ${done.status}`);
});

step('a run split across two workers merges their results', async () => {
  const plan = await ok('POST', '/api/plans', {
    name: 'CI distributed',
    siteId: ctx.site.id,
    config: { flows: [{ workflowId: ctx.wf.id, weight: 1 }], profile: { kind: 'constant_vus', vus: 4, duration: 10 }, options: { workers: 2 } },
  });
  // the second worker's heartbeat may still be on its way
  let r: any = null;
  for (let i = 0; i < 30 && !r; i++) {
    const res = await call('POST', `/api/plans/${plan.id}/start`);
    if (res.status === 200 || res.status === 201) r = res.data;
    else if (res.status === 409) await new Promise((res) => setTimeout(res, 2000));
    else throw new Error(`start: ${res.status} ${JSON.stringify(res.data)}`);
  }
  assert(r, 'two workers came online');
  const done = await waitRun(r.id, ['completed', 'failed', 'stopped']);
  assert(done.status === 'completed', `distributed run status ${done.status}: ${done.error}`);
  assert(done.shards === 2 && done.summary.workers?.length === 2, 'both workers reported');
  assert(done.summary.workers.every((w: any) => w.requests > 0), 'every worker sent requests');
  assert(done.summary.requests === done.summary.workers.reduce((a: number, w: any) => a + w.requests, 0), 'totals add up');
  assert(done.summary.maxVus === 4, `VUs summed across workers (${done.summary.maxVus})`);
});

// needs the Chromium worker (docker-compose.yml: worker-browser), so only when one is configured
if (Number(process.env.BROWSER_WORKER_REPLICAS ?? 0) > 0) {
  step('a browser workflow runs in Chromium', async () => {
    const wf = await ok('POST', '/api/workflows', {
      name: 'CI browser',
      siteId: ctx.site.id,
      status: 'active',
      definition: {
        engine: 'browser',
        steps: [
          { type: 'goto', name: 'Home', url: '/' },
          { type: 'read', name: 'Title', selector: 'h1', var: 'title', required: true },
          { type: 'expect', name: 'Heading shown', selector: 'h1', textContains: '{{title}}' },
        ],
      },
    });
    let r: any = null;
    for (let i = 0; i < 30 && !r; i++) {
      const res = await call('POST', `/api/workflows/${wf.id}/debug`, { siteId: ctx.site.id });
      if (res.status === 200 || res.status === 201) r = res.data;
      else if (res.status === 409) await new Promise((res) => setTimeout(res, 2000));
      else throw new Error(`debug: ${res.status} ${JSON.stringify(res.data)}`);
    }
    assert(r, 'a browser worker came online');
    const done = await waitRun(r.id, ['completed', 'failed']);
    assert(done.status === 'completed', `browser run status ${done.status}: ${done.error}`);
    const trace = done.summary.debug ?? [];
    assert(trace.length === 3 && trace.every((e: any) => e.ok), `every browser step passed: ${JSON.stringify(trace)}`);
    assert(trace[0].method === 'GOTO' && trace[0].status === 200, 'the page loaded');
  });
}

step('MCP server lists tools with an API key', async () => {
  const token = await ok('POST', '/api/tokens', { name: 'ci' });
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await res.json();
  assert(res.status === 200 && body.result.tools.length > 10, `MCP tools/list (${res.status})`);
  await ok('DELETE', `/api/tokens/${token.id}`);
  const denied = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token.token}` } });
  assert(denied.status === 401, 'revoked key is rejected');
});

let failed = 0;
for (const [name, fn] of steps) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}\n  ${(err as Error).message}`);
    break;
  }
}
process.exit(failed ? 1 : 0);
