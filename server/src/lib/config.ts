import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib -> package root
const root = path.resolve(here, '..', '..');

/** Prints every invalid variable and exits, so a misconfigured container stops instead of half-working. */
export function onInvalidEnv(issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[]): never {
  const lines = issues.map((i) => {
    const key = i.path?.map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.') ?? '?';
    return `  - ${key}: ${i.message}`;
  });
  console.error(`Invalid environment variables:\n${lines.join('\n')}\nSee .env.example for the full list.`);
  process.exit(1);
}

const int = (def: number) => z.coerce.number().int().min(0).default(def);
const flag = (def: boolean) => z.stringbool().default(def);

/** Variables shared by the API, the worker and the CLI. API-only secrets are validated in lib/auth.ts. */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: int(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    WORKER_ID: z.string().optional(),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: (iss) => (iss.input === undefined ? 'is required' : 'must be a postgres:// URL') }),
    REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }).default('redis://localhost:6379'),
    PUBLIC_URL: z.url().optional(),
    TRUSTED_ORIGINS: z.string().default(''),
    TRUST_PROXY_HOPS: int(1),
    MCP_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
    MCP_ALLOW_RUN: flag(false),
    MCP_ALLOW_DEBUG: flag(true),
    MCP_OAUTH: flag(true),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: int(587),
    SMTP_SECURE: flag(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('LoadLab <no-reply@localhost>'),
    K6_BIN: z.string().default('k6'),
    RUNNER_PATH: z.string().default(path.join(root, 'k6', 'runner.js')),
    WEB_DIST: z.string().default(path.resolve(root, '..', 'web', 'dist')),
    WORK_DIR: z.string().default('/tmp/loadlab'),
    MAX_VUS: int(5000),
    MAX_RATE: int(20000),
    MAX_DURATION_SEC: int(4 * 3600),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: onInvalidEnv,
});

const trimSlash = (u: string) => u.replace(/\/$/, '');

export const config = {
  root,
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  publicUrl: trimSlash(env.PUBLIC_URL ?? 'http://localhost:8080'),
  /** Additional origins the panel is accessed from (comma-separated), e.g. a second domain */
  extraOrigins: env.TRUSTED_ORIGINS.split(',').map((s) => trimSlash(s.trim())).filter(Boolean),
  /** Number of reverse proxies in front (Coolify/Traefik = 1). The client IP for rate limiting is derived from this. */
  trustProxyHops: env.TRUST_PROXY_HOPS,
  /** Optional SMTP for password-reset mail. Without SMTP_HOST, reset links are printed to the API log. */
  smtp: {
    host: env.SMTP_HOST ?? '',
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    from: env.SMTP_FROM,
  },
  mcpToken: env.MCP_TOKEN ?? '',
  mcpAllowRun: env.MCP_ALLOW_RUN,
  mcpAllowDebug: env.MCP_ALLOW_DEBUG,
  /** OAuth 2.1 sign-in for MCP clients. Needs an HTTPS PUBLIC_URL (plain HTTP only on localhost). */
  mcpOAuth: env.MCP_OAUTH && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$))/.test(env.PUBLIC_URL ?? 'http://localhost:8080'),
  mcpResource: `${trimSlash(env.PUBLIC_URL ?? 'http://localhost:8080')}/mcp`,
  k6Bin: env.K6_BIN,
  runnerPath: env.RUNNER_PATH,
  webDist: env.WEB_DIST,
  migrationsDir: path.join(root, 'migrations'),
  workDir: env.WORK_DIR,
  limits: {
    maxVus: env.MAX_VUS,
    maxRate: env.MAX_RATE,
    maxDurationSec: env.MAX_DURATION_SEC,
  },
};

export type Role = 'api' | 'worker';
