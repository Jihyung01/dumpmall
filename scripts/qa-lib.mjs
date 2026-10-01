import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
// Shared helpers for the verification scripts: synthetic Neon sessions, API
// calls, an injected query/batch pair and thorough QA-data cleanup.
export const origin = process.env.TEST_BASE_URL || "http://localhost:3000";
if (!process.env.NEON_AUTH_COOKIE_SECRET || !process.env.DATABASE_URL) throw new Error("Test environment is required");
const sql = neon(process.env.DATABASE_URL);
export const query = async (text, params = []) => (await sql.query(text, params, { fullResults: true })).rows;
export const batch = async (statements) => {
  const results = await sql.transaction(statements.map((s) => sql.query(s.sql, s.params ?? [])), { fullResults: true });
  return results.map((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 }));
};
export const run = crypto.randomUUID().slice(0, 8);
// Deterministic, checksum-valid business registration number per QA user.
export function bizNo(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const d = String(100000000 + (h % 900000000)).split("").map(Number);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * w[i];
  sum += Math.floor((d[8] * 5) / 10);
  return d.join("") + ((10 - (sum % 10)) % 10);
}
export const admin = "qa-admin-static";
const cookies = new Map();
export function headers(user) {
  if (!user) return {};
  if (!cookies.has(user)) {
    const now = new Date(), expiresAt = new Date(Date.now() + 1800000);
    const payload = {
      session: { id: crypto.randomUUID(), token: crypto.randomUUID(), userId: user, createdAt: now, updatedAt: now, expiresAt },
      user: { id: user, name: "QA", email: `${user}@example.invalid`, emailVerified: true, createdAt: now, updatedAt: now },
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(expiresAt.getTime() / 1000), sub: user,
    };
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signed = `${head}.${body}`;
    const sig = createHmac("sha256", process.env.NEON_AUTH_COOKIE_SECRET).update(signed).digest("base64url");
    cookies.set(user, `__Secure-neon-auth.session_token=qa-${user}; __Secure-neon-auth.local.session_data=${signed}.${sig}`);
  }
  return { Cookie: cookies.get(user) };
}
export const counter = { checks: 0 };
export async function get(user) {
  const r = await fetch(`${origin}/api/market`, { headers: headers(user) });
  assert.equal(r.status, 200);
  return r.json();
}
export async function post(user, body, status = 200) {
  const r = await fetch(`${origin}/api/market`, {
    method: "POST",
    headers: { ...headers(user), "Content-Type": "application/json", "X-Dumping-Client": "1", Origin: origin },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  assert.equal(r.status, status, `${body.action}: ${JSON.stringify(result)}`);
  counter.checks++;
  return result;
}
export async function postRaw(user, body) {
  const r = await fetch(`${origin}/api/market`, {
    method: "POST",
    headers: { ...headers(user), "Content-Type": "application/json", "X-Dumping-Client": "1", Origin: origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
export const notesOf = async (user, kind) => (await get(user)).notifications.filter((n) => n.kind === kind);
export function district(prefix) {
  return prefix + [...run].map((c) => "가나다라마바사아자차카타파하거너"[parseInt(c, 16)]).join("") + "구";
}
export async function setupUsers(users, qaDistrict, extra = {}) {
  const address = `서울특별시 ${qaDistrict} 검증로 1`;
  for (const [user, company] of Object.entries(users)) {
    await post(user, { action: "profile", profile: { company, businessNumber: bizNo(user), phone: "01000000000", businessAddress: address, ...(extra[user] ?? {}) } });
  }
}
export async function uploadImage(user) {
  const form = new FormData();
  form.append("file", new File([await fs.readFile("public/images/water.jpg")], "qa.jpg", { type: "image/jpeg" }));
  const uploaded = await fetch(`${origin}/api/uploads`, { method: "POST", headers: { ...headers(user), "X-Dumping-Client": "1", Origin: origin }, body: form });
  assert.equal(uploaded.status, 200);
  return (await uploaded.json()).url;
}
// R16 invariant: no listing ever has more live order quantity than its lot.
export async function assertInvariant() {
  const rows = await query(`SELECT listing_id FROM orders WHERE status<>'cancelled' GROUP BY listing_id
    HAVING SUM(quantity) > (SELECT quantity FROM auctions a WHERE a.listing_id=orders.listing_id)`);
  assert.deepEqual(rows, [], "over-allocation invariant violated");
  counter.checks++;
}
export async function cleanup(users, districts) {
  for (const user of users) {
    for (const l of await query("SELECT id FROM listings WHERE owner_id=$1", [user])) {
      await query("DELETE FROM disputes WHERE listing_id=$1", [l.id]);
      const orders = await query("SELECT id FROM orders WHERE listing_id=$1", [l.id]);
      for (const o of orders) await query("DELETE FROM deposits WHERE order_id=$1", [o.id]);
      await query("DELETE FROM bids WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM auctions WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM orders WHERE listing_id=$1", [l.id]);
    }
    await query("DELETE FROM notifications WHERE user_id=$1", [user]);
    await query("DELETE FROM push_subscriptions WHERE user_id=$1", [user]);
    await query("DELETE FROM disputes WHERE opened_by=$1 OR penalty_user_id=$1", [user]);
    await query("DELETE FROM activity_ips WHERE user_id=$1", [user]);
    await query("DELETE FROM listings WHERE owner_id=$1", [user]);
    await query("DELETE FROM uploads WHERE owner_id=$1", [user]);
    await query("DELETE FROM profiles WHERE user_id=$1", [user]);
  }
  await query("DELETE FROM deposits WHERE provider IN ('bank','sms','manual') AND (raw LIKE 'qa-%' OR depositor LIKE 'QA%' OR event_id LIKE 'qa-%')");
  for (const d of districts) await query("DELETE FROM alias_counters WHERE district_key=$1", ["서울 " + d]);
  console.log("Temporary QA data removed");
}
export { assert };
