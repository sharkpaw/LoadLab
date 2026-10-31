import { config } from './config.js';
import {
  formatZodError,
  PlanConfigSchema,
  WorkflowDefinitionSchema,
  type PlanConfig,
  type Profile,
  type Step,
  type WorkflowDefinition,
} from './schemas.js';

export class CompileError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('\n'));
  }
}

export interface SiteRow {
  id: string;
  name: string;
  baseUrl: string;
  allowedHosts: string[];
  headers: Record<string, string>;
  variables: Record<string, string>;
  datasets: Record<string, Record<string, unknown>[]>;
}

export interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  definition: WorkflowDefinition;
}

export type WorkflowLoader = (id: string) => Promise<WorkflowRow | null>;

export function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

export function siteHosts(site: Pick<SiteRow, 'baseUrl' | 'allowedHosts'>): string[] {
  const set = new Set<string>();
  const h = hostOf(site.baseUrl);
  if (h) set.add(h);
  for (const a of site.allowedHosts ?? []) set.add(a.toLowerCase().trim());
  return [...set].filter(Boolean);
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  host = host.toLowerCase();
  return allowed.some((a) => a === host || (a.startsWith('*.') && (host.endsWith(a.slice(1)) || host === a.slice(2))));
}

export function parseWorkflowDefinition(def: unknown): WorkflowDefinition {
  const r = WorkflowDefinitionSchema.safeParse(def);
  if (!r.success) throw new CompileError(formatZodError(r.error));
  return r.data;
}

export function parsePlanConfig(cfg: unknown): PlanConfig {
  const r = PlanConfigSchema.safeParse(cfg);
  if (!r.success) throw new CompileError(formatZodError(r.error));
  return r.data;
}

/** Replaces include steps with the referenced workflow's steps (cycle-safe). */
export async function inlineIncludes(steps: Step[], load: WorkflowLoader, stack: string[] = []): Promise<Step[]> {
  const out: Step[] = [];
  for (const s of steps) {
    if (s.type === 'include') {
      if (stack.includes(s.workflowId)) throw new CompileError([`include cycle: ${[...stack, s.workflowId].join(' → ')}`]);
      if (stack.length > 6) throw new CompileError(['include depth cannot exceed 6 levels']);
      const wf = await load(s.workflowId);
      if (!wf) throw new CompileError([`included workflow not found: ${s.workflowId}`]);
      const def = parseWorkflowDefinition(wf.definition);
      const inner = await inlineIncludes(def.steps, load, [...stack, s.workflowId]);
      // the module's variables are prepended as a set step
      const pre: Step[] = def.variables && Object.keys(def.variables).length ? [{ type: 'set', vars: def.variables }] : [];
      out.push({ type: 'group', name: s.name ?? wf.name, probability: s.probability, steps: [...pre, ...inner] });
    } else if (s.type === 'group') {
      out.push({ ...s, steps: await inlineIncludes(s.steps, load, stack) });
    } else {
      out.push(s);
    }
  }
  return out;
}

/** Verifies that static URLs (host without templates) target allowed hosts. */
export function checkStaticHosts(steps: Step[], allowed: string[], errors: string[], prefix = ''): void {
  steps.forEach((s, i) => {
    const where = `${prefix}steps[${i}]${'name' in s && s.name ? ` (${s.name})` : ''}`;
    if (s.type === 'request' || s.type === 'page') {
      const host = hostOf(s.url);
      if (host && !host.includes('{{') && !hostAllowed(host, allowed)) {
        errors.push(`${where}: ${host} is not among this site's allowed hosts (${allowed.join(', ')})`);
      }
    }
    if (s.type === 'think' && s.max < s.min) errors.push(`${where}: think.max cannot be less than min`);
    if (s.type === 'group') {
      if (s.repeat && s.repeat.max < s.repeat.min) errors.push(`${where}: repeat.max cannot be less than min`);
      checkStaticHosts(s.steps, allowed, errors, `${where}.`);
    }
  });
}

export function countRequests(steps: Step[]): number {
  let n = 0;
  for (const s of steps) {
    if (s.type === 'request' || s.type === 'page') n++;
    else if (s.type === 'group') n += countRequests(s.steps);
  }
  return n;
}

function scale(v: number, f: number) {
  return Math.max(1, Math.round(v * f));
}

/** Default stages per profile kind (same logic as the UI). */
export function defaultStages(kind: Profile['kind'], vus: number, duration: number): { duration: number; target: number }[] {
  switch (kind) {
    case 'stress':
      return [
        { duration: 60, target: scale(vus, 0.25) },
        { duration: 120, target: scale(vus, 0.25) },
        { duration: 60, target: scale(vus, 0.5) },
        { duration: 120, target: scale(vus, 0.5) },
        { duration: 60, target: vus },
        { duration: 120, target: vus },
        { duration: 60, target: 0 },
      ];
    case 'spike':
      return [
        { duration: 30, target: scale(vus, 0.1) },
        { duration: 60, target: scale(vus, 0.1) },
        { duration: 10, target: vus },
        { duration: 60, target: vus },
        { duration: 10, target: scale(vus, 0.1) },
        { duration: 60, target: scale(vus, 0.1) },
        { duration: 10, target: 0 },
      ];
    default:
      return [
        { duration: 60, target: vus },
        { duration, target: vus },
        { duration: 30, target: 0 },
      ];
  }
}

function rateSpec(rate: number): { rate: number; timeUnit: string } {
  if (Number.isInteger(rate)) return { rate, timeUnit: '1s' };
  return { rate: Math.max(1, Math.round(rate * 60)), timeUnit: '1m' };
}

export interface ScenarioInfo {
  scenario: Record<string, unknown>;
  estDurationSec: number;
  peakVus: number;
  arrival: boolean;
}

export function buildScenario(p: Profile, gracefulStop: number): ScenarioInfo {
  const L = config.limits;
  const errors: string[] = [];
  const gs = `${gracefulStop}s`;
  let info: ScenarioInfo;

  switch (p.kind) {
    case 'debug':
      info = {
        scenario: { executor: 'shared-iterations', vus: 1, iterations: p.iterations ?? 1, maxDuration: '5m' },
        estDurationSec: 30,
        peakVus: 1,
        arrival: false,
      };
      break;
    case 'smoke':
    case 'constant_vus':
    case 'soak': {
      const vus = p.vus ?? (p.kind === 'smoke' ? 1 : 10);
      const duration = p.duration ?? (p.kind === 'smoke' ? 60 : p.kind === 'soak' ? 3600 : 300);
      info = { scenario: { executor: 'constant-vus', vus, duration: `${duration}s`, gracefulStop: gs }, estDurationSec: duration, peakVus: vus, arrival: false };
      break;
    }
    case 'constant_rate': {
      const rate = p.rate ?? 10;
      const duration = p.duration ?? 300;
      const pre = p.preAllocatedVUs ?? Math.min(L.maxVus, Math.max(10, Math.ceil(rate * 2)));
      const max = p.maxVUs ?? Math.min(L.maxVus, Math.max(pre, Math.ceil(rate * 20)));
      if (rate > L.maxRate) errors.push(`rate can be at most ${L.maxRate}`);
      info = {
        scenario: { executor: 'constant-arrival-rate', ...rateSpec(rate), duration: `${duration}s`, preAllocatedVUs: pre, maxVUs: max, gracefulStop: gs },
        estDurationSec: duration,
        peakVus: max,
        arrival: true,
      };
      break;
    }
    case 'ramp':
    case 'stress':
    case 'spike': {
      const vus = p.vus ?? 50;
      const stages = p.stages?.length ? p.stages : defaultStages(p.kind, vus, p.duration ?? 300);
      info = {
        scenario: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: stages.map((s) => ({ duration: `${s.duration}s`, target: s.target })),
          gracefulRampDown: gs,
          gracefulStop: gs,
        },
        estDurationSec: stages.reduce((a, s) => a + s.duration, 0),
        peakVus: Math.max(...stages.map((s) => s.target)),
        arrival: false,
      };
      break;
    }
    case 'breakpoint': {
      const maxRate = p.maxRate ?? 500;
      const startRate = p.startRate ?? 1;
      const duration = p.duration ?? 600;
      const pre = p.preAllocatedVUs ?? Math.min(L.maxVus, Math.max(20, Math.ceil(startRate * 4)));
      const max = p.maxVUs ?? L.maxVus;
      if (maxRate > L.maxRate) errors.push(`maxRate can be at most ${L.maxRate}`);
      const stages = p.stages?.length
        ? p.stages.map((s) => ({ duration: `${s.duration}s`, target: s.target }))
        : [{ duration: `${duration}s`, target: maxRate }];
      info = {
        scenario: { executor: 'ramping-arrival-rate', startRate, timeUnit: '1s', preAllocatedVUs: pre, maxVUs: max, stages, gracefulStop: gs },
        estDurationSec: p.stages?.length ? p.stages.reduce((a, s) => a + s.duration, 0) : duration,
        peakVus: max,
        arrival: true,
      };
      break;
    }
  }

  if (info.peakVus > L.maxVus) errors.push(`VU count can be at most ${L.maxVus} (requested: ${info.peakVus})`);
  if (info.estDurationSec > L.maxDurationSec) errors.push(`duration can be at most ${L.maxDurationSec} s`);
  if (errors.length) throw new CompileError(errors);
  return info;
}

export interface RunnerConfig {
  debug: boolean;
  baseUrl: string;
  allowedHosts: string[];
  headers: Record<string, string>;
  variables: Record<string, string>;
  datasets: Record<string, Record<string, unknown>[]>;
  timeout: string;
  flows: { id: string; name: string; weight: number; resetSession: boolean; variables: Record<string, string>; steps: Step[] }[];
  options: Record<string, unknown>;
  meta: { kind: Profile['kind']; estDurationSec: number; peakVus: number; arrival: boolean; autoStop: PlanConfig['autoStop']; shards: number };
}

export async function compileRun(site: SiteRow, planInput: unknown, load: WorkflowLoader): Promise<{ runner: RunnerConfig; plan: PlanConfig }> {
  const plan = parsePlanConfig(planInput);
  const errors: string[] = [];
  const allowed = siteHosts(site);
  const flows: RunnerConfig['flows'] = [];

  for (const f of plan.flows) {
    if (f.weight <= 0) continue;
    const wf = await load(f.workflowId);
    if (!wf) {
      errors.push(`workflow not found: ${f.workflowId}`);
      continue;
    }
    try {
      const def = parseWorkflowDefinition(wf.definition);
      const steps = await inlineIncludes(def.steps, load, [wf.id]);
      checkStaticHosts(steps, allowed, errors, `${wf.name}.`);
      flows.push({ id: wf.id, name: wf.name, weight: f.weight, resetSession: def.resetSession ?? true, variables: def.variables ?? {}, steps });
    } catch (e) {
      if (e instanceof CompileError) errors.push(...e.errors.map((x) => `${wf.name}: ${x}`));
      else throw e;
    }
  }
  if (!flows.length && !errors.length) errors.push('at least one workflow with weight greater than 0 is required');

  let sc: ScenarioInfo | null = null;
  try {
    sc = buildScenario(plan.profile, plan.options.gracefulStopSec ?? 10);
  } catch (e) {
    if (e instanceof CompileError) errors.push(...e.errors);
    else throw e;
  }

  // A debug run is one VU; splitting it makes no sense. Every shard needs at least one VU.
  const shards = plan.profile.kind === 'debug' ? 1 : (plan.options.workers ?? 1);
  if (sc && shards > 1) {
    const minVus = sc.arrival ? Number((sc.scenario as { preAllocatedVUs: number }).preAllocatedVUs) : sc.peakVus;
    if (shards > minVus) errors.push(`workers (${shards}) cannot exceed the VU count (${minVus}); each worker needs at least one VU`);
  }

  if (plan.profile.kind === 'breakpoint') {
    if (!plan.autoStop.p95Ms && !plan.autoStop.errorRate) {
      errors.push('a breakpoint test requires an auto-stop threshold (p95 ms or error rate)');
    }
    plan.autoStop.enabled = true;
  }
  if (errors.length || !sc) throw new CompileError(errors);

  const thresholds: Record<string, string[]> = {};
  const t = plan.thresholds;
  const dur: string[] = [];
  if (t.p95Ms) dur.push(`p(95)<${t.p95Ms}`);
  if (t.p99Ms) dur.push(`p(99)<${t.p99Ms}`);
  if (dur.length) thresholds.http_req_duration = dur;
  if (t.errorRate !== undefined) thresholds.http_req_failed = [`rate<${t.errorRate}`];
  if (t.checksRate !== undefined) thresholds.checks = [`rate>${t.checksRate}`];

  const options: Record<string, unknown> = {
    scenarios: { main: sc.scenario },
    thresholds,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    insecureSkipTLSVerify: plan.options.insecureSkipTLSVerify ?? false,
    userAgent: plan.options.userAgent || 'LoadLab/1.0 (+k6)',
    noVUConnectionReuse: false,
    setupTimeout: '30s',
    teardownTimeout: '30s',
  };

  return {
    plan,
    runner: {
      debug: plan.profile.kind === 'debug',
      baseUrl: site.baseUrl.replace(/\/$/, ''),
      allowedHosts: allowed,
      headers: site.headers ?? {},
      variables: site.variables ?? {},
      datasets: site.datasets ?? {},
      timeout: `${plan.options.httpTimeoutSec ?? 30}s`,
      flows,
      options,
      meta: { kind: plan.profile.kind, estDurationSec: sc.estDurationSec, peakVus: sc.peakVus, arrival: sc.arrival, autoStop: plan.autoStop, shards },
    },
  };
}
