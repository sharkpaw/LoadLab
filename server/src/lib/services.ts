import crypto from 'node:crypto';
import fs from 'node:fs';
import { CronExpressionParser } from 'cron-parser';
import { and, asc, count, desc, eq, getTableColumns, inArray, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { config } from './config.js';
import { db, pool } from './db.js';
import { keys, redis } from './redis.js';
import { ACTIVE_RUN_STATUSES, LIVE_RUN_STATUSES, apiTokens, runMetrics, runs, settings, sites, testPlans, workflowVersions, workflows } from '../db/schema.js';
import {
  CompileError,
  compileRun,
  countRequests,
  checkStaticHosts,
  hostAllowed,
  inlineIncludes,
  parseWorkflowDefinition,
  siteHosts,
  type SiteRow,
  type WorkflowRow,
} from './compiler.js';
import { formatZodError, SiteInputSchema, type PlanConfig, type SiteInput } from './schemas.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`);
}

function asUuid(id: string, what = 'record'): string {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) notFound(what);
  return id;
}

export const PROFILE_LABELS: Record<string, string> = {
  smoke: 'Smoke test',
  constant_vus: 'Constant users',
  constant_rate: 'Constant rate',
  ramp: 'Ramp-up',
  stress: 'Stress',
  spike: 'Spike',
  soak: 'Soak',
  breakpoint: 'Breakpoint',
  debug: 'Debug run',
};

const now = () => new Date();
const olderThanDays = (col: typeof runs.finishedAt, days: number) => lt(col, sql`now() - make_interval(days => ${days})`);

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export async function listSites() {
  return db
    .select({
      ...getTableColumns(sites),
      workflowCount: db.$count(workflows, and(eq(workflows.siteId, sites.id), ne(workflows.status, 'archived'))),
      runCount: db.$count(runs, eq(runs.siteId, sites.id)),
      // drizzle doesn't qualify columns in single-table selects; the outer table is written explicitly in the correlated subquery
      lastRunAt: sql<Date | null>`(SELECT max(r.created_at) FROM runs r WHERE r.site_id = "sites"."id")`,
    })
    .from(sites)
    .orderBy(asc(sites.name));
}

async function siteRow(id: string): Promise<SiteRow & typeof sites.$inferSelect> {
  const [r] = await db.select().from(sites).where(eq(sites.id, asUuid(id, 'site'))).limit(1);
  if (!r) notFound('Site');
  return r;
}

export const getSite = siteRow;

function parseSite(input: unknown): SiteInput {
  const r = SiteInputSchema.safeParse(input);
  if (!r.success) throw new HttpError(400, 'Invalid site', formatZodError(r.error));
  return r.data;
}

function siteValues(s: SiteInput) {
  return {
    name: s.name,
    baseUrl: s.baseUrl.replace(/\/$/, ''),
    description: s.description ?? '',
    allowedHosts: s.allowedHosts ?? [],
    headers: s.headers ?? {},
    variables: s.variables ?? {},
    datasets: s.datasets ?? {},
  };
}

export async function createSite(input: unknown) {
  const [r] = await db.insert(sites).values(siteValues(parseSite(input))).returning();
  return r;
}

export async function updateSite(id: string, input: unknown) {
  const cur = await siteRow(id);
  const s = parseSite({ ...cur, ...(input as object) });
  const [r] = await db
    .update(sites)
    .set({ ...siteValues(s), updatedAt: now() })
    .where(eq(sites.id, id))
    .returning();
  return r;
}

export async function deleteSite(id: string) {
  const busy = await db.$count(runs, and(eq(runs.siteId, asUuid(id)), inArray(runs.status, ACTIVE_RUN_STATUSES)));
  if (busy) throw new HttpError(409, 'A test is running on this site; stop it first');
  await db.delete(sites).where(eq(sites.id, id));
  return { ok: true };
}

const summaryNum = (key: string) => sql<number | null>`(${runs.summary}->>${key})::float8`;

/** Benchmark history for a site (key metrics of finished runs). */
export async function siteBenchmark(siteId: string) {
  const site = await siteRow(siteId);
  const items = await db
    .select({
      id: runs.id,
      name: runs.name,
      kind: runs.kind,
      status: runs.status,
      createdAt: runs.createdAt,
      isBaseline: runs.isBaseline,
      thresholdsPassed: runs.thresholdsPassed,
      planId: runs.planId,
      capacity: runs.capacity,
      latency: sql<Record<string, number | null> | null>`${runs.summary}->'latency'`,
      rpsAvg: summaryNum('rpsAvg'),
      rpsPeak: summaryNum('rpsPeak'),
      errorRate: summaryNum('errorRate'),
      requests: summaryNum('requests'),
      maxVus: summaryNum('maxVus'),
      durationSec: summaryNum('durationSec'),
    })
    .from(runs)
    .where(and(eq(runs.siteId, siteId), inArray(runs.status, ['completed', 'stopped']), ne(runs.kind, 'debug')))
    .orderBy(desc(runs.createdAt))
    .limit(200);
  const baseline = items.find((i) => i.isBaseline) ?? null;
  const capacityRuns = items.filter((i) => i.capacity?.maxHealthy);
  return {
    site,
    runs: items,
    baseline,
    best: {
      p95: items.reduce<number | null>((a, i) => (i.latency?.p95 != null && (a === null || i.latency.p95 < a) ? i.latency.p95 : a), null),
      rpsPeak: items.reduce((a, i) => Math.max(a, i.rpsPeak ?? 0), 0),
      capacityRps: capacityRuns.reduce((a, i) => Math.max(a, i.capacity!.maxHealthy.rps ?? 0), 0) || null,
    },
  };
}

/** Fetches a page once and extracts its structure for MCP / workflow design. */
export async function probeSite(siteId: string, urlOrPath: string, method = 'GET') {
  const site = await siteRow(siteId);
  const url = /^https?:\/\//i.test(urlOrPath) ? urlOrPath : site.baseUrl.replace(/\/$/, '') + (urlOrPath.startsWith('/') ? '' : '/') + urlOrPath;
  const host = new URL(url).hostname;
  if (!hostAllowed(host, siteHosts(site))) throw new HttpError(400, `${host} is not among this site's allowed hosts`);
  const started = Date.now();
  const res = await fetch(url, {
    method,
    redirect: 'follow',
    headers: { 'User-Agent': 'LoadLab/1.0 probe', ...(site.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  const ms = Date.now() - started;
  const ct = res.headers.get('content-type') ?? '';
  const text = (await res.text()).slice(0, 2_000_000);
  const out: any = {
    url,
    finalUrl: res.url,
    status: res.status,
    durationMs: ms,
    contentType: ct,
    sizeBytes: text.length,
    headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => /^(content-type|cache-control|server|set-cookie|location|x-powered-by|cf-cache-status|age)$/i.test(k))),
  };
  if (ct.includes('json')) {
    out.jsonPreview = text.slice(0, 4000);
  } else if (ct.includes('html')) {
    out.title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? null;
    const links = new Map<string, string>();
    for (const m of text.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      if (links.size >= 120) break;
      const href = m[1].trim();
      if (/^(mailto|tel|javascript):/i.test(href)) continue;
      let abs: string;
      try {
        abs = new URL(href, res.url).toString();
      } catch {
        continue;
      }
      if (!hostAllowed(new URL(abs).hostname, siteHosts(site))) continue;
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!links.has(abs)) links.set(abs, label);
    }
    out.links = [...links.entries()].map(([href, text]) => ({ href, text }));
    out.forms = [...text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].slice(0, 20).map((m) => ({
      action: /action=["']([^"']*)["']/i.exec(m[1])?.[1] ?? '',
      method: (/method=["']([^"']*)["']/i.exec(m[1])?.[1] ?? 'GET').toUpperCase(),
      inputs: [...m[2].matchAll(/<(?:input|select|textarea)\b[^>]*name=["']([^"']+)["'][^>]*>/gi)].map((i) => {
        const type = /type=["']([^"']+)["']/i.exec(i[0])?.[1] ?? 'text';
        const value = /value=["']([^"']*)["']/i.exec(i[0])?.[1];
        return { name: i[1], type, ...(type === 'hidden' && value !== undefined ? { value: value.slice(0, 80) } : {}) };
      }),
    }));
    out.assets = {
      scripts: (text.match(/<script\b[^>]*src=/gi) ?? []).length,
      stylesheets: (text.match(/<link\b[^>]*stylesheet/gi) ?? []).length,
      images: (text.match(/<img\b/gi) ?? []).length,
    };
    out.htmlPreview = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ').slice(0, 3000);
  } else {
    out.textPreview = text.slice(0, 2000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowStatus = (typeof workflows.$inferSelect)['status'];

const workflowWithSite = { ...getTableColumns(workflows), siteName: sites.name };

export const loadWorkflow = async (id: string): Promise<WorkflowRow | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db.select({ id: workflows.id, name: workflows.name, status: workflows.status, definition: workflows.definition }).from(workflows).where(eq(workflows.id, id)).limit(1);
  return r ?? null;
};

export async function listWorkflows(f: { siteId?: string; status?: string } = {}) {
  const conds: (SQL | undefined)[] = [];
  if (f.siteId) conds.push(or(eq(workflows.siteId, asUuid(f.siteId, 'site')), sql`${workflows.siteId} IS NULL`));
  conds.push(f.status ? eq(workflows.status, f.status as WorkflowStatus) : ne(workflows.status, 'archived'));
  return db
    .select(workflowWithSite)
    .from(workflows)
    .leftJoin(sites, eq(sites.id, workflows.siteId))
    .where(and(...conds))
    .orderBy(desc(workflows.updatedAt));
}

export async function getWorkflow(id: string) {
  const [r] = await db.select(workflowWithSite).from(workflows).leftJoin(sites, eq(sites.id, workflows.siteId)).where(eq(workflows.id, asUuid(id, 'workflow'))).limit(1);
  if (!r) notFound('Workflow');
  return r;
}

export async function validateWorkflow(definition: unknown, siteId?: string | null) {
  try {
    const def = parseWorkflowDefinition(definition);
    const steps = await inlineIncludes(def.steps, loadWorkflow);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (siteId) checkStaticHosts(steps, siteHosts(await siteRow(siteId)), errors);
    const reqs = countRequests(steps);
    if (!reqs) warnings.push('Workflow has no HTTP requests');
    if (!JSON.stringify(def.steps).includes('"think"')) warnings.push('No think time: generates far more aggressive load than a real user');
    return { ok: errors.length === 0, errors, warnings, requestCount: reqs, resolvedSteps: steps };
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, errors: e.errors, warnings: [], requestCount: 0, resolvedSteps: [] };
    throw e;
  }
}

interface WorkflowInput {
  name: string;
  description?: string;
  siteId?: string | null;
  definition: unknown;
  tags?: string[];
  status?: WorkflowStatus;
}

function parseDefinition(def: unknown) {
  try {
    return parseWorkflowDefinition(def);
  } catch (e) {
    if (e instanceof CompileError) throw new HttpError(400, 'Invalid workflow', e.errors);
    throw e;
  }
}

export async function createWorkflow(input: WorkflowInput, source: string) {
  if (!input?.name?.trim()) throw new HttpError(400, 'Name is required');
  const def = parseDefinition(input.definition);
  if (input.siteId) await siteRow(input.siteId);
  const status: WorkflowStatus = source === 'mcp' ? 'draft' : (input.status ?? 'draft');
  const created = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(workflows)
      .values({ siteId: input.siteId ?? null, name: input.name.trim(), description: input.description ?? '', status, definition: def, tags: input.tags ?? [], source })
      .returning();
    await tx.insert(workflowVersions).values({ workflowId: w.id, version: 1, definition: def, source });
    return w;
  });
  return getWorkflow(created.id);
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowInput>, source: string) {
  const cur = await getWorkflow(id);
  if (source === 'mcp' && cur.status !== 'draft') {
    throw new HttpError(409, 'MCP can only edit draft workflows. To change an active workflow, create a draft copy with duplicate_workflow.');
  }
  const def = patch.definition !== undefined ? parseDefinition(patch.definition) : cur.definition;
  const defChanged = JSON.stringify(def) !== JSON.stringify(cur.definition);
  if (patch.siteId) await siteRow(patch.siteId);
  const version = defChanged ? cur.version + 1 : cur.version;
  await db.transaction(async (tx) => {
    await tx
      .update(workflows)
      .set({
        name: patch.name?.trim() || cur.name,
        description: patch.description ?? cur.description,
        siteId: patch.siteId === undefined ? cur.siteId : patch.siteId,
        definition: def,
        tags: patch.tags ?? cur.tags,
        status: source === 'mcp' ? 'draft' : (patch.status ?? cur.status),
        version,
        updatedAt: now(),
      })
      .where(eq(workflows.id, id));
    if (defChanged) await tx.insert(workflowVersions).values({ workflowId: id, version, definition: def, source });
  });
  return getWorkflow(id);
}

export async function duplicateWorkflow(id: string, source: string, name?: string) {
  const cur = await getWorkflow(id);
  return createWorkflow({ name: name || `${cur.name} (copy)`, description: cur.description, siteId: cur.siteId, definition: cur.definition, tags: cur.tags, status: 'draft' }, source);
}

export async function deleteWorkflow(id: string) {
  await getWorkflow(id);
  const used = await db
    .select({ name: testPlans.name })
    .from(testPlans)
    .where(sql`${testPlans.config}->'flows' @> ${JSON.stringify([{ workflowId: id }])}::jsonb`);
  if (used.length) {
    await db.update(workflows).set({ status: 'archived', updatedAt: now() }).where(eq(workflows.id, id));
    return { ok: true, archived: true, message: `Archived because it is used in plans: ${used.map((u) => u.name).join(', ')}` };
  }
  await db.delete(workflows).where(eq(workflows.id, id));
  return { ok: true };
}

export async function workflowVersionList(id: string) {
  return db
    .select({ version: workflowVersions.version, source: workflowVersions.source, createdAt: workflowVersions.createdAt, definition: workflowVersions.definition })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, asUuid(id, 'workflow')))
    .orderBy(desc(workflowVersions.version))
    .limit(50);
}

// ---------------------------------------------------------------------------
// Test plans
// ---------------------------------------------------------------------------

type PlanStatus = (typeof testPlans.$inferSelect)['status'];

const planWithSite = {
  ...getTableColumns(testPlans),
  siteName: sites.name,
  lastRun: sql<Record<string, unknown> | null>`(
    SELECT json_build_object('id', r.id, 'status', r.status, 'createdAt', r.created_at,
                             'p95', r.summary->'latency'->'p95', 'errorRate', r.summary->'errorRate')
      FROM runs r WHERE r.plan_id = ${testPlans.id} ORDER BY r.created_at DESC LIMIT 1)`,
};

export async function listPlans(f: { siteId?: string; status?: string } = {}) {
  const conds: SQL[] = [];
  if (f.siteId) conds.push(eq(testPlans.siteId, asUuid(f.siteId, 'site')));
  if (f.status) conds.push(eq(testPlans.status, f.status as PlanStatus));
  return db
    .select(planWithSite)
    .from(testPlans)
    .innerJoin(sites, eq(sites.id, testPlans.siteId))
    .where(and(...conds))
    .orderBy(desc(testPlans.updatedAt));
}

export async function getPlan(id: string) {
  const [r] = await db.select(planWithSite).from(testPlans).innerJoin(sites, eq(sites.id, testPlans.siteId)).where(eq(testPlans.id, asUuid(id, 'plan'))).limit(1);
  if (!r) notFound('Plan');
  return r;
}

function validateCron(expr?: string | null) {
  if (!expr) return null;
  try {
    CronExpressionParser.parse(expr);
  } catch {
    throw new HttpError(400, `Invalid cron expression: ${expr}`);
  }
  return expr;
}

async function checkPlan(siteId: string, cfg: unknown): Promise<PlanConfig> {
  const site = await siteRow(siteId);
  try {
    const { plan } = await compileRun(site, cfg, loadWorkflow);
    return plan;
  } catch (e) {
    if (e instanceof CompileError) throw new HttpError(400, 'Invalid plan', e.errors);
    throw e;
  }
}

interface PlanInput {
  name: string;
  siteId: string;
  config: unknown;
  notes?: string;
  schedule?: string | null;
  status?: PlanStatus;
}

export async function createPlan(input: PlanInput, source: string) {
  if (!input?.name?.trim()) throw new HttpError(400, 'Name is required');
  const cfg = await checkPlan(input.siteId, input.config);
  const [r] = await db
    .insert(testPlans)
    .values({
      siteId: input.siteId,
      name: input.name.trim(),
      status: source === 'mcp' ? 'draft' : (input.status ?? 'ready'),
      config: cfg,
      notes: input.notes ?? '',
      source,
      schedule: source === 'mcp' ? null : validateCron(input.schedule),
    })
    .returning({ id: testPlans.id });
  return getPlan(r.id);
}

export async function updatePlan(id: string, patch: Partial<PlanInput>, source: string) {
  const cur = await getPlan(id);
  if (source === 'mcp' && cur.status !== 'draft') throw new HttpError(409, 'MCP can only edit draft plans');
  const siteId = patch.siteId ?? cur.siteId;
  const cfg = patch.config !== undefined || patch.siteId ? await checkPlan(siteId, patch.config ?? cur.config) : cur.config;
  await db
    .update(testPlans)
    .set({
      name: patch.name?.trim() || cur.name,
      siteId,
      config: cfg,
      notes: patch.notes ?? cur.notes,
      schedule: source === 'mcp' ? cur.schedule : patch.schedule === undefined ? cur.schedule : validateCron(patch.schedule),
      status: source === 'mcp' ? 'draft' : (patch.status ?? cur.status),
      updatedAt: now(),
    })
    .where(eq(testPlans.id, id));
  return getPlan(id);
}

export async function deletePlan(id: string) {
  await getPlan(id);
  await db.delete(testPlans).where(eq(testPlans.id, id));
  return { ok: true };
}

/** Compiles the plan and returns a preview (without running it). */
export async function previewPlan(siteId: string, cfg: unknown) {
  const site = await siteRow(siteId);
  try {
    const { runner, plan } = await compileRun(site, cfg, loadWorkflow);
    return { ok: true, errors: [], plan, meta: runner.meta, options: runner.options, flows: runner.flows.map((f) => ({ name: f.name, weight: f.weight, requests: countRequests(f.steps) })) };
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, errors: e.errors };
    throw e;
  }
}

async function enqueueRun(opts: { site: SiteRow; planId: string | null; name: string; cfg: unknown; trigger: string }) {
  let compiled;
  try {
    compiled = await compileRun(opts.site, opts.cfg, loadWorkflow);
  } catch (e) {
    if (e instanceof CompileError) throw new HttpError(400, 'Could not start test', e.errors);
    throw e;
  }
  const [r] = await db
    .insert(runs)
    .values({
      planId: opts.planId,
      siteId: opts.site.id,
      name: opts.name,
      kind: compiled.plan.profile.kind,
      status: 'queued',
      trigger: opts.trigger,
      config: compiled.runner,
      planSnapshot: compiled.plan,
    })
    .returning({ id: runs.id, name: runs.name, kind: runs.kind, status: runs.status, createdAt: runs.createdAt });
  await redis.lpush(keys.queueWake, r.id);
  await redis.ltrim(keys.queueWake, 0, 50);
  return { ...r, url: `${config.publicUrl}/runs/${r.id}` };
}

export async function startPlan(id: string, trigger: string) {
  const plan = await getPlan(id);
  const site = await siteRow(plan.siteId);
  const res = await enqueueRun({ site, planId: plan.id, name: `${plan.name} · ${PROFILE_LABELS[plan.config.profile.kind] ?? plan.config.profile.kind}`, cfg: plan.config, trigger });
  if (plan.status === 'draft' && trigger === 'panel') await db.update(testPlans).set({ status: 'ready', updatedAt: now() }).where(eq(testPlans.id, id));
  return res;
}

/** Runs a single workflow with 1 VU / 1 iteration and a detailed trace. */
export async function debugWorkflow(workflowId: string, siteId: string, iterations = 1) {
  const wf = await getWorkflow(workflowId);
  const site = await siteRow(siteId);
  return enqueueRun({
    site,
    planId: null,
    name: `${wf.name} · Debug`,
    cfg: { flows: [{ workflowId, weight: 1 }], profile: { kind: 'debug', iterations: Math.min(5, Math.max(1, iterations)) } },
    trigger: 'panel',
  });
}

export async function rerun(runId: string, trigger: string) {
  const [r] = await db.select({ siteId: runs.siteId, planId: runs.planId, name: runs.name, planSnapshot: runs.planSnapshot }).from(runs).where(eq(runs.id, asUuid(runId, 'run'))).limit(1);
  if (!r) notFound('Run');
  return enqueueRun({ site: await siteRow(r.siteId), planId: r.planId, name: r.name, cfg: r.planSnapshot, trigger });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const runListColumns = {
  id: runs.id,
  planId: runs.planId,
  siteId: runs.siteId,
  siteName: sites.name,
  name: runs.name,
  kind: runs.kind,
  status: runs.status,
  trigger: runs.trigger,
  workerId: runs.workerId,
  thresholdsPassed: runs.thresholdsPassed,
  stopReason: runs.stopReason,
  error: runs.error,
  isBaseline: runs.isBaseline,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  capacity: runs.capacity,
};

export async function listRuns(f: { siteId?: string; status?: string; planId?: string; limit?: number } = {}) {
  const conds: SQL[] = [];
  if (f.siteId) conds.push(eq(runs.siteId, asUuid(f.siteId, 'site')));
  if (f.planId) conds.push(eq(runs.planId, asUuid(f.planId, 'plan')));
  if (f.status === 'active') conds.push(inArray(runs.status, ACTIVE_RUN_STATUSES));
  else if (f.status) conds.push(eq(runs.status, f.status as (typeof runs.$inferSelect)['status']));
  return db
    .select({
      ...runListColumns,
      brief: sql<Record<string, any>>`json_build_object(
        'requests', ${runs.summary}->'requests', 'errorRate', ${runs.summary}->'errorRate',
        'p95', ${runs.summary}->'latency'->'p95', 'rpsAvg', ${runs.summary}->'rpsAvg',
        'maxVus', ${runs.summary}->'maxVus', 'warnings', ${runs.summary}->'warnings')`,
    })
    .from(runs)
    .innerJoin(sites, eq(sites.id, runs.siteId))
    .where(and(...conds))
    .orderBy(desc(runs.createdAt))
    .limit(Math.min(500, f.limit ?? 100));
}

export async function getRun(id: string) {
  const [r] = await db
    .select({ ...runListColumns, summary: runs.summary, planSnapshot: runs.planSnapshot, config: runs.config, logs: runs.logs })
    .from(runs)
    .innerJoin(sites, eq(sites.id, runs.siteId))
    .where(eq(runs.id, asUuid(id, 'run')))
    .limit(1);
  if (!r) notFound('Run');
  const { config: cfg, planSnapshot, ...rest } = r;
  const out: Record<string, any> = {
    ...rest,
    plan: planSnapshot,
    meta: cfg?.meta,
    flows: (cfg?.flows ?? []).map((f) => ({ name: f.name, weight: f.weight, workflowId: f.id })),
  };
  if ((LIVE_RUN_STATUSES as readonly string[]).includes(r.status)) {
    const steps = await redis.get(keys.steps(id));
    if (steps) out.liveSteps = JSON.parse(steps);
  }
  return out;
}

/** Per-second series. Keys are returned in the same format as the live stream (SSE) (snake_case). */
export async function runMetricsList(id: string) {
  const m = runMetrics;
  return db
    .select({
      t: m.t,
      ts: m.ts,
      vus: m.vus,
      rps: m.rps,
      iters: m.iters,
      err_rate: m.errRate,
      avg: m.avg,
      p50: m.p50,
      p90: m.p90,
      p95: m.p95,
      p99: m.p99,
      max: m.max,
      bytes_in: m.bytesIn,
      bytes_out: m.bytesOut,
      dropped: m.dropped,
      checks_fail: m.checksFail,
      gen_cpu: m.genCpu,
    })
    .from(m)
    .where(eq(m.runId, asUuid(id, 'run')))
    .orderBy(asc(m.t));
}

async function runStatus(id: string) {
  const [r] = await db.select({ status: runs.status, siteId: runs.siteId }).from(runs).where(eq(runs.id, asUuid(id, 'run'))).limit(1);
  if (!r) notFound('Run');
  return r;
}

export async function stopRun(id: string, force = false) {
  const r = await runStatus(id);
  if (r.status === 'queued') {
    await db
      .update(runs)
      .set({ status: 'canceled', finishedAt: now(), stopReason: 'Canceled while queued' })
      .where(and(eq(runs.id, id), eq(runs.status, 'queued')));
    await redis.publish(keys.live(id), JSON.stringify({ type: 'status', data: { status: 'canceled', done: true } }));
    return { ok: true, status: 'canceled' };
  }
  if (!(LIVE_RUN_STATUSES as readonly string[]).includes(r.status)) return { ok: false, status: r.status, message: 'Run has already finished' };
  await db
    .update(runs)
    .set({ status: 'stopping', stopReason: sql`COALESCE(${runs.stopReason}, 'Stopped by user')` })
    .where(and(eq(runs.id, id), inArray(runs.status, ['starting', 'running'])));
  await redis.publish(keys.control(id), force ? 'kill' : 'stop');
  return { ok: true, status: 'stopping' };
}

export async function deleteRun(id: string) {
  const r = await runStatus(id);
  if ((LIVE_RUN_STATUSES as readonly string[]).includes(r.status)) throw new HttpError(409, 'A running run cannot be deleted; stop it first');
  await db.delete(runs).where(eq(runs.id, id));
  return { ok: true };
}

export async function setBaseline(id: string, value: boolean) {
  const r = await runStatus(id);
  await db.transaction(async (tx) => {
    if (value) await tx.update(runs).set({ isBaseline: false }).where(and(eq(runs.siteId, r.siteId), eq(runs.isBaseline, true)));
    await tx.update(runs).set({ isBaseline: value }).where(eq(runs.id, id));
  });
  return { ok: true };
}

export async function compareRuns(a: string, b: string) {
  const [ra, rb, ma, mb] = await Promise.all([getRun(a), getRun(b), runMetricsList(a), runMetricsList(b)]);
  const pick = (r: Record<string, any>) => ({
    p50: r.summary?.latency?.p50 ?? null,
    p95: r.summary?.latency?.p95 ?? null,
    p99: r.summary?.latency?.p99 ?? null,
    avg: r.summary?.latency?.avg ?? null,
    rpsAvg: r.summary?.rpsAvg ?? null,
    rpsPeak: r.summary?.rpsPeak ?? null,
    errorRate: r.summary?.errorRate ?? null,
    requests: r.summary?.requests ?? null,
    maxVus: r.summary?.maxVus ?? null,
    capacityRps: r.capacity?.maxHealthy?.rps ?? null,
  });
  const ka = pick(ra);
  const kb = pick(rb);
  const delta: Record<string, number | null> = {};
  for (const k of Object.keys(ka) as (keyof typeof ka)[]) {
    const x = ka[k];
    const y = kb[k];
    delta[k] = x !== null && y !== null && x !== 0 ? Math.round(((y - x) / x) * 1000) / 10 : null;
  }
  const side = (r: Record<string, any>, metrics: unknown, kpi: typeof ka): Record<string, any> => ({ ...r, logs: undefined, metrics, kpi });
  return { a: side(ra, ma, ka), b: side(rb, mb, kb), deltaPct: delta };
}

// ---------------------------------------------------------------------------
// Overview and system
// ---------------------------------------------------------------------------

export async function overview() {
  const [nSites, wfActive, wfDraft, plansDraft, plans, runsAll, runs7d, runsActive] = await Promise.all([
    db.$count(sites),
    db.$count(workflows, eq(workflows.status, 'active')),
    db.$count(workflows, eq(workflows.status, 'draft')),
    db.$count(testPlans, eq(testPlans.status, 'draft')),
    db.$count(testPlans),
    db.$count(runs),
    db.$count(runs, sql`${runs.createdAt} > now() - interval '7 days'`),
    db.$count(runs, inArray(runs.status, ACTIVE_RUN_STATUSES)),
  ]);
  const [active, recent, wfDrafts, planDrafts, nodes] = await Promise.all([
    listRuns({ status: 'active', limit: 20 }),
    listRuns({ limit: 10 }),
    listWorkflows({ status: 'draft' }),
    listPlans({ status: 'draft' }),
    listNodes(),
  ]);
  const drafts = [
    ...wfDrafts.slice(0, 10).map((w) => ({ type: 'workflow', id: w.id, name: w.name, source: w.source, updatedAt: w.updatedAt })),
    ...planDrafts.slice(0, 10).map((p) => ({ type: 'plan', id: p.id, name: p.name, source: p.source, updatedAt: p.updatedAt })),
  ];
  return {
    counts: { sites: nSites, workflows_active: wfActive, workflows_draft: wfDraft, plans_draft: plansDraft, plans, runs: runsAll, runs_7d: runs7d, runs_active: runsActive },
    active,
    recent,
    drafts,
    workers: nodes.filter((n) => n.role === 'worker'),
  };
}

async function listNodes() {
  const all = await redis.hgetall(keys.nodes);
  const ts = Date.now();
  const out: any[] = [];
  for (const [id, raw] of Object.entries(all)) {
    try {
      const n = JSON.parse(raw);
      const age = ts - Date.parse(n.at);
      if (age > 5 * 60_000) {
        await redis.hdel(keys.nodes, id);
        continue;
      }
      out.push({ ...n, online: age < 20_000 });
    } catch {
      await redis.hdel(keys.nodes, id);
    }
  }
  return out.sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
}

function parseRedisInfo(info: string) {
  const o: Record<string, string> = {};
  for (const line of info.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

export async function systemStatus() {
  const nodes = await listNodes();
  // System catalog queries aren't part of the schema; they stay as raw SQL
  const pgInfo = (
    await db.execute<{ db_size: number; version: string; connections: number }>(sql`
      SELECT pg_database_size(current_database())::bigint AS db_size, version() AS version,
             (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections`)
  ).rows[0];
  const tables = (
    await db.execute<{ name: string; bytes: number; rows: number }>(sql`
      SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes, GREATEST(c.reltuples, 0)::bigint AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY bytes DESC`)
  ).rows;
  const info = parseRedisInfo(await redis.info());
  let disk: { path: string; totalBytes: number; freeBytes: number } | null = null;
  try {
    fs.mkdirSync(config.workDir, { recursive: true });
    const st = fs.statfsSync(config.workDir);
    disk = { path: config.workDir, totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize };
  } catch {
    /* not supported */
  }
  const runStats = await db.select({ status: runs.status, count: count() }).from(runs).groupBy(runs.status);
  return {
    nodes,
    postgres: { version: String(pgInfo.version).split(' ').slice(0, 2).join(' '), dbSizeBytes: Number(pgInfo.db_size), connections: Number(pgInfo.connections), tables },
    redis: {
      version: info.redis_version,
      usedMemoryBytes: Number(info.used_memory),
      peakMemoryBytes: Number(info.used_memory_peak),
      maxMemoryBytes: Number(info.maxmemory) || null,
      connectedClients: Number(info.connected_clients),
      opsPerSec: Number(info.instantaneous_ops_per_sec),
      keys: Object.entries(info)
        .filter(([k]) => /^db\d+$/.test(k))
        .reduce((a, [, v]) => a + Number(/keys=(\d+)/.exec(v)?.[1] ?? 0), 0),
      uptimeSec: Number(info.uptime_in_seconds),
    },
    disk,
    runs: Object.fromEntries(runStats.map((r) => [r.status, r.count])),
    metricRows: await db.$count(runMetrics),
    settings: await getSettings(),
    limits: config.limits,
  };
}

export async function getSettings() {
  const rows = await db.select().from(settings);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { metricsRetentionDays: Number(s.metricsRetentionDays ?? 90), runsRetentionDays: Number(s.runsRetentionDays ?? 0) };
}

export async function updateSettings(input: { metricsRetentionDays?: number; runsRetentionDays?: number }) {
  for (const k of ['metricsRetentionDays', 'runsRetentionDays'] as const) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!Number.isInteger(v) || v < 0 || v > 3650) throw new HttpError(400, `${k} must be an integer between 0 and 3650`);
    await db.insert(settings).values({ key: k, value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  }
  return getSettings();
}

/** Cleans up old data. metrics: per-second series (summaries are kept), runs: the entire run. */
export async function cleanup(opts: { olderThanDays: number; mode: 'metrics' | 'runs' }) {
  const days = Math.max(0, Math.floor(opts.olderThanDays));
  let deleted = 0;
  if (opts.mode === 'runs') {
    const r = await db.delete(runs).where(and(olderThanDays(runs.finishedAt, days), eq(runs.isBaseline, false)));
    deleted = r.rowCount ?? 0;
  } else {
    const old = db.select({ id: runs.id }).from(runs).where(and(olderThanDays(runs.finishedAt, days), eq(runs.isBaseline, false)));
    const r = await db.delete(runMetrics).where(inArray(runMetrics.runId, old));
    deleted = r.rowCount ?? 0;
  }
  return { ok: true, deleted };
}

// ---------------------------------------------------------------------------
// API keys (MCP)
// ---------------------------------------------------------------------------

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export async function listTokens() {
  return db
    .select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt })
    .from(apiTokens)
    .orderBy(desc(apiTokens.createdAt));
}

export async function createToken(name: string) {
  if (!name?.trim()) throw new HttpError(400, 'Name is required');
  const token = `ll_${crypto.randomBytes(24).toString('base64url')}`;
  const [r] = await db
    .insert(apiTokens)
    .values({ name: name.trim(), tokenHash: hashToken(token), prefix: token.slice(0, 7) })
    .returning({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, createdAt: apiTokens.createdAt });
  return { ...r, token };
}

export async function deleteToken(id: string) {
  await db.delete(apiTokens).where(eq(apiTokens.id, asUuid(id)));
  return { ok: true };
}

export async function verifyToken(token: string): Promise<boolean> {
  if (!token) return false;
  if (config.mcpToken && token.length === config.mcpToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.mcpToken))) return true;
  const r = await db.update(apiTokens).set({ lastUsedAt: now() }).where(eq(apiTokens.tokenHash, hashToken(token))).returning({ id: apiTokens.id });
  return r.length > 0;
}

// ---------------------------------------------------------------------------
// Background: scheduler and janitor
// ---------------------------------------------------------------------------

export async function schedulerTick() {
  // With multiple api replicas only one schedules (session-level advisory lock)
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock(777001) AS ok');
    if (!got.rows[0].ok) return;
    try {
      const plans = await db
        .select({ id: testPlans.id, name: testPlans.name, schedule: testPlans.schedule, lastScheduledAt: testPlans.lastScheduledAt, createdAt: testPlans.createdAt })
        .from(testPlans)
        .where(and(isNotNull(testPlans.schedule), eq(testPlans.status, 'ready')));
      for (const p of plans) {
        let prev: Date;
        try {
          prev = CronExpressionParser.parse(p.schedule!, { currentDate: new Date() }).prev().toDate();
        } catch {
          continue;
        }
        if (prev <= (p.lastScheduledAt ?? p.createdAt)) continue;
        await db.update(testPlans).set({ lastScheduledAt: now() }).where(eq(testPlans.id, p.id));
        if (await db.$count(runs, and(eq(runs.planId, p.id), inArray(runs.status, ACTIVE_RUN_STATUSES)))) continue;
        try {
          await startPlan(p.id, 'schedule');
          console.log(`[scheduler] plan started: ${p.name}`);
        } catch (err) {
          console.error(`[scheduler] ${p.name}:`, (err as Error).message);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(777001)');
    }
  } finally {
    client.release();
  }
}

let lastRetention = 0;

export async function janitorTick() {
  // runs whose worker has disappeared
  const orphans = await db
    .select({ id: runs.id, workerId: runs.workerId })
    .from(runs)
    .where(and(inArray(runs.status, LIVE_RUN_STATUSES), sql`${runs.createdAt} < now() - interval '30 seconds'`));
  for (const o of orphans) {
    const alive = o.workerId ? await redis.exists(keys.workerHb(o.workerId)) : 0;
    if (alive) continue;
    await db
      .update(runs)
      .set({ status: 'failed', finishedAt: now(), error: 'Worker not responding (crashed or restarted)' })
      .where(and(eq(runs.id, o.id), inArray(runs.status, LIVE_RUN_STATUSES)));
    await redis.publish(keys.live(o.id), JSON.stringify({ type: 'status', data: { status: 'failed', done: true } }));
  }
  // hourly retention policy
  if (Date.now() - lastRetention > 3600_000) {
    lastRetention = Date.now();
    const s = await getSettings();
    if (s.metricsRetentionDays > 0) await cleanup({ olderThanDays: s.metricsRetentionDays, mode: 'metrics' });
    if (s.runsRetentionDays > 0) await cleanup({ olderThanDays: s.runsRetentionDays, mode: 'runs' });
  }
}
