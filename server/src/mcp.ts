import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireMcpAuth } from '@better-auth/mcp';
import { fromNodeHeaders } from 'better-auth/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './lib/config.js';
import { auth } from './lib/auth.js';
import * as svc from './lib/services.js';
import { PROFILE_KINDS, WORKFLOW_DSL_DOC } from './lib/schemas.js';

const PROFILE_DOC = `
## Test profiles (profile.kind)
- smoke: short sanity check with few VUs { vus:1, duration:60 }
- constant_vus: constant concurrent users { vus, duration }
- constant_rate: constant rate — number of flows (iterations) started per second { rate, duration, preAllocatedVUs?, maxVUs? }
- ramp: gradual load { vus, duration } or stages:[{duration, target}]
- stress: step up beyond capacity { vus } (default stages are generated) or stages
- spike: sudden load spike { vus } or stages
- soak: constant load over a long period { vus, duration }
- breakpoint: breaking point — rate increases linearly from startRate to maxRate, stops when the autoStop threshold is exceeded and
  reports "the system was healthy up to X req/s" { startRate, maxRate, duration, maxVUs? }
  autoStop.p95Ms or autoStop.errorRate is required.
Durations are in seconds. thresholds: { p95Ms, p99Ms, errorRate(0-1), checksRate(0-1) } are the pass/fail criteria.
autoStop: { enabled, p95Ms, errorRate, windowSec(10), graceSec(15) } stops the test when a threshold is exceeded.
`.trim();

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      const err = e as svc.HttpError;
      const details = err.details ? `\n${JSON.stringify(err.details, null, 2)}` : '';
      return { ...text(`Error: ${err.message}${details}`), isError: true };
    }
  };
}

const panel = (p: string) => `${config.publicUrl}${p}`;

const flowsSchema = z.array(z.object({ workflowId: z.string().describe('workflow uuid'), weight: z.number().min(0).default(1).describe('weight (ratio)') })).min(1);
const profileSchema = z
  .object({
    kind: z.enum(PROFILE_KINDS),
    vus: z.number().int().optional(),
    duration: z.number().int().optional().describe('seconds'),
    rate: z.number().optional().describe('iterations/sec (constant_rate)'),
    stages: z.array(z.object({ duration: z.number().int(), target: z.number().int() })).optional(),
    startRate: z.number().optional(),
    maxRate: z.number().optional(),
    preAllocatedVUs: z.number().int().optional(),
    maxVUs: z.number().int().optional(),
  })
  .describe('Load profile');
const thresholdsSchema = z
  .object({ p95Ms: z.number().optional(), p99Ms: z.number().optional(), errorRate: z.number().optional(), checksRate: z.number().optional() })
  .optional();
const autoStopSchema = z
  .object({ enabled: z.boolean().optional(), p95Ms: z.number().optional(), errorRate: z.number().optional(), windowSec: z.number().int().optional(), graceSec: z.number().int().optional() })
  .optional();
const optionsSchema = z
  .object({ httpTimeoutSec: z.number().int().optional(), insecureSkipTLSVerify: z.boolean().optional(), userAgent: z.string().optional(), gracefulStopSec: z.number().int().optional(), workers: z.number().int().optional() })
  .optional();

function planConfig(a: any) {
  return {
    flows: a.flows,
    profile: a.profile,
    thresholds: a.thresholds ?? {},
    autoStop: { enabled: false, windowSec: 10, graceSec: 15, ...(a.autoStop ?? {}) },
    options: a.options ?? {},
  };
}

function trimRun(r: any) {
  const s = r.summary ?? {};
  return {
    id: r.id,
    name: r.name,
    site: r.siteName,
    kind: r.kind,
    status: r.status,
    stopReason: r.stopReason,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    thresholdsPassed: r.thresholdsPassed,
    capacity: r.capacity,
    summary: r.summary
      ? {
          durationSec: s.durationSec,
          requests: s.requests,
          errorRate: s.errorRate,
          rpsAvg: s.rpsAvg,
          rpsPeak: s.rpsPeak,
          maxVus: s.maxVus,
          latencyMs: s.latency,
          steps: s.steps,
          flows: s.flows,
          statuses: s.statuses,
          errorCodes: s.errorCodes,
          abortedAt: s.abortedAt,
          checks: s.checks,
          thresholds: s.thresholds,
          warnings: s.warnings,
          generator: s.generator,
          debugTrace: s.debug,
        }
      : null,
    liveSteps: r.liveSteps,
    panelUrl: panel(`/runs/${r.id}`),
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'loadlab', version: '1.0.0' },
    {
      instructions:
        'LoadLab: a k6-based load-testing platform. First read the workflow DSL and test profiles with get_guide. ' +
        'Create workflows and test plans as DRAFTS; the user reviews them in the panel and clicks "Start". ' +
        'To validate a workflow draft use validate_workflow and debug_workflow (1 user, 1 iteration, detailed trace), ' +
        'then read the step-by-step trace with get_run_results. Use probe_page to learn the site structure.',
    },
  );

  server.registerTool('get_guide', { title: 'DSL and profile guide', description: 'Explains the workflow DSL and test profiles. Call this first.', inputSchema: {} }, wrap(async () => `${WORKFLOW_DSL_DOC}\n\n${PROFILE_DOC}`));

  // --- sites ---
  server.registerTool('list_sites', { title: 'List sites', description: 'Lists registered target sites.', inputSchema: {}, annotations: { readOnlyHint: true } }, wrap(async () => svc.listSites()));

  server.registerTool(
    'get_site',
    { title: 'Site details', description: 'Site details: baseUrl, allowed hosts, variables, datasets.', inputSchema: { siteId: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async ({ siteId }) => svc.getSite(siteId)),
  );

  server.registerTool(
    'create_site',
    {
      title: 'Add site',
      description: 'Registers a new target site. Tests can only send requests to the site\'s baseUrl host and the allowedHosts list.',
      inputSchema: {
        name: z.string(),
        baseUrl: z.string().describe('https://example.com'),
        description: z.string().optional(),
        allowedHosts: z.array(z.string()).optional().describe('additional allowed hosts, e.g. api.example.com or *.example.com'),
        headers: z.record(z.string(), z.string()).optional(),
        variables: z.record(z.string(), z.string()).optional(),
      },
    },
    wrap(async (a) => svc.createSite(a)),
  );

  server.registerTool(
    'probe_page',
    {
      title: 'Probe page',
      description: 'Fetches a page of the site once; returns the title, links, forms (input names) and a JSON preview. Use it to find selectors and paths when designing workflows.',
      inputSchema: { siteId: z.string(), path: z.string().describe('/ or /products or a full URL') },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ siteId, path }) => svc.probeSite(siteId, path)),
  );

  // --- workflows ---
  server.registerTool(
    'list_workflows',
    { title: 'List workflows', description: 'Lists workflows (site-specific + shared modules).', inputSchema: { siteId: z.string().optional(), status: z.enum(['draft', 'active', 'archived']).optional() }, annotations: { readOnlyHint: true } },
    wrap(async (a) => (await svc.listWorkflows(a)).map((w) => ({ id: w.id, name: w.name, status: w.status, siteId: w.siteId, site: w.siteName ?? '(shared module)', description: w.description, version: w.version, steps: w.definition?.steps?.length }))),
  );

  server.registerTool('get_workflow', { title: 'Workflow details', description: 'Returns the workflow definition (steps).', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, wrap(async ({ id }) => svc.getWorkflow(id)));

  server.registerTool(
    'validate_workflow',
    { title: 'Validate workflow', description: 'Validates a workflow definition without saving it (schema, includes, host permissions).', inputSchema: { definition: z.any().describe('workflow definition { steps: [...] }'), siteId: z.string().optional() }, annotations: { readOnlyHint: true } },
    wrap(async ({ definition, siteId }) => {
      const r = await svc.validateWorkflow(definition, siteId);
      return { ok: r.ok, errors: r.errors, warnings: r.warnings, requestCount: r.requestCount };
    }),
  );

  server.registerTool(
    'create_workflow_draft',
    {
      title: 'Create workflow draft',
      description: 'Saves a new workflow as a DRAFT. Without a siteId it becomes a shared module usable on all sites (e.g. "Log in").',
      inputSchema: { name: z.string(), description: z.string().optional(), siteId: z.string().optional(), definition: z.any().describe('{ variables?, resetSession?, steps: [...] }'), tags: z.array(z.string()).optional() },
    },
    wrap(async (a) => {
      const w = await svc.createWorkflow(a as any, 'mcp');
      return { id: w.id, name: w.name, status: w.status, panelUrl: panel(`/workflows/${w.id}`) };
    }),
  );

  server.registerTool(
    'update_workflow_draft',
    { title: 'Update workflow draft', description: 'Updates a draft workflow (a new version is saved). For active workflows, use duplicate_workflow first.', inputSchema: { id: z.string(), name: z.string().optional(), description: z.string().optional(), definition: z.any().optional(), tags: z.array(z.string()).optional() } },
    wrap(async ({ id, ...patch }) => {
      const w = await svc.updateWorkflow(id, patch as any, 'mcp');
      return { id: w.id, name: w.name, status: w.status, version: w.version, panelUrl: panel(`/workflows/${w.id}`) };
    }),
  );

  server.registerTool(
    'duplicate_workflow',
    { title: 'Duplicate workflow', description: 'Creates a draft copy of an existing workflow.', inputSchema: { id: z.string(), name: z.string().optional() } },
    wrap(async ({ id, name }) => {
      const w = await svc.duplicateWorkflow(id, 'mcp', name);
      return { id: w.id, name: w.name, status: w.status, panelUrl: panel(`/workflows/${w.id}`) };
    }),
  );

  server.registerTool(
    'debug_workflow',
    {
      title: 'Workflow debug run',
      description: 'Runs the workflow with 1 virtual user for 1-5 iterations and records each step\'s status code, duration, extracted variables and body preview. Read it with get_run_results after a few seconds.',
      inputSchema: { workflowId: z.string(), siteId: z.string(), iterations: z.number().int().min(1).max(5).optional() },
    },
    wrap(async ({ workflowId, siteId, iterations }) => {
      if (!config.mcpAllowDebug) throw new svc.HttpError(403, 'Debug runs are disabled for MCP (MCP_ALLOW_DEBUG=false)');
      return svc.debugWorkflow(workflowId, siteId, iterations ?? 1);
    }),
  );

  // --- test plans ---
  server.registerTool(
    'list_test_plans',
    { title: 'Test plans', description: 'Lists test plans.', inputSchema: { siteId: z.string().optional(), status: z.enum(['draft', 'ready']).optional() }, annotations: { readOnlyHint: true } },
    wrap(async (a) => svc.listPlans(a)),
  );

  server.registerTool('get_test_plan', { title: 'Test plan', description: 'Test plan details.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, wrap(async ({ id }) => svc.getPlan(id)));

  server.registerTool(
    'preview_test_plan',
    { title: 'Preview plan', description: 'Compiles a plan configuration without saving it; returns estimated duration, peak VUs and errors.', inputSchema: { siteId: z.string(), flows: flowsSchema, profile: profileSchema, thresholds: thresholdsSchema, autoStop: autoStopSchema, options: optionsSchema }, annotations: { readOnlyHint: true } },
    wrap(async (a) => {
      const r: any = await svc.previewPlan(a.siteId, planConfig(a));
      return { ok: r.ok, errors: r.errors, meta: r.meta, flows: r.flows, scenario: r.options?.scenarios };
    }),
  );

  server.registerTool(
    'create_test_plan_draft',
    {
      title: 'Create test plan draft',
      description: 'Creates a DRAFT test plan for a site, workflow mix and load profile. The user reviews and starts it from the panel.',
      inputSchema: { name: z.string(), siteId: z.string(), flows: flowsSchema, profile: profileSchema, thresholds: thresholdsSchema, autoStop: autoStopSchema, options: optionsSchema, notes: z.string().optional().describe('notes for the user') },
    },
    wrap(async (a) => {
      const p = await svc.createPlan({ name: a.name, siteId: a.siteId, notes: a.notes, config: planConfig(a) }, 'mcp');
      return { id: p.id, name: p.name, status: p.status, panelUrl: panel(`/plans/${p.id}`), message: 'Draft created. Review it in the panel and run it with "Start".' };
    }),
  );

  server.registerTool(
    'update_test_plan_draft',
    {
      title: 'Update test plan draft',
      description: 'Updates a draft test plan. If configuration fields are given, they are revalidated together.',
      inputSchema: { id: z.string(), name: z.string().optional(), notes: z.string().optional(), flows: flowsSchema.optional(), profile: profileSchema.optional(), thresholds: thresholdsSchema, autoStop: autoStopSchema, options: optionsSchema },
    },
    wrap(async (a) => {
      const cur = await svc.getPlan(a.id);
      const changed = a.flows || a.profile || a.thresholds || a.autoStop || a.options;
      const cfg = changed
        ? planConfig({ flows: a.flows ?? cur.config.flows, profile: a.profile ?? cur.config.profile, thresholds: a.thresholds ?? cur.config.thresholds, autoStop: a.autoStop ?? cur.config.autoStop, options: a.options ?? cur.config.options })
        : undefined;
      const p = await svc.updatePlan(a.id, { name: a.name, notes: a.notes, config: cfg }, 'mcp');
      return { id: p.id, name: p.name, status: p.status, panelUrl: panel(`/plans/${p.id}`) };
    }),
  );

  server.registerTool(
    'start_test_plan',
    { title: 'Start test', description: 'Starts a test plan (if MCP_ALLOW_RUN=true on the server). Otherwise returns the panel link.', inputSchema: { id: z.string() } },
    wrap(async ({ id }) => {
      if (!config.mcpAllowRun) {
        return { started: false, message: 'Starting tests via MCP is disabled. Please start it from the panel.', panelUrl: panel(`/plans/${id}`) };
      }
      return { started: true, run: await svc.startPlan(id, 'mcp') };
    }),
  );

  // --- runs ---
  server.registerTool(
    'list_runs',
    { title: 'Runs', description: 'Lists test runs. status=active returns the running ones.', inputSchema: { siteId: z.string().optional(), planId: z.string().optional(), status: z.string().optional(), limit: z.number().int().optional() }, annotations: { readOnlyHint: true } },
    wrap(async (a) => svc.listRuns({ ...a, limit: a.limit ?? 20 })),
  );

  server.registerTool(
    'get_run_results',
    { title: 'Run results', description: 'Returns a run\'s summary, per-step latencies, error breakdown, capacity (breakpoint) result and debug trace.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async ({ id }) => trimRun(await svc.getRun(id))),
  );

  server.registerTool(
    'get_run_timeseries',
    { title: 'Run time series', description: 'Per-second metrics (vus, rps, p95, error rate). Downsample long tests with step.', inputSchema: { id: z.string(), step: z.number().int().min(1).optional().describe('one point every N seconds') }, annotations: { readOnlyHint: true } },
    wrap(async ({ id, step }) => {
      const m = await svc.runMetricsList(id);
      const k = step ?? Math.max(1, Math.ceil(m.length / 120));
      return m.filter((_, i) => i % k === 0).map((r: any) => ({ t: r.t, vus: r.vus, rps: r.rps, p95: r.p95, p99: r.p99, errRate: r.err_rate }));
    }),
  );

  server.registerTool('stop_run', { title: 'Stop test', description: 'Stops a running or queued test.', inputSchema: { id: z.string() } }, wrap(async ({ id }) => svc.stopRun(id)));

  server.registerTool(
    'compare_runs',
    { title: 'Compare runs', description: 'Compares two runs\' key metrics and percentage difference (a=before, b=after).', inputSchema: { a: z.string(), b: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async ({ a, b }) => {
      const c = await svc.compareRuns(a, b);
      return { a: { id: c.a.id, name: c.a.name, createdAt: c.a.createdAt, kpi: c.a.kpi }, b: { id: c.b.id, name: c.b.name, createdAt: c.b.createdAt, kpi: c.b.kpi }, deltaPct: c.deltaPct };
    }),
  );

  server.registerTool(
    'get_site_benchmark',
    { title: 'Site benchmark', description: 'The site\'s test history: p95, rps, error rate, capacity trend.', inputSchema: { siteId: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async ({ siteId }) => {
      const b = await svc.siteBenchmark(siteId);
      return { site: b.site.name, best: b.best, baseline: b.baseline?.id ?? null, runs: b.runs.slice(0, 50).map((r) => ({ id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, p95: r.latency?.p95, rpsAvg: r.rpsAvg, errorRate: r.errorRate, capacityRps: r.capacity?.maxHealthy?.rps ?? null })) };
    }),
  );

  server.registerTool('get_system_status', { title: 'System status', description: 'LoadLab\'s own resource usage: worker CPU/RAM, Postgres/Redis size, disk.', inputSchema: {}, annotations: { readOnlyHint: true } }, wrap(async () => svc.systemStatus()));

  return server;
}

/**
 * OAuth 2.1 guard: verifies an access token issued by our own authorization server (signature via JWKS,
 * issuer, audience = this /mcp resource, expiry). Unauthenticated requests get the RFC 9728
 * WWW-Authenticate challenge so MCP clients can discover the sign-in flow on their own.
 */
const oauthGuard = config.mcpOAuth
  ? requireMcpAuth(auth, async () => new Response(null, { status: 204 }), {
      resource: config.mcpResource,
      // fetch the keys over loopback instead of the public URL (no hairpin through the proxy)
      jwksUrl: `http://127.0.0.1:${config.port}/api/auth/jwks`,
    })
  : null;

async function forward(reply: FastifyReply, res: Response) {
  reply.code(res.status);
  res.headers.forEach((v, k) => {
    if (k !== 'content-length') reply.header(k, v);
  });
  return reply.send((await res.text()) || null);
}

const unauthorized = (message: string) => ({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

export function registerMcp(app: FastifyInstance) {
  app.all('/mcp', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const queryToken = String((req.query as Record<string, unknown>)?.token ?? '');
    // API keys (ll_… or MCP_TOKEN) and OAuth access tokens are both accepted; the user picks one per client
    const apiKey = queryToken || (bearer.startsWith('ll_') || (config.mcpToken && bearer === config.mcpToken) ? bearer : '');
    if (apiKey) {
      if (!(await svc.verifyToken(apiKey))) return reply.code(401).send(unauthorized('Invalid API key'));
    } else if (oauthGuard) {
      const res = await oauthGuard(new Request(config.mcpResource, { method: req.method, headers: fromNodeHeaders(req.headers) }));
      if (res.status !== 204) return forward(reply, res);
    } else {
      return reply.code(401).send(unauthorized('Unauthorized: an API key is required (Authorization: Bearer ll_...)'));
    }
    if (req.method !== 'POST') {
      return reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Stateless MCP server: POST only' }, id: null });
    }
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
