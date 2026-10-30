import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib or dist/lib -> package root
const root = path.resolve(here, '..', '..');

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  root,
  port: num('PORT', 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://loadlab:loadlab@localhost:5432/loadlab',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  authSecret: process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET || 'dev-secret-change-me-dev-secret-change-me',
  publicUrl: (process.env.PUBLIC_URL || process.env.BETTER_AUTH_URL || 'http://localhost:8080').replace(/\/$/, ''),
  /** Additional origins the panel is accessed from (comma-separated), e.g. a second domain */
  extraOrigins: (process.env.TRUSTED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  /** Number of reverse proxies in front (Coolify/Traefik = 1). The client IP for rate limiting is derived from this. */
  trustProxyHops: num('TRUST_PROXY_HOPS', 1),
  /** Optional SMTP for password-reset mail. Without SMTP_HOST, reset links are printed to the API log. */
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: num('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM || 'LoadLab <no-reply@localhost>',
  },
  mcpToken: process.env.MCP_TOKEN ?? '',
  mcpAllowRun: bool('MCP_ALLOW_RUN', false),
  mcpAllowDebug: bool('MCP_ALLOW_DEBUG', true),
  k6Bin: process.env.K6_BIN ?? 'k6',
  runnerPath: process.env.RUNNER_PATH ?? path.join(root, 'k6', 'runner.js'),
  webDist: process.env.WEB_DIST ?? path.resolve(root, '..', 'web', 'dist'),
  migrationsDir: path.join(root, 'migrations'),
  workDir: process.env.WORK_DIR ?? '/tmp/loadlab',
  limits: {
    maxVus: num('MAX_VUS', 5000),
    maxRate: num('MAX_RATE', 20000),
    maxDurationSec: num('MAX_DURATION_SEC', 4 * 3600),
  },
};

export type Role = 'api' | 'worker';
