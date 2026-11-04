// LoadLab generic k6 runner.
// Reads the workflow JSON (RUNNER_CONFIG) and interprets the steps on every iteration.
// Interpreting instead of generating code: a single, tested script; no injection risk.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { parseHTML } from 'k6/html';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { browser } from 'k6/browser';

const CONFIG = JSON.parse(open(__ENV.RUNNER_CONFIG));

export const options = CONFIG.options;

const flowCompleted = new Counter('flow_completed');
const flowAborted = new Counter('flow_aborted');
const flowDuration = new Trend('flow_duration', true);
// browser steps aren't HTTP requests: their timings and failures get their own metrics
const browserStepDuration = new Trend('browser_step_duration', true);
const browserStepFailed = new Counter('browser_step_failed');
const browserBlocked = new Counter('browser_blocked');

const ALLOWED = CONFIG.allowedHosts.map((h) => h.toLowerCase());
const HTTP_FLOWS = CONFIG.flows.filter((f) => f.engine !== 'browser');
const BROWSER_FLOWS = CONFIG.flows.filter((f) => f.engine === 'browser');

// Persistent per-VU cookie jar (for flows with resetSession=false)
let vuJar = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randString(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function lookup(path, ctx) {
  const parts = path.split('.');
  let cur;
  if (parts[0] === 'data') {
    cur = ctx.data;
    parts.shift();
  } else if (Object.prototype.hasOwnProperty.call(ctx.vars, parts[0])) {
    cur = ctx.vars;
  } else {
    return undefined;
  }
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function evalExpr(expr, ctx) {
  expr = expr.trim();
  if (expr[0] !== '$') {
    const v = lookup(expr, ctx);
    return v === undefined ? '' : v;
  }
  const [fn, ...args] = expr.split(/\s+/);
  switch (fn) {
    case '$randomInt':
      return randInt(Number(args[0] || 0), Number(args[1] || 1000));
    case '$randomString':
      return randString(Number(args[0] || 8));
    case '$uuid':
      return uuid();
    case '$timestamp':
      return Date.now();
    case '$isoDate':
      return new Date().toISOString();
    case '$vu':
      return exec.vu.idInTest;
    case '$iter':
      return exec.vu.iterationInScenario;
    case '$randomEmail':
      return `loadlab+${randString(10)}@example.com`;
    case '$randomItem': {
      const list = lookup(args[0] || '', ctx);
      if (Array.isArray(list) && list.length) return list[Math.floor(Math.random() * list.length)];
      return '';
    }
    case '$num': {
      const v = Number(args.length > 1 || !/^[A-Za-z_]/.test(args[0] || '') ? args[0] : lookup(args[0] || '', ctx));
      return Number.isFinite(v) ? v : 0;
    }
    case '$urlencode':
      return encodeURIComponent(String(lookup(args[0] || '', ctx) ?? ''));
    default:
      return '';
  }
}

const TPL = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;

function render(str, ctx) {
  if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
  return str.replace(TPL, (_, e) => {
    const v = evalExpr(e, ctx);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// For JSON bodies: if the value is exactly "{{x}}", keep its raw type
function renderDeep(val, ctx) {
  if (typeof val === 'string') {
    const m = WHOLE.exec(val);
    if (m) return evalExpr(m[1], ctx);
    return render(val, ctx);
  }
  if (Array.isArray(val)) return val.map((v) => renderDeep(v, ctx));
  if (val && typeof val === 'object') {
    const o = {};
    for (const k of Object.keys(val)) o[k] = renderDeep(val[k], ctx);
    return o;
  }
  return val;
}

function originOf(url) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1] : '';
}

function hostOf(url) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

function hostAllowed(url) {
  const h = hostOf(url);
  if (!h) return false;
  return ALLOWED.some((a) => a === h || (a.startsWith('*.') && (h.endsWith(a.slice(1)) || h === a.slice(2))));
}

function resolveUrl(raw, ctx, relativeTo) {
  const u = render(raw, ctx);
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return (relativeTo || CONFIG.baseUrl).split(':')[0] + ':' + u;
  if (u.startsWith('/')) return (relativeTo ? originOf(relativeTo) : CONFIG.baseUrl) + u;
  if (relativeTo) {
    const base = relativeTo.split(/[?#]/)[0];
    return base.substring(0, base.lastIndexOf('/') + 1) + u.replace(/^(\.\/)+/, '');
  }
  return CONFIG.baseUrl + '/' + u;
}

function withQuery(url, query, ctx) {
  if (!query) return url;
  const parts = Object.keys(query).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(render(query[k], ctx))}`);
  if (!parts.length) return url;
  return url + (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
}

// simple JSON path: a.b[0].c, items[*].id
function jsonPath(obj, path) {
  const tokens = [];
  path.replace(/\[(\*|\d+)\]|([^.[\]]+)/g, (_, idx, key) => {
    tokens.push(idx !== undefined ? idx : key);
    return '';
  });
  let cur = [obj];
  let multi = false;
  for (const t of tokens) {
    const next = [];
    for (const c of cur) {
      if (c === null || c === undefined) continue;
      if (t === '*') {
        multi = true;
        if (Array.isArray(c)) next.push(...c);
        else if (typeof c === 'object') next.push(...Object.values(c));
      } else if (c[t] !== undefined) {
        next.push(c[t]);
      }
    }
    cur = next;
  }
  if (multi) return cur;
  return cur.length ? cur[0] : undefined;
}

function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    return undefined;
  }
}

function pickFrom(values, pick) {
  if (!values.length) return undefined;
  if (pick === 'all') return values;
  if (pick === 'random') return values[Math.floor(Math.random() * values.length)];
  return values[0];
}

function runExtract(res, rules, ctx, pageUrl) {
  const out = {};
  let ok = true;
  for (const r of rules || []) {
    let values = [];
    try {
      if (r.from === 'json') {
        const v = jsonPath(safeJson(res), r.path || '');
        if (Array.isArray(v)) values = v;
        else if (v !== undefined) values = [v];
      } else if (r.from === 'regex') {
        const re = new RegExp(r.pattern || '', 'g');
        const body = String(res.body || '');
        let m;
        while ((m = re.exec(body)) !== null && values.length < 500) {
          values.push(m[1] !== undefined ? m[1] : m[0]);
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      } else if (r.from === 'header') {
        const name = (r.name || '').toLowerCase();
        for (const k of Object.keys(res.headers)) if (k.toLowerCase() === name) values.push(res.headers[k]);
      } else if (r.from === 'cookie') {
        const c = res.cookies[r.name || ''];
        if (c && c.length) values = c.map((x) => x.value);
      } else if (r.from === 'html') {
        const doc = parseHTML(String(res.body || ''));
        doc.find(r.selector || '').each((_, el) => {
          if (values.length >= 500) return;
          const v = r.attr ? el.getAttribute(r.attr) : el.textContent();
          if (v !== undefined && v !== null && String(v).trim() !== '') {
            // make relative links like href/src absolute
            values.push(r.attr && /^(href|src|action)$/.test(r.attr) ? resolveUrl(String(v).trim(), ctx, pageUrl) : String(v).trim());
          }
        });
      }
    } catch (e) {
      values = [];
    }
    const picked = pickFrom(values, r.pick);
    if (picked === undefined) {
      if (r.required) ok = false;
      continue;
    }
    ctx.vars[r.var] = picked;
    out[r.var] = picked;
  }
  return { ok, out };
}

function runChecks(res, step, flowName) {
  const checks = {};
  const list = step.checks || [];
  for (const c of list) {
    let label;
    let fn;
    switch (c.type) {
      case 'status': {
        const vals = Array.isArray(c.value) ? c.value : [c.value];
        label = `status ${vals.join('|')}`;
        fn = (r) => vals.indexOf(r.status) !== -1;
        break;
      }
      case 'bodyContains':
        label = `contains "${c.value.slice(0, 40)}"`;
        fn = (r) => String(r.body || '').indexOf(c.value) !== -1;
        break;
      case 'bodyNotContains':
        label = `not contains "${c.value.slice(0, 40)}"`;
        fn = (r) => String(r.body || '').indexOf(c.value) === -1;
        break;
      case 'jsonPath':
        label = `json ${c.path}${c.equals !== undefined ? ' = ' + JSON.stringify(c.equals) : ''}`;
        fn = (r) => {
          const v = jsonPath(safeJson(r), c.path);
          if (c.equals !== undefined) return JSON.stringify(v) === JSON.stringify(c.equals);
          return c.exists === false ? v === undefined : v !== undefined;
        };
        break;
      case 'maxDuration':
        label = `duration < ${c.ms}ms`;
        fn = (r) => r.timings.duration < c.ms;
        break;
      case 'header':
        label = `header ${c.name}`;
        fn = (r) => {
          const n = c.name.toLowerCase();
          const k = Object.keys(r.headers).find((x) => x.toLowerCase() === n);
          if (!k) return false;
          return c.contains ? String(r.headers[k]).indexOf(c.contains) !== -1 : true;
        };
        break;
      default:
        continue;
    }
    checks[`${step.name}: ${label}`] = fn;
  }
  if (!list.length) return { ok: true, results: [] };
  const results = [];
  const wrapped = {};
  for (const name of Object.keys(checks)) {
    wrapped[name] = (r) => {
      const v = !!checks[name](r);
      results.push({ name, ok: v });
      return v;
    };
  }
  const ok = check(res, wrapped, { flow: flowName, step: step.name });
  return { ok, results };
}

function debugLog(entry) {
  if (!CONFIG.debug) return;
  console.log('__LLDBG__' + JSON.stringify(entry));
}

function truncate(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------------------
// step executors
// ---------------------------------------------------------------------------

function httpStep(step, ctx, flowName) {
  const isPage = step.type === 'page';
  const method = isPage ? 'GET' : step.method || 'GET';
  const url = withQuery(resolveUrl(step.url, ctx), step.query, ctx);
  const tags = { flow: flowName, step: step.name, name: step.name };

  if (!hostAllowed(url)) {
    debugLog({ flow: flowName, step: step.name, method, url, ok: false, error: 'host not allowed' });
    console.warn(`blocked disallowed host: ${url}`);
    return false;
  }

  const headers = {};
  for (const k of Object.keys(CONFIG.headers)) headers[k] = render(CONFIG.headers[k], ctx);
  for (const k of Object.keys(step.headers || {})) headers[k] = render(step.headers[k], ctx);

  let body = null;
  if (!isPage && step.body) {
    const b = step.body;
    if (b.mode === 'json') {
      body = JSON.stringify(renderDeep(b.content, ctx));
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = b.contentType || 'application/json';
    } else if (b.mode === 'form') {
      body = renderDeep(b.content || {}, ctx);
    } else {
      body = render(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), ctx);
      if (b.contentType) headers['Content-Type'] = b.contentType;
    }
  }

  const params = { headers, tags, timeout: step.timeoutMs ? `${step.timeoutMs}ms` : CONFIG.timeout, jar: ctx.jar };
  if (step.followRedirects === false) params.redirects = 0;
  if (step.expectStatus && step.expectStatus.length) params.responseCallback = http.expectedStatuses(...step.expectStatus);

  const res = http.request(method, url, body, params);

  let ok = res.status !== 0 && !(res.error && res.status === 0);
  if (step.expectStatus && step.expectStatus.length) ok = ok && step.expectStatus.indexOf(res.status) !== -1;
  else ok = ok && res.status < 400;

  const chk = runChecks(res, step, flowName);
  ok = ok && chk.ok;

  const ex = runExtract(res, step.extract, ctx, url);
  ok = ok && ex.ok;

  if (isPage && step.assets && res.status === 200 && res.body) {
    loadAssets(res, url, step, ctx, flowName);
  }

  debugLog({
    flow: flowName,
    step: step.name,
    method,
    url,
    status: res.status,
    durationMs: Math.round(res.timings.duration * 10) / 10,
    ok,
    error: res.error || undefined,
    checks: chk.results,
    extracted: Object.fromEntries(Object.entries(ex.out).map(([k, v]) => [k, truncate(v, 300)])),
    bodyPreview: truncate(String(res.body || ''), ok ? 300 : 1500),
  });
  return ok;
}

function loadAssets(res, pageUrl, step, ctx, flowName) {
  const max = step.maxAssets || 20;
  const urls = [];
  try {
    const doc = parseHTML(String(res.body));
    const add = (v) => {
      if (!v || urls.length >= max || v.startsWith('data:')) return;
      const abs = resolveUrl(v, ctx, pageUrl);
      if (hostAllowed(abs) && urls.indexOf(abs) === -1) urls.push(abs);
    };
    doc.find('link[rel=stylesheet], link[rel=modulepreload], link[rel=preload]').each((_, el) => add(el.getAttribute('href')));
    doc.find('script[src]').each((_, el) => add(el.getAttribute('src')));
    doc.find('img[src]').each((_, el) => add(el.getAttribute('src')));
  } catch (e) {
    return;
  }
  if (!urls.length) return;
  const tags = { flow: flowName, step: `${step.name} (assets)`, name: `${step.name} (assets)` };
  http.batch(urls.map((u) => ['GET', u, null, { tags, jar: ctx.jar, timeout: CONFIG.timeout }]));
}

function shouldRun(step) {
  return step.probability === undefined || step.probability === null || Math.random() < step.probability;
}

// true: continue, false: end the iteration
function runSteps(steps, ctx, flowName) {
  for (const step of steps) {
    if (!shouldRun(step)) continue;
    switch (step.type) {
      case 'request':
      case 'page': {
        const ok = httpStep(step, ctx, flowName);
        if (!ok && step.abortOnFail !== false) {
          flowAborted.add(1, { flow: flowName, step: step.name });
          return false;
        }
        break;
      }
      case 'think': {
        const min = step.min || 0;
        const max = Math.max(min, step.max || min);
        if (!CONFIG.debug) sleep(min + Math.random() * (max - min));
        break;
      }
      case 'set':
        for (const k of Object.keys(step.vars || {})) ctx.vars[k] = renderDeep(step.vars[k], ctx);
        break;
      case 'group': {
        const r = step.repeat;
        const n = r ? randInt(r.min, Math.max(r.min, r.max)) : 1;
        for (let i = 0; i < n; i++) {
          if (!runSteps(step.steps || [], ctx, flowName)) {
            if (step.abortOnFail === false) break;
            return false;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return true;
}

function pickFlow(flows) {
  if (flows.length === 1) return flows[0];
  let r = Math.random() * flows.reduce((a, f) => a + f.weight, 0);
  for (const f of flows) {
    r -= f.weight;
    if (r <= 0) return f;
  }
  return flows[flows.length - 1];
}

function datasetRow() {
  const out = {};
  for (const name of Object.keys(CONFIG.datasets || {})) {
    const rows = CONFIG.datasets[name];
    if (rows && rows.length) out[name] = rows[(exec.vu.idInTest - 1) % rows.length];
  }
  return out;
}

function newCtx(flow, jar) {
  const ctx = { vars: Object.assign({ baseUrl: CONFIG.baseUrl }, CONFIG.variables, flow.variables), data: datasetRow(), jar };
  // site/flow variables may themselves contain templates
  for (const k of Object.keys(ctx.vars)) ctx.vars[k] = render(ctx.vars[k], ctx);
  return ctx;
}

export default function () {
  const flow = pickFlow(HTTP_FLOWS);
  if (!vuJar) vuJar = http.cookieJar();
  const ctx = newCtx(flow, flow.resetSession ? new http.CookieJar() : vuJar);

  const start = Date.now();
  const ok = runSteps(flow.steps, ctx, flow.name);
  if (ok) {
    flowCompleted.add(1, { flow: flow.name });
    flowDuration.add(Date.now() - start, { flow: flow.name });
  }
}

// ---------------------------------------------------------------------------
// browser workflows (k6/browser, Chromium)
// ---------------------------------------------------------------------------

async function browserStep(step, ctx, page, flowName) {
  const name = step.name || step.type;
  const tags = { flow: flowName, step: name };
  const timeout = step.timeoutMs || 30000;
  const sel = step.selector ? render(step.selector, ctx) : '';
  const start = Date.now();
  const entry = { flow: flowName, step: name, method: step.type.toUpperCase(), url: undefined, status: undefined };
  const extracted = {};
  let ok = true;
  let error;
  try {
    switch (step.type) {
      case 'goto': {
        const url = resolveUrl(step.url, ctx);
        entry.url = url;
        if (!hostAllowed(url)) throw new Error('host not allowed');
        const res = await page.goto(url, { waitUntil: step.waitUntil || 'load', timeout });
        if (res) {
          entry.status = res.status();
          if (entry.status >= 400) {
            ok = false;
            error = `HTTP ${entry.status}`;
          }
        }
        break;
      }
      case 'click':
      case 'press': {
        const loc = page.locator(sel);
        const act = () => (step.type === 'click' ? loc.click({ timeout }) : loc.press(render(step.key, ctx), { timeout }));
        if (step.waitForNavigation) await Promise.all([page.waitForNavigation({ timeout }), act()]);
        else await act();
        break;
      }
      case 'fill':
        await page.locator(sel).fill(String(render(step.value, ctx)), { timeout });
        break;
      case 'select':
        await page.locator(sel).selectOption(String(render(step.value, ctx)), { timeout });
        break;
      case 'waitFor':
        await page.locator(sel).waitFor({ state: step.state || 'visible', timeout });
        break;
      case 'expect': {
        if (step.urlContains) {
          const want = render(step.urlContains, ctx);
          if (page.url().indexOf(want) === -1) {
            ok = false;
            error = `URL does not contain "${want}": ${page.url()}`;
          }
        }
        if (ok && sel) {
          const loc = page.locator(sel);
          await loc.waitFor({ state: step.visible === false ? 'hidden' : 'visible', timeout });
          if (step.textContains && step.visible !== false) {
            const want = render(step.textContains, ctx);
            const text = (await loc.textContent()) || '';
            if (text.indexOf(want) === -1) {
              ok = false;
              error = `text does not contain "${want}": "${truncate(text.trim(), 120)}"`;
            }
          }
        }
        break;
      }
      case 'read': {
        const values = [];
        for (const el of await page.$$(sel)) {
          if (values.length >= 500) break;
          const v = step.attr ? await el.getAttribute(step.attr) : await el.textContent();
          if (v !== undefined && v !== null && String(v).trim() !== '') {
            values.push(step.attr && /^(href|src|action)$/.test(step.attr) ? resolveUrl(String(v).trim(), ctx, page.url()) : String(v).trim());
          }
        }
        const picked = pickFrom(values, step.pick);
        if (picked === undefined) {
          if (step.required) {
            ok = false;
            error = `nothing matched ${sel}`;
          }
        } else {
          ctx.vars[step.var] = picked;
          extracted[step.var] = truncate(picked, 300);
        }
        break;
      }
      default:
        break;
    }
  } catch (e) {
    ok = false;
    error = String((e && e.message) || e).split('\n')[0];
  }
  const ms = Date.now() - start;
  browserStepDuration.add(ms, tags);
  if (!ok) browserStepFailed.add(1, tags);
  // expectations also count as checks, so they show up next to the HTTP checks
  if (step.type === 'expect') check(null, { [`${name}: expect`]: () => ok }, tags);
  debugLog(Object.assign(entry, { url: entry.url || page.url(), durationMs: ms, ok, error, extracted }));
  return ok;
}

async function runBrowserSteps(steps, ctx, page, flowName) {
  for (const step of steps) {
    if (!shouldRun(step)) continue;
    switch (step.type) {
      case 'think': {
        const min = step.min || 0;
        const max = Math.max(min, step.max || min);
        if (!CONFIG.debug) await page.waitForTimeout((min + Math.random() * (max - min)) * 1000);
        break;
      }
      case 'set':
        for (const k of Object.keys(step.vars || {})) ctx.vars[k] = renderDeep(step.vars[k], ctx);
        break;
      case 'group': {
        const r = step.repeat;
        const n = r ? randInt(r.min, Math.max(r.min, r.max)) : 1;
        for (let i = 0; i < n; i++) {
          if (!(await runBrowserSteps(step.steps || [], ctx, page, flowName))) {
            if (step.abortOnFail === false) break;
            return false;
          }
        }
        break;
      }
      default: {
        const ok = await browserStep(step, ctx, page, flowName);
        if (!ok && step.abortOnFail !== false) {
          flowAborted.add(1, { flow: flowName, step: step.name || step.type });
          return false;
        }
      }
    }
  }
  return true;
}

export async function browserFlow() {
  const flow = pickFlow(BROWSER_FLOWS);
  const ctx = newCtx(flow, null);
  const headers = {};
  for (const k of Object.keys(CONFIG.headers)) headers[k] = String(render(CONFIG.headers[k], ctx));
  // every iteration is a new visitor: a fresh context has no cookies or storage
  const context = await browser.newContext({ ignoreHTTPSErrors: !!CONFIG.options.insecureSkipTLSVerify, extraHTTPHeaders: headers });
  const page = await context.newPage();
  // Chromium already can't reach other hosts (see browserEnv in the executor); this also counts what was blocked
  await page.route(/.*/, async (route) => {
    const url = route.request().url();
    if (/^(data|blob|about):/i.test(url) || hostAllowed(url)) return route.continue();
    browserBlocked.add(1, { host: hostOf(url) || url.split(':')[0] });
    return route.abort();
  });
  const start = Date.now();
  try {
    const ok = await runBrowserSteps(flow.steps, ctx, page, flow.name);
    if (ok) {
      flowCompleted.add(1, { flow: flow.name });
      flowDuration.add(Date.now() - start, { flow: flow.name });
    }
  } finally {
    await page.close();
    await context.close();
  }
}

export function handleSummary(data) {
  const out = {};
  if (__ENV.SUMMARY_PATH) out[__ENV.SUMMARY_PATH] = JSON.stringify(data);
  return out;
}
