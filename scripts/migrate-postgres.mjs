import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = neon(process.env.DATABASE_URL);
const migration = await readFile(new URL('../db/migration-postgres.sql', import.meta.url), 'utf8');
const statements = migration.split(';').map(s => s.trim()).filter(Boolean);
await sql.transaction(statements.map(s => sql.query(s)));
console.log(`Postgres migration completed: ${statements.length} statements`);
