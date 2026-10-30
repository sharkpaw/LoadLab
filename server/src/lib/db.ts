import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runDrizzleMigrations } from 'drizzle-orm/node-postgres/migrator';
import { config } from './config.js';
import * as schema from '../db/schema.js';

// Return bigint (int8) values as numbers; values in this app are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const db = drizzle(pool, { schema, casing: 'snake_case' });
export type DB = typeof db;

export async function waitForDb(retries = 30): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= retries) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Applies drizzle-kit generated migrations; if api and worker start together, an advisory lock serializes them. */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await runDrizzleMigrations(db, { migrationsFolder: config.migrationsDir });
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}
