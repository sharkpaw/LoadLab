// End-to-end MCP OAuth 2.1 flow, as an MCP client performs it:
// discovery → dynamic client registration → PKCE authorize → sign-in → consent → token → MCP call.
//   BASE_URL=http://localhost:8080 ADMIN_EMAIL=… ADMIN_PASSWORD=… bun test/e2e/oauth.ts
import crypto from 'node:crypto';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const REDIRECT = 'http://127.0.0.1:33418/callback';
let cookie = '';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(url.startsWith('http') ? url : BASE + url, {
    method,
    redirect: 'manual',
    headers: {
      origin: BASE,
      ...(body !== undefined && !(body instanceof URLSearchParams) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : body instanceof URLSearchParams ? body : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = [...new Set([...cookie.split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])])].join('; ');
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { res, data };
}

const b64url = (b: Buffer) => b.toString('base64url');
const steps: [string, () => Promise<void>][] = [];
const step = (name: string, fn: () => Promise<void>) => steps.push([name, fn]);
const ctx: Record<string, any> = {};

step('unauthenticated /mcp returns an RFC 9728 challenge', async () => {
  const { res } = await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'application/json, text/event-stream' });
  const www = res.headers.get('www-authenticate') ?? '';
  assert(res.status === 401, `status ${res.status}`);
  const m = /resource_metadata="([^"]+)"/.exec(www);
  assert(m, `WWW-Authenticate has resource_metadata: ${www}`);
  ctx.prm = m[1];
});

step('discovery: protected resource + authorization server metadata', async () => {
  const prm = await req('GET', ctx.prm);
  assert(prm.res.status === 200 && prm.data.resource === `${BASE}/mcp`, `PRM ${prm.res.status} ${JSON.stringify(prm.data)}`);
  const issuer = prm.data.authorization_servers[0] as string;
  const u = new URL(issuer);
  const asm = await req('GET', `${u.origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`);
  assert(asm.res.status === 200 && asm.data.authorization_endpoint && asm.data.registration_endpoint, `AS metadata ${asm.res.status}`);
  assert(asm.data.code_challenge_methods_supported?.includes('S256'), 'PKCE S256 supported');
  ctx.as = asm.data;
});

step('dynamic client registration', async () => {
  const r = await req('POST', ctx.as.registration_endpoint, {
    client_name: 'LoadLab OAuth E2E',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  assert(r.res.status === 200 || r.res.status === 201, `register ${r.res.status} ${JSON.stringify(r.data)}`);
  ctx.clientId = r.data.client_id;
});

step('authorize without a session redirects to /login', async () => {
  ctx.verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(ctx.verifier).digest());
  ctx.state = b64url(crypto.randomBytes(8));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.clientId,
    redirect_uri: REDIRECT,
    scope: 'openid profile email offline_access',
    state: ctx.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  });
  const r = await req('GET', `${ctx.as.authorization_endpoint}?${q}`);
  const loc = r.res.headers.get('location') ?? '';
  assert(r.res.status === 302 && loc.includes('/login'), `authorize → ${r.res.status} ${loc}`);
  ctx.loginSearch = new URL(loc, BASE).search;
});

step('sign in continues the authorization (consent page)', async () => {
  const r = await req('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD, oauth_query: ctx.loginSearch.slice(1) });
  assert(r.res.status === 200, `sign-in ${r.res.status} ${JSON.stringify(r.data)}`);
  const url: string = r.data?.url ?? '';
  assert(url.includes('/consent') || url.startsWith(REDIRECT), `continue url: ${url}`);
  ctx.next = url;
});

step('consent issues an authorization code', async () => {
  let url: string = ctx.next;
  if (url.includes('/consent')) {
    const search = new URL(url, BASE).search.slice(1);
    const r = await req('POST', '/api/auth/oauth2/consent', { accept: true, oauth_query: search });
    assert(r.res.status === 200, `consent ${r.res.status} ${JSON.stringify(r.data)}`);
    url = r.data.url ?? r.data.redirect_uri;
  }
  const cb = new URL(url);
  assert(cb.origin + cb.pathname === REDIRECT && cb.searchParams.get('state') === ctx.state, `callback ${url}`);
  ctx.code = cb.searchParams.get('code');
  assert(ctx.code, 'code present');
});

step('token exchange with PKCE returns an access token bound to /mcp', async () => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: ctx.code,
    redirect_uri: REDIRECT,
    client_id: ctx.clientId,
    code_verifier: ctx.verifier,
    resource: `${BASE}/mcp`,
  });
  const r = await req('POST', ctx.as.token_endpoint, body, { 'content-type': 'application/x-www-form-urlencoded' });
  assert(r.res.status === 200 && r.data.access_token, `token ${r.res.status} ${JSON.stringify(r.data)}`);
  const payload = JSON.parse(Buffer.from(r.data.access_token.split('.')[1], 'base64url').toString());
  assert([payload.aud].flat().includes(`${BASE}/mcp`), `aud ${JSON.stringify(payload.aud)}`);
  ctx.token = r.data.access_token;
  ctx.refresh = r.data.refresh_token;
});

step('MCP accepts the OAuth token and rejects a tampered one', async () => {
  cookie = '';
  const call = (tok: string) => req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` });
  const ok = await call(ctx.token);
  assert(ok.res.status === 200 && ok.data.result.tools.length > 10, `tools/list ${ok.res.status}`);
  const parts = ctx.token.split('.');
  const bad = await call(`${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`);
  assert(bad.res.status === 401, `tampered token → ${bad.res.status}`);
});

step('refresh token works', async () => {
  if (!ctx.refresh) throw new Error('no refresh token issued');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ctx.refresh, client_id: ctx.clientId, resource: `${BASE}/mcp` });
  const r = await req('POST', ctx.as.token_endpoint, body, { 'content-type': 'application/x-www-form-urlencoded' });
  assert(r.res.status === 200 && r.data.access_token, `refresh ${r.res.status} ${JSON.stringify(r.data)}`);
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}\n  ${(err as Error).message}`);
    break;
  }
}
process.exit(failed ? 1 : 0);
