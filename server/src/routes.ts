import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { config } from './lib/config.js';
import { auth } from './lib/auth.js';
import { count, eq, sql } from 'drizzle-orm';
import { db } from './lib/db.js';
import { user } from './db/schema.js';
import { Fanout, keys, redis } from './lib/redis.js';
import { harToWorkflow } from './lib/har.js';
import { siteHosts } from './lib/compiler.js';
import { WORKFLOW_DSL_DOC } from './lib/schemas.js';
import * as svc from './lib/services.js';

const fanout = new Fanout();
const allowedOrigins = new Set([config.publicUrl, ...config.extraOrigins]);

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; name: string; twoFactorEnabled?: boolean | null };
  }
}

/** Forwards a Fastify request to Better Auth's Fetch-based handler. */
async function authHandler(req: FastifyRequest, reply: FastifyReply) {
  // Open sign-up is disabled: only signed-in admins add users (/api/users)
  if (/^\/api\/auth\/sign-up/.test(req.url)) return reply.code(403).send({ error: 'Sign-up is disabled' });
  const headers = fromNodeHeaders(req.headers);
  // Real client IP for rate limiting (resolved by Fastify per TRUST_PROXY_HOPS); replaces any spoofed header
  headers.set('x-forwarded-for', req.ip);
  const res = await auth.handler(
    new Request(new URL(req.url, config.publicUrl), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
    }),
  );
  reply.status(res.status);
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie' && k !== 'content-length') reply.header(k, v);
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  return reply.send((await res.text()) || null);
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  // API key (automation, MCP clients)
  const authz = req.headers.authorization ?? '';
  if (authz.startsWith('Bearer ')) {
    if (await svc.verifyToken(authz.slice(7).trim())) return;
    return reply.code(401).send({ error: 'Invalid API key' });
  }
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!session) return reply.code(401).send({ error: 'Authentication required' });
  // Origin check on cookie-authenticated state-changing requests (extra layer against CSRF)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'Invalid origin' });
  }
  req.user = session.user as FastifyRequest['user'];
}

export function registerRoutes(app: FastifyInstance) {
  app.route({ method: ['GET', 'POST'], url: '/api/auth/*', handler: authHandler });

  app.get('/api/health', async () => {
    await db.execute(sql`SELECT 1`);
    await redis.ping();
    return { ok: true };
  });

  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/me', async (req) => ({
      user: req.user ?? { id: 'api', email: 'api-key', name: 'API' },
      publicUrl: config.publicUrl,
      mcpAllowRun: config.mcpAllowRun,
      limits: config.limits,
    }));

    // --- panel users ---
    api.get('/api/users', async () =>
      db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          createdAt: user.createdAt,
          // correlated subquery: the outer table is qualified explicitly (drizzle doesn't qualify single-table queries)
          lastSeenAt: sql<Date | null>`(SELECT max(s.updated_at) FROM session s WHERE s.user_id = "user"."id")`,
        })
        .from(user)
        .orderBy(user.createdAt),
    );
    api.post<{ Body: { name?: string; email?: string; password?: string } }>('/api/users', async (req) => {
      const { name, email, password } = req.body ?? {};
      if (!email || !password) throw new svc.HttpError(400, 'Email and password are required');
      if (password.length < 10) throw new svc.HttpError(400, 'Password must be at least 10 characters');
      try {
        const r = await auth.api.signUpEmail({ body: { email: email.trim().toLowerCase(), password, name: name?.trim() || email } });
        return { id: r.user.id, email: r.user.email, name: r.user.name };
      } catch (e) {
        throw new svc.HttpError(400, (e as Error).message || 'Could not create user');
      }
    });
    api.delete<{ Params: { id: string } }>('/api/users/:id', async (req) => {
      if (req.user && req.params.id === req.user.id) throw new svc.HttpError(400, 'You cannot delete yourself');
      const [{ n }] = await db.select({ n: count() }).from(user);
      if (n <= 1) throw new svc.HttpError(400, 'The last user cannot be deleted');
      // Through Better Auth so cached sessions in Redis are revoked too, not just the database rows
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(req.params.id);
      await ctx.internalAdapter.deleteUser(req.params.id);
      return { ok: true };
    });

    api.get('/api/overview', async () => svc.overview());
    api.get('/api/dsl', async () => ({ doc: WORKFLOW_DSL_DOC }));

    // --- sites ---
    api.get('/api/sites', async () => svc.listSites());
    api.post('/api/sites', async (req) => svc.createSite(req.body));
    api.get<{ Params: { id: string } }>('/api/sites/:id', async (req) => svc.getSite(req.params.id));
    api.put<{ Params: { id: string } }>('/api/sites/:id', async (req) => svc.updateSite(req.params.id, req.body));
    api.delete<{ Params: { id: string } }>('/api/sites/:id', async (req) => svc.deleteSite(req.params.id));
    api.get<{ Params: { id: string } }>('/api/sites/:id/benchmark', async (req) => svc.siteBenchmark(req.params.id));
    api.post<{ Params: { id: string }; Body: { path: string } }>('/api/sites/:id/probe', async (req) => svc.probeSite(req.params.id, req.body?.path ?? '/'));

    // --- workflows ---
    api.get<{ Querystring: { siteId?: string; status?: string } }>('/api/workflows', async (req) => svc.listWorkflows(req.query));
    api.post('/api/workflows', async (req) => svc.createWorkflow(req.body as any, 'panel'));
    api.post<{ Body: { definition: unknown; siteId?: string } }>('/api/workflows/validate', async (req) => svc.validateWorkflow(req.body?.definition, req.body?.siteId));
    api.post<{ Body: { har: any; siteId: string; name?: string; includeAssets?: boolean } }>('/api/workflows/import-har', async (req) => {
      const { har, siteId, name, includeAssets } = req.body ?? ({} as any);
      const site = await svc.getSite(siteId);
      let res;
      try {
        res = harToWorkflow(typeof har === 'string' ? JSON.parse(har) : har, site.baseUrl, siteHosts(site), { includeAssets });
      } catch (e) {
        throw new svc.HttpError(400, (e as Error).message);
      }
      const wf = await svc.createWorkflow({ name: name || `HAR import ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, siteId, definition: res.definition, description: `Imported from HAR (${res.stats.used} requests)`, status: 'draft' }, 'har');
      return { workflow: wf, stats: res.stats };
    });
    api.get<{ Params: { id: string } }>('/api/workflows/:id', async (req) => svc.getWorkflow(req.params.id));
    api.put<{ Params: { id: string } }>('/api/workflows/:id', async (req) => svc.updateWorkflow(req.params.id, req.body as any, 'panel'));
    api.delete<{ Params: { id: string } }>('/api/workflows/:id', async (req) => svc.deleteWorkflow(req.params.id));
    api.post<{ Params: { id: string }; Body: { name?: string } }>('/api/workflows/:id/duplicate', async (req) => svc.duplicateWorkflow(req.params.id, 'panel', req.body?.name));
    api.get<{ Params: { id: string } }>('/api/workflows/:id/versions', async (req) => svc.workflowVersionList(req.params.id));
    api.post<{ Params: { id: string }; Body: { siteId: string; iterations?: number } }>('/api/workflows/:id/debug', async (req) =>
      svc.debugWorkflow(req.params.id, req.body?.siteId, req.body?.iterations ?? 1),
    );

    // --- plans ---
    api.get<{ Querystring: { siteId?: string; status?: string } }>('/api/plans', async (req) => svc.listPlans(req.query));
    api.post('/api/plans', async (req) => svc.createPlan(req.body as any, 'panel'));
    api.post<{ Body: { siteId: string; config: unknown } }>('/api/plans/preview', async (req) => svc.previewPlan(req.body?.siteId, req.body?.config));
    api.get<{ Params: { id: string } }>('/api/plans/:id', async (req) => svc.getPlan(req.params.id));
    api.put<{ Params: { id: string } }>('/api/plans/:id', async (req) => svc.updatePlan(req.params.id, req.body as any, 'panel'));
    api.delete<{ Params: { id: string } }>('/api/plans/:id', async (req) => svc.deletePlan(req.params.id));
    api.post<{ Params: { id: string } }>('/api/plans/:id/start', async (req) => svc.startPlan(req.params.id, 'panel'));

    // --- runs ---
    api.get<{ Querystring: { siteId?: string; status?: string; planId?: string; limit?: string } }>('/api/runs', async (req) =>
      svc.listRuns({ ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined }),
    );
    api.get<{ Querystring: { a: string; b: string } }>('/api/runs/compare', async (req) => svc.compareRuns(req.query.a, req.query.b));
    api.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => svc.getRun(req.params.id));
    api.get<{ Params: { id: string } }>('/api/runs/:id/metrics', async (req) => svc.runMetricsList(req.params.id));
    api.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/runs/:id/stop', async (req) => svc.stopRun(req.params.id, !!req.body?.force));
    api.post<{ Params: { id: string } }>('/api/runs/:id/rerun', async (req) => svc.rerun(req.params.id, 'panel'));
    api.post<{ Params: { id: string }; Body: { value: boolean } }>('/api/runs/:id/baseline', async (req) => svc.setBaseline(req.params.id, req.body?.value !== false));
    api.delete<{ Params: { id: string } }>('/api/runs/:id', async (req) => svc.deleteRun(req.params.id));

    // live stream (Server-Sent Events)
    api.get<{ Params: { id: string } }>('/api/runs/:id/live', async (req, reply) => {
      const id = req.params.id;
      await svc.getRun(id); // ensure it exists
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (msg: string) => raw.write(`data: ${msg}\n\n`);
      const backlog = await redis.lrange(keys.latest(id), 0, -1);
      for (const m of backlog) send(m);
      const off = await fanout.on(keys.live(id), send);
      const ping = setInterval(() => raw.write(': ping\n\n'), 15000);
      req.raw.on('close', () => {
        clearInterval(ping);
        off().catch(() => {});
      });
    });

    // --- system ---
    api.get('/api/system', async () => svc.systemStatus());
    api.post<{ Body: { olderThanDays: number; mode: 'metrics' | 'runs' } }>('/api/system/cleanup', async (req) =>
      svc.cleanup({ olderThanDays: Number(req.body?.olderThanDays ?? 30), mode: req.body?.mode === 'runs' ? 'runs' : 'metrics' }),
    );
    api.get('/api/settings', async () => svc.getSettings());
    api.put('/api/settings', async (req) => svc.updateSettings(req.body as any));

    // --- API keys ---
    api.get('/api/tokens', async () => svc.listTokens());
    api.post<{ Body: { name: string } }>('/api/tokens', async (req) => svc.createToken(req.body?.name));
    api.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => svc.deleteToken(req.params.id));
  });
}
