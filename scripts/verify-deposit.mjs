import { createHmac } from "node:crypto";
import { processAuctions } from "../lib/auction-core.ts";
import { assert, admin, batch, cleanup, counter, district, get, headers, notesOf, origin, post, postRaw, query, run, setupUsers, uploadImage } from "./qa-lib.mjs";
// Deposit webhook: auth, idempotency, matching rules, admin tools.
// Start the server with DEPOSIT_WEBHOOK_SECRET=<32+ chars> and ADMIN_USER_IDS=qa-admin-static.
const secret = process.env.DEPOSIT_WEBHOOK_SECRET;
if (!secret) throw new Error("DEPOSIT_WEBHOOK_SECRET is required for this script");
const seller = `qa-dseller-${run}`, b1 = `qa-db1-${run}`, b2 = `qa-db2-${run}`;
const scope = { ownerIds: [seller] }; // never touch real listings in the shared DB
const users = [seller, b1, b2, admin];
const qaDistrict = district("입금");
const later = (days) => new Date(Date.now() + days * 86400000);
async function hook(body, opts = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const h = { "Content-Type": opts.contentType ?? "application/json" };
  if (opts.auth === "static") h["X-Deposit-Secret"] = opts.secret ?? secret;
  if (opts.auth === "hmac") {
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    h["X-Deposit-Signature"] = `t=${t},v1=${createHmac("sha256", opts.secret ?? secret).update(`${t}.${opts.signedRaw ?? raw}`).digest("hex")}`;
  }
  const r = await fetch(`${origin}/api/webhooks/deposit`, { method: opts.method ?? "POST", headers: h, body: opts.method === "GET" ? undefined : raw });
  let json = null;
  try { json = await r.json(); } catch {}
  counter.checks++;
  return { status: r.status, body: json };
}
const orderRow = async (id) => (await query("SELECT status, paid_by, deposit_id, depositor FROM orders WHERE id=$1", [id]))[0];
try {
  await setupUsers({ [seller]: "QA 입금 공급자", [b1]: "QA홍길동상사", [b2]: "QA김철수유통", [admin]: "QA 운영자" }, qaDistrict);
  const image = await uploadImage(seller);
  const base = {
    title: `QA 입금 경매 ${run}`, category: "생활·주방", price: 1000, originalPrice: 5000, stock: 100, moq: 1, unit: "박스", region: "서울",
    condition: "새상품", image, description: "입금 웹훅 검증용 상품입니다.", saleType: "auction", auctionDays: 7, reservePrice: 1100,
  };
  // Two orders with the same amount (120,000): b1 on listing A, b2 on listing B
  const A = await post(seller, { action: "create_listing", product: base }, 201);
  const B = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매2 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: A.id, amount: 1200 }, 201);
  await post(b2, { action: "bid", productId: B.id, amount: 1200 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oA = (await query("SELECT * FROM orders WHERE listing_id=$1", [A.id]))[0];
  const oB = (await query("SELECT * FROM orders WHERE listing_id=$1", [B.id]))[0];
  assert.equal(oA.amount, 120000); assert.ok(oA.deposit_code);
  // Auth matrix
  assert.equal((await hook({ amount: 1, depositor: "x" })).status, 401);
  assert.equal((await hook({ amount: 1, depositor: "x" }, { auth: "static", secret: "wrong-secret-wrong-secret-wrong-secret" })).status, 401);
  assert.equal((await hook({ amount: 1, depositor: "x" }, { auth: "hmac", t: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  assert.equal((await hook({ amount: 1, depositor: "x" }, { auth: "hmac", signedRaw: '{"amount":2}' })).status, 401);
  assert.equal((await hook({ amount: 1, depositor: "x".repeat(9000) }, { auth: "static" })).status, 413);
  assert.equal((await hook("amount=1", { auth: "static", contentType: "text/plain" })).status, 415);
  assert.equal((await hook({}, { auth: "static", method: "GET" })).status, 405);
  assert.equal((await hook({ amount: "abc" }, { auth: "static" })).status, 400);
  counter.checks++;
  // Code + exact amount → auto-confirmed (HMAC)
  let r = await hook({ provider: "bank", eventId: `qa-${run}-1`, amount: 120000, depositor: `${oA.deposit_code}QA홍길동` }, { auth: "hmac" });
  assert.equal(r.status, 200); assert.equal(r.body.result, "matched"); assert.equal(r.body.orderId, oA.id);
  let row = await orderRow(oA.id);
  assert.equal(row.status, "paid"); assert.equal(row.paid_by, "webhook"); assert.ok(row.deposit_id);
  assert.equal((await query("SELECT status, order_id FROM deposits WHERE id=$1", [row.deposit_id]))[0].status, "matched");
  assert.equal((await notesOf(b1, "contact_revealed")).length, 1);
  assert.equal((await notesOf(seller, "contact_revealed")).length, 1);
  assert.equal((await notesOf(admin, "admin_auto_paid")).length, 1);
  assert.ok((await get(b1)).orders.find((o) => o.id === oA.id).counterpart.company);
  assert.ok(!JSON.stringify(r.body).includes("홍길동"), "response never echoes the depositor");
  // Replay ×3 → one ledger row, one transition
  for (let i = 0; i < 3; i++) {
    r = await hook({ provider: "bank", eventId: `qa-${run}-1`, amount: 120000, depositor: `${oA.deposit_code}QA홍길동` }, { auth: "static" });
    assert.equal(r.status, 200); assert.equal(r.body.replay, true);
  }
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM deposits WHERE event_id=$1", [`qa-${run}-1`]))[0].n, 1);
  assert.equal((await notesOf(b1, "contact_revealed")).length, 1);
  // Same transfer with a new event id → already_paid hint
  r = await hook({ provider: "bank", eventId: `qa-${run}-1b`, amount: 120000, depositor: `${oA.deposit_code}QA홍길동` }, { auth: "static" });
  assert.equal(r.body.result, "unmatched"); assert.equal(r.body.reason, "already_paid");
  counter.checks++;
  // Code + wrong amount → amount_mismatch, order untouched
  r = await hook({ eventId: `qa-${run}-2`, amount: 100000, depositor: `${oB.deposit_code}QA김철수` }, { auth: "static" });
  assert.equal(r.body.result, "unmatched"); assert.equal(r.body.reason, "amount_mismatch");
  assert.equal((await orderRow(oB.id)).status, "awaiting_payment");
  assert.equal((await notesOf(admin, "admin_deposit_unmatched")).length, 1);
  // No code, same amount as B only (A is paid) but no name evidence, flag off → review
  r = await hook({ eventId: `qa-${run}-3`, amount: 120000, depositor: "아무개" }, { auth: "static" });
  assert.equal(r.body.result, "unmatched"); assert.equal(r.body.reason, "review");
  const reviewId = r.body.depositId;
  // Name evidence (company prefix) → matched without code
  r = await hook({ eventId: `qa-${run}-4`, amount: 120000, depositor: "QA김철수" }, { auth: "static" });
  assert.equal(r.body.result, "matched"); assert.equal(r.body.orderId, oB.id);
  assert.equal((await orderRow(oB.id)).paid_by, "webhook");
  counter.checks++;
  // Admin tools: dismiss the review deposit; record a manual deposit for a third order; retry
  await post(b1, { action: "dismiss_deposit", depositId: reviewId, note: "x" }, 403);
  await post(admin, { action: "dismiss_deposit", depositId: reviewId, note: "QA 무시" });
  assert.equal((await query("SELECT status FROM deposits WHERE id=$1", [reviewId]))[0].status, "dismissed");
  const C = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매3 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: C.id, amount: 1500 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oC = (await query("SELECT * FROM orders WHERE listing_id=$1", [C.id]))[0];
  assert.equal(oC.amount, 150000);
  r = await post(admin, { action: "record_deposit", depositor: "QA 낯선이름", amount: 150000, memo: `qa-${run}` });
  assert.equal(r.result, "unmatched"); assert.equal(r.reason, "review");
  const manualId = r.depositId;
  await post(admin, { action: "match_deposit", depositId: manualId, orderId: oC.id });
  row = await orderRow(oC.id);
  assert.equal(row.status, "paid"); assert.equal(row.paid_by, "admin"); assert.equal(row.deposit_id, manualId);
  await post(admin, { action: "match_deposit", depositId: manualId, orderId: oC.id }, 404);
  // Amount mismatch requires force + note
  const D = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매4 ${run}` } }, 201);
  await post(b2, { action: "bid", productId: D.id, amount: 1100 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oD = (await query("SELECT * FROM orders WHERE listing_id=$1", [D.id]))[0];
  r = await post(admin, { action: "record_deposit", depositor: "QA 부족입금", amount: 100000, memo: `qa-${run}-short` });
  await post(admin, { action: "match_deposit", depositId: r.depositId, orderId: oD.id }, 400);
  await post(admin, { action: "match_deposit", depositId: r.depositId, orderId: oD.id, force: true, note: "차액 별도 입금 확인" });
  assert.equal((await orderRow(oD.id)).status, "paid");
  counter.checks++;
  // Admin confirm racing the webhook → exactly one paid transition
  const E = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매5 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: E.id, amount: 1700 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oE = (await query("SELECT * FROM orders WHERE listing_id=$1", [E.id]))[0];
  const [adminRes, hookRes] = await Promise.all([
    postRaw(admin, { action: "confirm_payment", orderId: oE.id }),
    hook({ eventId: `qa-${run}-5`, amount: 170000, depositor: `${oE.deposit_code}QA홍길동` }, { auth: "static" }),
  ]);
  assert.ok((adminRes.status === 200) !== (hookRes.body.result === "matched"), "only one side confirms");
  assert.equal((await orderRow(oE.id)).status, "paid");
  const revealed = (await query("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='contact_revealed' AND ref_id=$2", [b1, oE.id]))[0].n;
  assert.equal(revealed, 1);
  counter.checks++;
  // report_payment re-matches a pending deposit that now has name evidence
  const F = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매6 ${run}` } }, 201);
  await post(b2, { action: "bid", productId: F.id, amount: 1900 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oF = (await query("SELECT * FROM orders WHERE listing_id=$1", [F.id]))[0];
  r = await hook({ eventId: `qa-${run}-6`, amount: 190000, depositor: "QA대리인" }, { auth: "static" });
  assert.equal(r.body.reason, "review");
  await query("UPDATE deposits SET received_at=$2 WHERE id=$1", [r.body.depositId, new Date(Date.now() - 180000).toISOString()]);
  const rep = await post(b2, { action: "report_payment", orderId: oF.id, depositor: "QA대리인" });
  assert.equal(rep.autoConfirmed, true);
  assert.equal((await orderRow(oF.id)).status, "paid");
  // SMS text path
  const G = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매7 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: G.id, amount: 2100 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oG = (await query("SELECT * FROM orders WHERE listing_id=$1", [G.id]))[0];
  r = await hook({ provider: "sms", eventId: `qa-${run}-7`, text: `[KB국민] 09/21 14:02 입금 210,000원 ${oG.deposit_code}QA홍길동 잔액 5,000,000원` }, { auth: "static" });
  assert.equal(r.body.result, "matched");
  const H = await post(seller, { action: "create_listing", product: { ...base, title: `QA 입금 경매8 ${run}` } }, 201);
  await post(b2, { action: "bid", productId: H.id, amount: 2300 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const oH = (await query("SELECT * FROM orders WHERE listing_id=$1", [H.id]))[0];
  r = await hook({ provider: "sms", eventId: `qa-${run}-7b`, text: `[신한] 09/21 14:02 ${oH.deposit_code}QA김철수 입금 230,000원 잔액 300,000` }, { auth: "static" });
  assert.equal(r.body.result, "matched", "depositor before the keyword");
  r = await hook({ provider: "sms", eventId: `qa-${run}-8`, text: "[KB국민] 출금 30,000원 홍길동" }, { auth: "static" });
  assert.equal(r.body.result, "ignored");
  r = await hook({ provider: "sms", eventId: `qa-${run}-9`, text: "qa-알 수 없는 문자" }, { auth: "static" });
  assert.equal(r.body.result, "unparsed");
  // Admin GET lists pending deposits with candidates; buyers never see the ledger
  const adminData = await get(admin);
  assert.ok(Array.isArray(adminData.deposits));
  assert.deepEqual((await get(b1)).deposits, []);
  counter.checks++;
  console.log(JSON.stringify({ result: "PASS", checks: counter.checks, coverage: [
    "auth matrix (static, hmac, stale t, tamper, size, type, method)",
    "code + amount auto-confirm", "replay idempotency", "already paid hint", "amount mismatch", "review without evidence",
    "name evidence match", "admin dismiss/record/match/force", "admin vs webhook race", "report_payment re-match", "sms path", "ledger visibility",
  ] }, null, 2));
} finally {
  await cleanup(users, [qaDistrict]);
}
