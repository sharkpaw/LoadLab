// Admin CLI for the server terminal, e.g. when nobody can sign in any more.
//   docker compose exec loadlab bun src/cli.ts <command> [args]
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from './lib/auth.js';
import { db, pool, waitForDb } from './lib/db.js';
import { redis } from './lib/redis.js';
import { twoFactor, user } from './db/schema.js';

const HELP = `LoadLab admin CLI

Usage: bun src/cli.ts <command> [options]

Commands:
  users                                   List dashboard users
  reset-password <email> [--password P]   Set a new password (random if omitted) and sign out all sessions
  create-user <email> [--name N] [--password P]
                                          Create a dashboard user (random password if omitted)
  disable-2fa <email>                     Turn off two-factor authentication (lost phone)
  revoke-sessions <email>                 Sign the user out everywhere
  delete-user <email>                     Delete a user and their sessions

Passwords must be at least 10 characters. Generated passwords are printed once.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function newPassword(given?: string): string {
  if (given !== undefined) {
    if (given.length < 10) fail('Password must be at least 10 characters');
    return given;
  }
  return crypto.randomBytes(12).toString('base64url');
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function findUser(email: string | undefined) {
  if (!email) fail('E-mail address required');
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email.toLowerCase());
  if (!found) fail(`No user with e-mail ${email}`);
  return { ctx, user: found.user };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  await waitForDb(5);

  switch (cmd) {
    case 'users': {
      const rows = await db.select({ email: user.email, name: user.name, twoFactor: user.twoFactorEnabled, createdAt: user.createdAt }).from(user).orderBy(user.createdAt);
      console.table(rows.map((r) => ({ email: r.email, name: r.name, '2fa': r.twoFactor ? 'on' : 'off', created: r.createdAt.toISOString().slice(0, 16) })));
      break;
    }
    case 'reset-password': {
      const { ctx, user: u } = await findUser(args[0]);
      const pw = newPassword(flag(args, 'password'));
      const hash = await ctx.password.hash(pw);
      const accounts = await ctx.internalAdapter.findAccounts(u.id);
      if (accounts.some((a) => a.providerId === 'credential')) await ctx.internalAdapter.updatePassword(u.id, hash);
      else await ctx.internalAdapter.linkAccount({ userId: u.id, accountId: u.id, providerId: 'credential', password: hash });
      await ctx.internalAdapter.deleteUserSessions(u.id);
      console.log(`Password reset for ${u.email}; all sessions signed out.`);
      if (!flag(args, 'password')) console.log(`New password: ${pw}`);
      break;
    }
    case 'create-user': {
      const email = args[0];
      if (!email) fail('E-mail address required');
      const pw = newPassword(flag(args, 'password'));
      await auth.api.signUpEmail({ body: { email: email.toLowerCase(), password: pw, name: flag(args, 'name') ?? email } });
      console.log(`Created ${email}.`);
      if (!flag(args, 'password')) console.log(`Password: ${pw}`);
      break;
    }
    case 'disable-2fa': {
      const { ctx, user: u } = await findUser(args[0]);
      await db.delete(twoFactor).where(eq(twoFactor.userId, u.id));
      await ctx.internalAdapter.updateUser(u.id, { twoFactorEnabled: false });
      await ctx.internalAdapter.deleteUserSessions(u.id);
      console.log(`Two-factor authentication disabled for ${u.email}; sessions signed out. Ask them to enable it again.`);
      break;
    }
    case 'revoke-sessions': {
      const { ctx, user: u } = await findUser(args[0]);
      await ctx.internalAdapter.deleteUserSessions(u.id);
      console.log(`All sessions of ${u.email} signed out.`);
      break;
    }
    case 'delete-user': {
      const { ctx, user: u } = await findUser(args[0]);
      const [{ n }] = await pool.query('SELECT count(*)::int AS n FROM "user"').then((r) => r.rows);
      if (n <= 1) fail('Refusing to delete the last user');
      await ctx.internalAdapter.deleteUserSessions(u.id);
      await ctx.internalAdapter.deleteUser(u.id);
      console.log(`Deleted ${u.email}.`);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    redis.disconnect();
  });
