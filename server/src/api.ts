import fs from 'node:fs';
import os from 'node:os';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config, env } from './lib/config.js';
import { migrate, waitForDb } from './lib/db.js';
import { setupAuth } from './lib/auth.js';
import { verifyMail } from './lib/mailer.js';
import { startReporter } from './lib/sysinfo.js';
import { HttpError, janitorTick, schedulerTick } from './lib/services.js';
import { registerRoutes } from './routes.js';
import { registerMcp } from './mcp.js';

async function main() {
  if (env.NODE_ENV === 'production' && !env.PUBLIC_URL) {
    console.warn('[api] PUBLIC_URL is not set; using http://localhost:8080. Sign-in from another address will fail its origin check.');
  }
  await waitForDb();
  await migrate();
  await setupAuth();
  void verifyMail();

  const app = Fastify({ logger: { level: env.LOG_LEVEL }, bodyLimit: 50 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops });

  // Security headers
  const https = config.publicUrl.startsWith('https://');
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (https) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  // Accept body-less JSON POSTs ({}) for curl/automation convenience
  // OAuth token/revoke requests are form-encoded; kept raw and passed through to Better Auth
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || !(body as string).trim()) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Server error', details: err.message });
  });

  registerRoutes(app);
  registerMcp(app);

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.log.warn(`web UI not found: ${config.webDist}`);
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });

  const id = `api-${os.hostname()}-${process.pid}`;
  const stopReporter = startReporter('api', id);
  setInterval(() => schedulerTick().catch((e) => app.log.error(e, 'scheduler')), 30_000).unref();
  setInterval(() => janitorTick().catch((e) => app.log.error(e, 'janitor')), 15_000).unref();

  const close = async () => {
    stopReporter();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
