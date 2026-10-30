import { hostAllowed } from './compiler.js';
import type { Step, WorkflowDefinition } from './schemas.js';

const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3)(\?|$)/i;
const DROP_HEADERS = /^(:|cookie$|host$|content-length$|user-agent$|accept-encoding$|connection$|sec-|referer$|origin$|pragma$|cache-control$|upgrade-insecure-requests$|priority$|if-none-match$|if-modified-since$)/i;

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    postData?: { mimeType?: string; text?: string; params?: { name: string; value: string }[] };
  };
  response: { status: number; content?: { mimeType?: string } };
  _resourceType?: string;
}

export function harToWorkflow(har: any, baseUrl: string, allowed: string[], opts: { includeAssets?: boolean } = {}) {
  const entries: HarEntry[] = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Invalid HAR: log.entries not found');
  const origin = new URL(baseUrl).origin;
  const sorted = [...entries].sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  const steps: Step[] = [];
  let lastEnd: number | null = null;
  let skipped = 0;
  let pages = 0;

  for (const e of sorted) {
    let u: URL;
    try {
      u = new URL(e.request.url);
    } catch {
      skipped++;
      continue;
    }
    const method = e.request.method.toUpperCase();
    const mime = e.response?.content?.mimeType ?? '';
    const rt = e._resourceType ?? '';
    const isStatic = STATIC_EXT.test(u.pathname) || /^(image|font|text\/css|.*javascript)/.test(mime) || ['image', 'font', 'stylesheet', 'script', 'media'].includes(rt);
    if (!hostAllowed(u.hostname, allowed) || method === 'OPTIONS' || (isStatic && !opts.includeAssets) || e.response?.status === 0) {
      skipped++;
      continue;
    }
    const start = Date.parse(e.startedDateTime);
    if (lastEnd !== null) {
      const gap = (start - lastEnd) / 1000;
      if (gap >= 1) steps.push({ type: 'think', min: Math.round(Math.min(30, gap * 0.8) * 10) / 10, max: Math.round(Math.min(30, gap * 1.2) * 10) / 10 });
    }
    lastEnd = Math.max(lastEnd ?? 0, start + (e.time || 0));

    const url = u.origin === origin ? u.pathname + u.search : u.toString();
    const shortPath = u.pathname.length > 50 ? u.pathname.slice(0, 47) + '…' : u.pathname;
    const isDoc = method === 'GET' && (mime.includes('text/html') || rt === 'document');
    const status = e.response?.status;

    if (isDoc) {
      pages++;
      steps.push({ type: 'page', name: `Page ${shortPath}`, url, assets: true, maxAssets: 20, ...(status ? { checks: [{ type: 'status', value: status }] } : {}) });
      continue;
    }

    const headers: Record<string, string> = {};
    for (const h of e.request.headers ?? []) if (!DROP_HEADERS.test(h.name)) headers[h.name] = h.value;

    const step: Step = { type: 'request', name: `${method} ${shortPath}`, method: method as any, url };
    if (Object.keys(headers).length) step.headers = headers;
    const pd = e.request.postData;
    if (pd && method !== 'GET') {
      const mt = pd.mimeType ?? '';
      if (mt.includes('json') && pd.text) {
        try {
          step.body = { mode: 'json', content: JSON.parse(pd.text) };
        } catch {
          step.body = { mode: 'raw', content: pd.text, contentType: mt };
        }
      } else if (mt.includes('x-www-form-urlencoded')) {
        const params = pd.params?.length ? pd.params.map((p) => [p.name, p.value]) : [...new URLSearchParams(pd.text ?? '').entries()];
        step.body = { mode: 'form', content: Object.fromEntries(params.map(([k, v]) => [decodeURIComponent(k), decodeURIComponent(v)])) };
      } else if (pd.text) {
        step.body = { mode: 'raw', content: pd.text, contentType: mt || undefined };
      }
    }
    if (status) step.checks = [{ type: 'status', value: status }];
    steps.push(step);
  }

  if (!steps.length) throw new Error('No usable requests for this site\'s hosts were found in the HAR');
  const definition: WorkflowDefinition = { resetSession: true, steps };
  return { definition, stats: { total: entries.length, used: steps.filter((s) => s.type !== 'think').length, pages, skipped } };
}
