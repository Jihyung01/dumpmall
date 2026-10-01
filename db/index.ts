import "server-only";
import { neon } from "@neondatabase/serverless";

// Preserve parameterized marketplace queries while migrating D1 to Postgres.
function statement(source: string, values: unknown[] = []) {
  let parameter = 0;
  let sql = source.replace(/\?/g, () => `$${++parameter}`);
  sql = sql.replace(/\bAS ([a-zA-Z][a-zA-Z0-9]*)/g, 'AS "$1"');
  if (/INSERT OR IGNORE/i.test(sql)) {
    sql = sql.replace(/INSERT OR IGNORE/i, "INSERT") + " ON CONFLICT DO NOTHING";
  }
  async function execute() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Database is not configured");
    return neon(url).query(sql, values, { fullResults: true });
  }
  return {
    bind: (...parameters: unknown[]) => statement(source, parameters),
    async all<T = Record<string, unknown>>() {
      const result = await execute();
      return { results: result.rows as T[] };
    },
    async first<T = Record<string, unknown>>() {
      const result = await execute();
      return (result.rows[0] as T | undefined) ?? null;
    },
    async run() {
      const result = await execute();
      return { meta: { changes: result.rowCount } };
    },
  };
}
export function database() {
  return { prepare: (sql: string) => statement(sql) };
}
// One non-interactive transaction: every statement is fixed up front, any
// error rolls back all of them, results are readable only after commit.
export type Statement = { sql: string; params?: unknown[] };
export async function batch(statements: Statement[]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Database is not configured");
  const sql = neon(url);
  const results = await sql.transaction(statements.map((s) => sql.query(s.sql, s.params ?? [])), { fullResults: true });
  return results.map((r) => ({ rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 }));
}
// Native $n placeholders for the auction, order and notification code paths.
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Database is not configured");
  const result = await neon(url).query(sql, params, { fullResults: true });
  return result.rows as T[];
}

type Upload = { body: string; owner_id: string; content_type: string };
export function bucket() {
  return {
    async put(id: string, bytes: ArrayBuffer, metadata: {
      httpMetadata: { contentType: string };
      customMetadata: { owner: string };
    }) {
      // Small MVP uploads live in the dedicated database because this Vercel
      // account has reached its Blob usage limit. The API enforces a 3 MB cap.
      await database().prepare(
        "INSERT INTO uploads(id, owner_id, body, content_type) VALUES(?, ?, ?, ?)",
      ).bind(id, metadata.customMetadata.owner, Buffer.from(bytes).toString("base64"), metadata.httpMetadata.contentType).run();
    },
    async head(id: string) {
      const row = await database().prepare("SELECT owner_id FROM uploads WHERE id=?").bind(id).first<Upload>();
      return row ? { customMetadata: { owner: row.owner_id } } : null;
    },
    async get(id: string) {
      const row = await database().prepare("SELECT body, content_type FROM uploads WHERE id=?").bind(id).first<Upload>();
      if (!row) return null;
      return { body: new Uint8Array(Buffer.from(row.body, "base64")), httpMetadata: { contentType: row.content_type } };
    },
  };
}
