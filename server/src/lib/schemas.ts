import { z } from 'zod';

// ---------------------------------------------------------------------------
// Workflow DSL
// ---------------------------------------------------------------------------

const probability = z.number().min(0).max(1).optional();

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), value: z.union([z.number().int(), z.array(z.number().int())]) }),
  z.object({ type: z.literal('bodyContains'), value: z.string().min(1) }),
  z.object({ type: z.literal('bodyNotContains'), value: z.string().min(1) }),
  z.object({ type: z.literal('jsonPath'), path: z.string().min(1), exists: z.boolean().optional(), equals: z.any().optional() }),
  z.object({ type: z.literal('maxDuration'), ms: z.number().positive() }),
  z.object({ type: z.literal('header'), name: z.string().min(1), contains: z.string().optional() }),
]);

export const ExtractSchema = z.object({
  var: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'variable name must contain only letters/digits/_'),
  from: z.enum(['json', 'regex', 'header', 'cookie', 'html']),
  path: z.string().optional(), // json: data.items[*].id
  pattern: z.string().optional(), // regex: the first capture group is used
  name: z.string().optional(), // header / cookie name
  selector: z.string().optional(), // html: CSS selector
  attr: z.string().optional(), // html: attribute (text if omitted)
  pick: z.enum(['first', 'random', 'all']).optional(),
  required: z.boolean().optional(),
});

const BodySchema = z.object({
  mode: z.enum(['json', 'form', 'raw']),
  content: z.any(),
  contentType: z.string().optional(),
});

const common = {
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  probability,
  abortOnFail: z.boolean().optional(),
};

export const RequestStepSchema = z.object({
  type: z.literal('request'),
  ...common,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
  body: BodySchema.optional(),
  checks: z.array(CheckSchema).optional(),
  extract: z.array(ExtractSchema).optional(),
  expectStatus: z.array(z.number().int()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  followRedirects: z.boolean().optional(),
});

export const PageStepSchema = z.object({
  type: z.literal('page'),
  ...common,
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  assets: z.boolean().optional(),
  maxAssets: z.number().int().min(1).max(100).optional(),
  checks: z.array(CheckSchema).optional(),
  extract: z.array(ExtractSchema).optional(),
});

export const ThinkStepSchema = z.object({
  type: z.literal('think'),
  id: z.string().optional(),
  name: z.string().optional(),
  min: z.number().min(0).max(600),
  max: z.number().min(0).max(600),
});

export const SetStepSchema = z.object({
  type: z.literal('set'),
  id: z.string().optional(),
  name: z.string().optional(),
  vars: z.record(z.string(), z.string()),
});

export const IncludeStepSchema = z.object({
  type: z.literal('include'),
  id: z.string().optional(),
  name: z.string().optional(),
  workflowId: z.string().uuid(),
  probability,
});

// Browser steps (engine: "browser") drive a real Chromium page through k6/browser.
const browserCommon = { ...common, timeoutMs: z.number().int().positive().max(120_000).optional() };
const selector = z.string().min(1);

export const GotoStepSchema = z.object({
  type: z.literal('goto'),
  ...browserCommon,
  url: z.string().min(1),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
});
export const ClickStepSchema = z.object({ type: z.literal('click'), ...browserCommon, selector, waitForNavigation: z.boolean().optional() });
export const FillStepSchema = z.object({ type: z.literal('fill'), ...browserCommon, selector, value: z.string() });
export const SelectStepSchema = z.object({ type: z.literal('select'), ...browserCommon, selector, value: z.string() });
export const PressStepSchema = z.object({
  type: z.literal('press'),
  ...browserCommon,
  selector,
  key: z.string().min(1),
  waitForNavigation: z.boolean().optional(),
});
export const WaitForStepSchema = z.object({
  type: z.literal('waitFor'),
  ...browserCommon,
  selector,
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
});
export const ExpectStepSchema = z
  .object({
    type: z.literal('expect'),
    ...browserCommon,
    selector: z.string().min(1).optional(),
    visible: z.boolean().optional(),
    textContains: z.string().optional(),
    urlContains: z.string().optional(),
  })
  .refine((s) => s.selector || s.urlContains, 'expect needs a selector or urlContains');
export const ReadStepSchema = z.object({
  type: z.literal('read'),
  ...browserCommon,
  selector,
  var: ExtractSchema.shape.var,
  attr: z.string().optional(),
  pick: z.enum(['first', 'random', 'all']).optional(),
  required: z.boolean().optional(),
});

export const BROWSER_STEP_TYPES = ['goto', 'click', 'fill', 'select', 'press', 'waitFor', 'expect', 'read'] as const;
export const HTTP_STEP_TYPES = ['request', 'page'] as const;

export type Check = z.infer<typeof CheckSchema>;
export type Extract = z.infer<typeof ExtractSchema>;
export type RequestStep = z.infer<typeof RequestStepSchema>;
export type PageStep = z.infer<typeof PageStepSchema>;
export type ThinkStep = z.infer<typeof ThinkStepSchema>;
export type SetStep = z.infer<typeof SetStepSchema>;
export type IncludeStep = z.infer<typeof IncludeStepSchema>;
export type BrowserStep =
  | z.infer<typeof GotoStepSchema>
  | z.infer<typeof ClickStepSchema>
  | z.infer<typeof FillStepSchema>
  | z.infer<typeof SelectStepSchema>
  | z.infer<typeof PressStepSchema>
  | z.infer<typeof WaitForStepSchema>
  | z.infer<typeof ExpectStepSchema>
  | z.infer<typeof ReadStepSchema>;
export type GroupStep = {
  type: 'group';
  id?: string;
  name: string;
  probability?: number;
  abortOnFail?: boolean;
  repeat?: { min: number; max: number };
  steps: Step[];
};
export type Step = RequestStep | PageStep | ThinkStep | SetStep | IncludeStep | GroupStep | BrowserStep;

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('type', [
    RequestStepSchema,
    PageStepSchema,
    ThinkStepSchema,
    SetStepSchema,
    IncludeStepSchema,
    GroupStepSchema,
    GotoStepSchema,
    ClickStepSchema,
    FillStepSchema,
    SelectStepSchema,
    PressStepSchema,
    WaitForStepSchema,
    ExpectStepSchema,
    ReadStepSchema,
  ]),
) as unknown as z.ZodType<Step>;

const GroupStepSchema = z.object({
  type: z.literal('group'),
  ...common,
  repeat: z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) }).optional(),
  steps: z.array(z.lazy(() => StepSchema)),
});

export const WORKFLOW_ENGINES = ['http', 'browser'] as const;

export const WorkflowDefinitionSchema = z.object({
  /** http (default): protocol-level requests. browser: a real Chromium page (k6/browser), for front-end metrics. */
  engine: z.enum(WORKFLOW_ENGINES).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  resetSession: z.boolean().optional(),
  steps: z.array(StepSchema).min(1, 'at least one step is required'),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Test plan
// ---------------------------------------------------------------------------

export const PROFILE_KINDS = ['smoke', 'constant_vus', 'constant_rate', 'ramp', 'stress', 'spike', 'soak', 'breakpoint', 'debug'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const StageSchema = z.object({ duration: z.number().int().min(1), target: z.number().int().min(0) });

export const ProfileSchema = z.object({
  kind: z.enum(PROFILE_KINDS),
  vus: z.number().int().min(1).optional(),
  duration: z.number().int().min(1).optional(), // seconds
  rate: z.number().min(0.01).optional(), // iterations / sec
  stages: z.array(StageSchema).optional(),
  startRate: z.number().min(0).optional(),
  maxRate: z.number().min(1).optional(),
  preAllocatedVUs: z.number().int().min(1).optional(),
  maxVUs: z.number().int().min(1).optional(),
  iterations: z.number().int().min(1).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const PlanConfigSchema = z.object({
  flows: z.array(z.object({ workflowId: z.string().uuid(), weight: z.number().min(0).default(1) })).min(1, 'select at least one workflow'),
  profile: ProfileSchema,
  thresholds: z
    .object({
      p95Ms: z.number().positive().optional(),
      p99Ms: z.number().positive().optional(),
      errorRate: z.number().min(0).max(1).optional(),
      checksRate: z.number().min(0).max(1).optional(),
    })
    .default({}),
  autoStop: z
    .object({
      enabled: z.boolean().default(false),
      p95Ms: z.number().positive().optional(),
      errorRate: z.number().min(0).max(1).optional(),
      windowSec: z.number().int().min(3).max(120).default(10),
      graceSec: z.number().int().min(0).max(600).default(15),
    })
    .default({ enabled: false, windowSec: 10, graceSec: 15 }),
  options: z
    .object({
      httpTimeoutSec: z.number().int().min(1).max(300).optional(),
      insecureSkipTLSVerify: z.boolean().optional(),
      userAgent: z.string().optional(),
      gracefulStopSec: z.number().int().min(0).max(300).optional(),
      /** Split the test across this many workers (k6 execution segments); each runs 1/N of the VUs and rate. */
      workers: z.number().int().min(1).max(32).optional(),
      /** Browser VUs that run the plan's browser workflows next to its HTTP load (only for mixed plans). */
      browserVus: z.number().int().min(1).max(100).optional(),
    })
    .default({}),
});
export type PlanConfig = z.infer<typeof PlanConfigSchema>;

export const SiteInputSchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'must be http(s)'),
  description: z.string().max(2000).optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  datasets: z.record(z.string(), z.array(z.record(z.string(), z.any()))).optional(),
});
export type SiteInput = z.infer<typeof SiteInputSchema>;

export function formatZodError(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

/** MCP and panel help text: human/LLM-readable description of the DSL. */
export const WORKFLOW_DSL_DOC = `
# LoadLab Workflow DSL

A workflow is the sequence of steps a virtual user (VU) performs in order on every iteration.
{ "variables": { "key": "value" }, "resetSession": true, "steps": [ ... ] }

- resetSession: true → each iteration is a new visitor (cookies are reset). false → the VU keeps its session.

## Step types
1. request  – a single HTTP request
   { "type":"request", "name":"Add to cart", "method":"POST", "url":"/api/cart",
     "headers":{"X-Token":"{{token}}"}, "query":{"q":"{{term}}"},
     "body":{"mode":"json","content":{"productId":"{{productId}}","qty":1}},
     "checks":[{"type":"status","value":200},{"type":"jsonPath","path":"cart.id","exists":true}],
     "extract":[{"var":"cartId","from":"json","path":"cart.id"}],
     "expectStatus":[200,201], "abortOnFail":true, "probability":1 }
   body.mode: json | form | raw. If url starts with "/" it is appended to the site's baseUrl.
2. page – HTML page visit (+ optionally loads css/js/img assets in parallel)
   { "type":"page", "name":"Home page", "url":"/", "assets":true, "maxAssets":20,
     "extract":[{"var":"productUrl","from":"html","selector":"a.product-link","attr":"href","pick":"random"}] }
3. think – user think time (seconds, random range)  { "type":"think", "min":1, "max":3 }
4. set – variable assignment  { "type":"set", "vars": { "qty": "{{$randomInt 1 3}}" } }
5. group – nested steps; probability and repeat
   { "type":"group", "name":"Browse products", "probability":0.6, "repeat":{"min":1,"max":4}, "steps":[ ... ] }
6. include – runs another workflow (shared module, e.g. "Log in") in place
   { "type":"include", "workflowId":"<uuid>" }

## Browser workflows (front-end metrics)
{ "engine":"browser", "steps":[ ... ] } runs the steps in a real Chromium page and records Web Vitals
(LCP, FCP, CLS, INP, TTFB). Browser VUs are expensive (about half a CPU core and 200 MB each), so a typical
plan mixes HTTP workflows for the load with a few browser VUs ("options.browserVus", default 1) that measure
what users see. A plan with only browser workflows runs its load profile with browser VUs (MAX_BROWSER_VUS caps it).
Steps (plus think, set, group and include of other browser workflows):
   { "type":"goto", "name":"Home", "url":"/", "waitUntil":"load" }          waitUntil: load | domcontentloaded | networkidle
   { "type":"click", "name":"Open product", "selector":"a.product", "waitForNavigation":true }
   { "type":"fill", "name":"Email", "selector":"#email", "value":"{{data.users.email}}" }
   { "type":"select", "selector":"select#size", "value":"M" }
   { "type":"press", "selector":"#search", "key":"Enter", "waitForNavigation":true }
   { "type":"waitFor", "selector":".cart-count", "state":"visible" }      state: visible | hidden | attached | detached
   { "type":"expect", "name":"Cart shows item", "selector":".cart", "textContains":"1 item" }   or "urlContains":"/checkout", "visible":false
   { "type":"read", "selector":"h1", "var":"title" }                       attr reads an attribute; pick: first | random | all
Selectors are Playwright-style CSS (also "text=Buy now"). timeoutMs per step (default 30000).
Requests to hosts outside the site's allowed hosts are blocked (third-party scripts, analytics) and reported.

## Common fields
- probability (0..1): the step runs with this probability (funnel: 60% click a product, 10% buy).
- abortOnFail (default true for request/page): if the step fails the iteration ends (no login means no purchase either).

## Checks
status{value:200 | [200,302]}, bodyContains{value}, bodyNotContains{value},
jsonPath{path, exists?, equals?}, maxDuration{ms}, header{name, contains?}

## Variable extraction (extract)
from: json(path: "data.items[*].id"), regex(pattern, first group), header(name), cookie(name),
html(selector, attr; text if attr is omitted). pick: first | random | all. required: true → the step fails if not found.

## Templates
"{{variable}}", site variables, "{{baseUrl}}", datasets "{{data.users.email}}" (each VU gets a different row).
Functions: {{$randomInt 1 100}}, {{$randomString 8}}, {{$uuid}}, {{$timestamp}}, {{$isoDate}},
{{$vu}}, {{$iter}}, {{$randomEmail}}, {{$randomItem listVariable}}, {{$urlencode variable}}.
If a JSON value is exactly "{{x}}", its raw type (number/array) is preserved.
`.trim();
