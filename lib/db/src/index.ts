import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  console.error(
    '[TrafficForge] FATAL: DATABASE_URL environment variable is not set.\n' +
    '  On Render: go to your service → Environment → add DATABASE_URL from your PostgreSQL database.\n' +
    '  On Replit: the DATABASE_URL is automatically provided by the PostgreSQL integration.\n' +
    '  The server cannot start without a database connection.',
  );
  process.exit(1);
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from './schema';
