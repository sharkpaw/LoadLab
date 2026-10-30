import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createEnv } from '@t3-oss/env-core';
import { count } from 'drizzle-orm';
import { z } from 'zod';
import { config, onInvalidEnv } from './config.js';
import { db } from './db.js';
import { redis } from './redis.js';
import { passwordChangedMail, passwordResetMail, sendMail } from './mailer.js';
import { authSchema, user } from '../db/schema.js';

/** Only the API and the CLI load this module, so the worker does not need these secrets. */
export const authEnv = createEnv({
  server: {
    BETTER_AUTH_SECRET: z
      .string({ error: (iss) => (iss.input === undefined ? 'is required' : undefined) })
      .min(32, 'must be at least 32 characters (e.g. openssl rand -hex 32)'),
    ADMIN_EMAIL: z.email().default('admin@example.com'),
    ADMIN_PASSWORD: z.string().min(10, 'must be at least 10 characters').optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: onInvalidEnv,
});

const PREFIX = 'loadlab:auth:';
const RESET_TTL_MIN = 30;

/**
 * Panel sign-in is handled by Better Auth:
 * - email + password (sign-up over HTTP is disabled; admins add users from the panel)
 * - TOTP two-factor authentication + backup codes
 * - tables live in the Drizzle schema (src/db/schema.ts), migrations via drizzle-kit
 * - sessions in Postgres, cache and rate-limit counters in Redis
 */
export const auth = betterAuth({
  appName: 'LoadLab',
  baseURL: config.publicUrl,
  basePath: '/api/auth',
  secret: authEnv.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
  secondaryStorage: {
    get: (key) => redis.get(PREFIX + key),
    getAndDelete: (key) => redis.getdel(PREFIX + key),
    increment: async (key, ttl) => {
      const res = await redis.multi().incr(PREFIX + key).expire(PREFIX + key, ttl, 'NX').exec();
      return Number(res?.[0]?.[1] ?? 1);
    },
    set: async (key, value, ttl) => {
      if (ttl) await redis.set(PREFIX + key, value, 'EX', ttl);
      else await redis.set(PREFIX + key, value);
    },
    delete: async (key) => {
      await redis.del(PREFIX + key);
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: RESET_TTL_MIN * 60,
    // Not awaited: the response time must not reveal whether the e-mail exists
    sendResetPassword: async ({ user: u, url }) => {
      void sendMail(passwordResetMail(u.email, url, RESET_TTL_MIN));
    },
    onPasswordReset: async ({ user: u }) => {
      console.log(`[auth] password reset for ${u.email}; all sessions revoked`);
      void sendMail(passwordChangedMail(u.email));
    },
  },
  session: {
    expiresIn: 7 * 24 * 3600,
    updateAge: 24 * 3600,
    freshAge: 10 * 60,
    storeSessionInDatabase: true,
  },
  rateLimit: {
    enabled: true,
    storage: 'secondary-storage',
    window: 60,
    max: 120,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/two-factor/verify-totp': { window: 60, max: 5 },
      '/two-factor/verify-backup-code': { window: 60, max: 5 },
      '/two-factor/enable': { window: 60, max: 5 },
      '/change-password': { window: 60, max: 5 },
      '/request-password-reset': { window: 300, max: 3 },
      '/reset-password': { window: 60, max: 5 },
    },
  },
  trustedOrigins: [config.publicUrl, ...config.extraOrigins],
  advanced: {
    cookiePrefix: 'loadlab',
    useSecureCookies: config.publicUrl.startsWith('https://'),
    ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
  },
  telemetry: { enabled: false },
  plugins: [twoFactor({ issuer: 'LoadLab' })],
});

/** Creates the first admin if there are no users (tables come from Drizzle migrations). */
export async function setupAuth() {
  const [{ n }] = await db.select({ n: count() }).from(user);
  if (n > 0) return;
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = authEnv;
  if (!ADMIN_PASSWORD) {
    console.warn('[auth] No users yet. Set ADMIN_PASSWORD (and ADMIN_EMAIL) to create the first admin.');
    return;
  }
  await auth.api.signUpEmail({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' } });
  console.log(`[auth] First admin created: ${ADMIN_EMAIL}`);
}
