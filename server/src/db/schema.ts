// LoadLab database schema — single source of truth.
// After changes: bun run db:generate  (generates SQL under migrations/; applied automatically on startup)
// Column names become snake_case automatically via drizzle `casing: 'snake_case'`.
import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { RunnerConfig } from '../lib/compiler.js';
import type { PlanConfig, WorkflowDefinition } from '../lib/schemas.js';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export const sites = pgTable('sites', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  baseUrl: text().notNull(),
  description: text().notNull().default(''),
  allowedHosts: text().array().notNull().default(sql`'{}'::text[]`),
  headers: jsonb().$type<Record<string, string>>().notNull().default({}),
  variables: jsonb().$type<Record<string, string>>().notNull().default({}),
  datasets: jsonb().$type<Record<string, Record<string, unknown>[]>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflows = pgTable(
  'workflows',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid().references(() => sites.id, { onDelete: 'set null' }),
    name: text().notNull(),
    description: text().notNull().default(''),
    status: text({ enum: ['draft', 'active', 'archived'] }).notNull().default('draft'),
    definition: jsonb().$type<WorkflowDefinition>().notNull(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    source: text().notNull().default('panel'),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.siteId), check('workflows_status_check', sql`${t.status} IN ('draft', 'active', 'archived')`)],
);

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    workflowId: uuid()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    definition: jsonb().$type<WorkflowDefinition>().notNull(),
    source: text().notNull().default('panel'),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workflowId, t.version.desc())],
);

export const testPlans = pgTable(
  'test_plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    status: text({ enum: ['draft', 'ready'] }).notNull().default('draft'),
    config: jsonb().$type<PlanConfig>().notNull(),
    notes: text().notNull().default(''),
    source: text().notNull().default('panel'),
    schedule: text(),
    lastScheduledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('test_plans_status_check', sql`${t.status} IN ('draft', 'ready')`)],
);

export const RUN_STATUSES = ['queued', 'starting', 'running', 'stopping', 'completed', 'stopped', 'failed', 'canceled'] as const;
export const ACTIVE_RUN_STATUSES = ['queued', 'starting', 'running', 'stopping'] as const;
export const LIVE_RUN_STATUSES = ['starting', 'running', 'stopping'] as const;

export const runs = pgTable(
  'runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    planId: uuid().references(() => testPlans.id, { onDelete: 'set null' }),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    kind: text().notNull(),
    status: text({ enum: RUN_STATUSES }).notNull().default('queued'),
    trigger: text().notNull().default('panel'),
    config: jsonb().$type<RunnerConfig>().notNull(),
    planSnapshot: jsonb().$type<PlanConfig | Record<string, never>>().notNull().default({}),
    workerId: text(),
    summary: jsonb().$type<Record<string, any>>(),
    capacity: jsonb().$type<Record<string, any>>(),
    thresholdsPassed: boolean(),
    stopReason: text(),
    error: text(),
    logs: text(),
    isBaseline: boolean().notNull().default(false),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.siteId, t.createdAt.desc()),
    index().on(t.status, t.createdAt),
    index().on(t.planId),
    check('runs_status_check', sql`${t.status} IN ('queued', 'starting', 'running', 'stopping', 'completed', 'stopped', 'failed', 'canceled')`),
  ],
);

/** Per-second time series — the largest table in the database (the retention policy applies to it). */
export const runMetrics = pgTable(
  'run_metrics',
  {
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    t: integer().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    vus: integer().notNull().default(0),
    rps: real().notNull().default(0),
    iters: real().notNull().default(0),
    errRate: real().notNull().default(0),
    avg: real(),
    p50: real(),
    p90: real(),
    p95: real(),
    p99: real(),
    max: real(),
    bytesIn: bigint({ mode: 'number' }).notNull().default(0),
    bytesOut: bigint({ mode: 'number' }).notNull().default(0),
    dropped: integer().notNull().default(0),
    checksFail: integer().notNull().default(0),
    genCpu: real(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.t] })],
);

export const apiTokens = pgTable('api_tokens', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  tokenHash: text().notNull().unique(),
  prefix: text().notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp({ withTimezone: true }),
});

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
});

// ---------------------------------------------------------------------------
// Better Auth (drizzle adapter; field names per Better Auth 1.7 + twoFactor plugin)
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  twoFactorEnabled: boolean().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.identifier)],
);

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text().primaryKey(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean(),
    failedVerificationCount: integer(),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.secret), index().on(t.userId)],
);

export const authSchema = { user, session, account, verification, twoFactor };
