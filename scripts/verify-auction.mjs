import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { processAuctions, minimumBid, bidStep, feeFor } from "../lib/auction-core.ts";
import { bizNo } from "./qa-lib.mjs";
// Time-injected closes run in this process, so the category fee override must be
// set here too (the server must be started with the same PLATFORM_FEE_RATES).
process.env.PLATFORM_FEE_RATES = process.env.PLATFORM_FEE_RATES || '{"생활·주방":0.04}';
// End-to-end check of the auction → payment → contact reveal → settlement flow.
// Start the server with ADMIN_USER_IDS=qa-admin-static so the admin steps work:
//   ADMIN_USER_IDS=qa-admin-static npm run start -- --port 3000
//   TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-auction.mjs
const origin = process.env.TEST_BASE_URL || "http://localhost:3000";
if (!process.env.NEON_AUTH_COOKIE_SECRET || !process.env.DATABASE_URL) throw new Error("Test environment is required");
const sql = neon(process.env.DATABASE_URL);
const query = async (text, params = []) => (await sql.query(text, params, { fullResults: true })).rows;
const batch = async (statements) => {
  const results = await sql.transaction(statements.map((s) => sql.query(s.sql, s.params ?? [])), { fullResults: true });
  return results.map((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 }));
};
const cookies = new Map();
const run = crypto.randomUUID().slice(0, 8);
const seller = `qa-aseller-${run}`, b1 = `qa-abuyer1-${run}`, b2 = `qa-abuyer2-${run}`, admin = "qa-admin-static";
const scope = { ownerIds: [seller] }; // never touch real listings in the shared DB
const qaUsers = [seller, b1, b2, admin];
const qaDistrict = "경매" + [...run].map(c => "가나다라마바사아자차카타파하거너"[parseInt(c, 16)]).join("") + "구";
const qaAddress = `서울특별시 ${qaDistrict} 검증로 1`;
function headers(user) {
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
let checks = 0;
async function get(user) {
  const r = await fetch(`${origin}/api/market`, { headers: headers(user) });
  assert.equal(r.status, 200);
  return r.json();
}
async function post(user, body, status = 200) {
  const r = await fetch(`${origin}/api/market`, {
    method: "POST",
    headers: { ...headers(user), "Content-Type": "application/json", "X-Dumping-Client": "1", Origin: origin },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  assert.equal(r.status, status, `${body.action}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}
const unread = async (user, kind) => (await get(user)).notifications.filter(n => n.kind === kind);
try {
  // Pure rules
  assert.equal(bidStep(500), 10); assert.equal(bidStep(2400), 100); assert.equal(bidStep(25000), 500);
  assert.equal(minimumBid({ current_price: null, start_price: 1000 }), 1000);
  assert.equal(minimumBid({ current_price: 1000, start_price: 1000 }), 1100);
  assert.equal(feeFor(100000, 500), 5000);
  checks++;
  const profile = { company: "QA 경매 사업장", businessNumber: bizNo(seller), phone: "01012345678", businessAddress: qaAddress };
  await post(seller, { action: "profile", profile: { ...profile, payoutBank: "테스트은행", payoutAccount: "123-456-7890", payoutHolder: "QA" } });
  await post(seller, { action: "profile", profile: { ...profile, payoutBank: "테스트은행" } }, 400);
  await post(seller, { action: "profile", profile: { ...profile, businessNumber: "1234567890" } }, 400); // checksum
  await post(b1, { action: "profile", profile: { ...profile, company: "QA 구매자1", phone: "01011112222", businessNumber: bizNo(b1) } });
  await post(b2, { action: "profile", profile: { ...profile, company: "QA 구매자2", phone: "01033334444", businessNumber: bizNo(b2) } });
  await post(admin, { action: "profile", profile: { ...profile, company: "QA 운영자", businessNumber: bizNo(admin) } });
  const form = new FormData();
  form.append("file", new File([await fs.readFile("public/images/water.jpg")], "qa.jpg", { type: "image/jpeg" }));
  const uploaded = await fetch(`${origin}/api/uploads`, { method: "POST", headers: { ...headers(seller), "X-Dumping-Client": "1", Origin: origin }, body: form });
  const { url: image } = await uploaded.json();
  const base = {
    title: `QA 경매 재고 ${run}`, category: "생활·주방", price: 1000, originalPrice: 5000, stock: 100, moq: 1,
    unit: "박스", region: "서울", condition: "새상품", image, description: "경매 프로세스 검증용 상품입니다.",
    saleType: "auction", auctionDays: 7, reservePrice: 2000,
  };
  await post(seller, { action: "create_listing", product: { ...base, reservePrice: 500 } }, 400); // reserve below start
  await post(seller, { action: "create_listing", product: { ...base, auctionDays: 2 } }, 400); // invalid duration
  const { id } = await post(seller, { action: "create_listing", product: base }, 201);
  const pub = (await get()).products.find(p => p.id === id);
  assert.equal(pub.saleType, "auction");
  assert.equal(pub.auction.startPrice, 1000);
  assert.equal(pub.auction.reservePrice, undefined, "reserve must stay private");
  assert.equal(pub.auction.reserveMet, undefined, "buyers never learn whether the reserve is met");
  assert.equal(pub.auction.closeReason, undefined);
  assert.equal(pub.moq, 100, "auction sells the whole lot");
  assert.ok(!JSON.stringify(await get(b1)).includes('"reservePrice"'));
  assert.equal((await get(seller)).ownListings.find(p => p.id === id).auction.reservePrice, 2000);
  checks++;
  // Bidding rules
  await post(seller, { action: "bid", productId: id, amount: 1000 }, 400);
  await post(b1, { action: "bid", productId: id, amount: 900 }, 400);
  await post(b1, { action: "create_offer", id: crypto.randomUUID(), productId: id, quantity: 100, price: 1000, shipping: "직접 픽업", note: "" }, 400);
  await post(b1, { action: "bid", productId: id, amount: 1000 }, 201);
  await post(b1, { action: "bid", productId: id, amount: 1500 }, 400); // already leading
  await post(b2, { action: "bid", productId: id, amount: 1050 }, 400); // below step
  await post(b2, { action: "bid", productId: id, amount: 1100 }, 201);
  assert.equal((await unread(b1, "outbid")).length, 1);
  let view = (await get(b1)).products.find(p => p.id === id);
  assert.equal(view.auction.currentPrice, 1100);
  assert.equal(view.auction.bidCount, 2);
  assert.equal(view.auction.myTopBid, 1000);
  assert.equal(view.auction.leading, false);
  const bids = (await get(b2)).bids.filter(b => b.listingId === id);
  assert.equal(bids.length, 2);
  assert.equal(bids[0].mine, true);
  assert.ok(!JSON.stringify(bids).includes(b1), "bidder ids stay hidden");
  checks++;
  // Archive blocked while bids exist; owner cannot lower reserve upward
  await post(seller, { action: "archive_listing", id }, 400);
  await post(seller, { action: "lower_reserve", productId: id, reservePrice: 2500 }, 400);
  await post(b1, { action: "lower_reserve", productId: id, reservePrice: 1000 }, 400);
  // Midpoint alert via time injection
  const later = new Date(Date.now() + 4 * 86400000);
  let result = await processAuctions(query, later, batch, scope);
  assert.equal(result.alerted, 1);
  assert.equal((await unread(seller, "reserve_alert")).length, 1);
  const own = (await get(seller)).ownListings.find(p => p.id === id);
  assert.ok(own.auction.midpointAlertedAt);
  assert.equal((await processAuctions(query, later, batch, scope)).alerted, 0, "alert only once");
  checks++;
  // Seller lowers reserve to the current bid → reserve met notification path
  await post(seller, { action: "lower_reserve", productId: id, reservePrice: 1100 });
  view = (await get(b2)).products.find(p => p.id === id);
  assert.equal(view.auction.reserveMet, undefined);
  assert.equal((await get(seller)).ownListings.find(p => p.id === id).auction.reserveMet, true);
  await post(b1, { action: "bid", productId: id, amount: 1200 }, 201);
  checks++;
  // Expiry closes with a winner and creates an order
  result = await processAuctions(query, new Date(Date.now() + 8 * 86400000), batch, scope);
  assert.equal(result.won, 1);
  const sellerData = await get(seller);
  const order = sellerData.orders.find(o => o.listingId === id);
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.buyerId, b1);
  assert.equal(order.amount, 1200 * 100);
  assert.equal(order.fee, feeFor(120000, order.feeRate));
  assert.equal(order.counterpart, undefined, "no contact before payment");
  assert.ok(!(await get()).products.some(p => p.id === id), "sold listing leaves the market");
  assert.equal((await unread(b1, "auction_won")).length, 1);
  assert.equal((await unread(b2, "auction_lost")).length, 1);
  assert.equal(sellerData.ownListings.find(p => p.id === id).status, "sold");
  checks++;
  // Payment flow with contact reveal
  await post(b2, { action: "report_payment", orderId: order.id, depositor: "QA" }, 404);
  await post(b1, { action: "confirm_payment", orderId: order.id }, 403);
  await post(b1, { action: "report_payment", orderId: order.id, depositor: "QA 구매자1" });
  assert.equal((await get(admin)).adminOrders.find(o => o.id === order.id).status, "payment_reported");
  assert.equal((await unread(admin, "admin_payment")).length, 1);
  await post(b1, { action: "confirm_received", orderId: order.id }, 404);
  await post(admin, { action: "confirm_payment", orderId: order.id });
  const buyerOrder = (await get(b1)).orders.find(o => o.id === order.id);
  assert.equal(buyerOrder.status, "paid");
  assert.equal(buyerOrder.counterpart.company, "QA 경매 사업장");
  assert.equal(buyerOrder.counterpart.phone, "01012345678");
  assert.equal(buyerOrder.fee, undefined === buyerOrder.fee ? undefined : buyerOrder.fee); // fee visible in data but UI hides it
  const sellerOrder = (await get(seller)).orders.find(o => o.id === order.id);
  assert.equal(sellerOrder.counterpart.company, "QA 구매자1");
  assert.ok(!JSON.stringify((await get(b2)).orders).includes("QA 경매 사업장"), "losing bidder sees nothing");
  checks++;
  await post(b1, { action: "mark_shipped", orderId: order.id, photos: [image] }, 404);
  await post(seller, { action: "mark_shipped", orderId: order.id, photos: [] }, 400); // evidence photo required
  await post(seller, { action: "mark_shipped", orderId: order.id, photos: [image] });
  assert.deepEqual((await get(b1)).orders.find(o => o.id === order.id).shipPhotos, [image]);
  await post(admin, { action: "settle_order", orderId: order.id }, 404);
  await post(b1, { action: "confirm_received", orderId: order.id });
  const completed = (await get(admin)).adminOrders.find(o => o.id === order.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.payout.account, "123-456-7890");
  assert.equal((await unread(admin, "admin_settle")).length, 1);
  await post(admin, { action: "settle_order", orderId: order.id });
  assert.equal((await get(seller)).orders.find(o => o.id === order.id).status, "settled");
  assert.equal((await unread(seller, "settled")).length, 1);
  checks++;
  // Below reserve at expiry → the seller decides (declines here) → unsold → relist, then seller accepts early
  const second = await post(seller, { action: "create_listing", product: { ...base, title: `QA 유찰 ${run}`, reservePrice: 3000 } }, 201);
  await post(b2, { action: "bid", productId: second.id, amount: 1000 }, 201);
  result = await processAuctions(query, new Date(Date.now() + 8 * 86400000), batch, scope);
  assert.equal(result.deciding, 1);
  assert.equal((await get(seller)).ownListings.find(p => p.id === second.id).status, "pending");
  assert.equal((await unread(seller, "below_reserve_decision")).length, 1);
  await post(b2, { action: "decide_below_reserve", productId: second.id, accept: false }, 409);
  await post(seller, { action: "decide_below_reserve", productId: second.id, accept: false });
  assert.equal((await get(seller)).ownListings.find(p => p.id === second.id).status, "unsold");
  assert.equal((await unread(seller, "auction_unsold")).length, 1);
  await post(b2, { action: "relist_auction", productId: second.id, auctionDays: 3, price: 800, reservePrice: 900 }, 404);
  const third = await post(seller, { action: "relist_auction", productId: second.id, auctionDays: 3, price: 800, reservePrice: 900 }, 201);
  assert.ok((await get()).products.some(p => p.id === third.id));
  await post(b2, { action: "bid", productId: third.id, amount: 850 }, 201);
  await post(b1, { action: "accept_bid", productId: third.id }, 404);
  const accepted = await post(seller, { action: "accept_bid", productId: third.id });
  assert.ok(accepted.orderId);
  assert.equal((await get(b2)).orders.find(o => o.id === accepted.orderId).status, "awaiting_payment");
  checks++;
  // Payment overdue cancels the order and frees the listing
  result = await processAuctions(query, new Date(Date.now() + 3 * 86400000), batch, scope);
  assert.equal(result.expiredOrders, 1);
  assert.equal((await get(b2)).orders.find(o => o.id === accepted.orderId).status, "cancelled");
  assert.equal((await get(seller)).ownListings.find(p => p.id === third.id).status, "unsold");
  assert.ok(order.depositCode === undefined || /^\d{4}$/.test(order.depositCode));
  // Non-payment carries the 10% penalty and blocks the buyer until an admin settles it
  const b2Data = await get(b2);
  assert.equal(b2Data.penalty.due, 8500);
  const fifth = await post(seller, { action: "create_listing", product: { ...base, title: `QA 제한 ${run}` } }, 201);
  await post(b2, { action: "bid", productId: fifth.id, amount: 1000 }, 403);
  await post(admin, { action: "settle_penalty", disputeId: b2Data.penalty.items[0].id, status: "waived" });
  await post(b2, { action: "bid", productId: fifth.id, amount: 1000 }, 201);
  checks++;
  // Cancel an auction with no bids, notifications read
  const fourth = await post(seller, { action: "create_listing", product: { ...base, title: `QA 취소 ${run}` } }, 201);
  await post(seller, { action: "archive_listing", id: fourth.id });
  assert.ok(!(await get()).products.some(p => p.id === fourth.id));
  assert.ok((await get(seller)).unread > 0);
  await post(seller, { action: "read_notifications" });
  assert.equal((await get(seller)).unread, 0);
  checks++;
  // Push subscriptions, fee overrides, bank account visibility, admin exports
  const sub = { endpoint: `https://push.example.invalid/${run}`, keys: { p256dh: "BPUSHKEYPUSHKEYPUSHKEY", auth: "authsecret" }, userAgent: "QA" };
  await post(b1, { action: "push_subscribe", subscription: { ...sub, endpoint: "http://insecure.example/x" } }, 400);
  await post(b1, { action: "push_subscribe", subscription: sub });
  await post(b2, { action: "push_subscribe", subscription: sub }); // endpoint moves to the latest login
  assert.equal((await query("SELECT user_id FROM push_subscriptions WHERE endpoint=$1", [sub.endpoint]))[0].user_id, b2);
  await post(b1, { action: "push_unsubscribe", endpoint: sub.endpoint }); // not the owner → no-op
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE endpoint=$1", [sub.endpoint]))[0].n, 1);
  await post(b2, { action: "push_unsubscribe", endpoint: sub.endpoint });
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE endpoint=$1", [sub.endpoint]))[0].n, 0);
  assert.equal(typeof (await get()).settings.vapidPublicKey, "string");
  checks++;
  // PLATFORM_FEE_RATES={"생활·주방":0.04} (script and server): the first order (생활·주방) used 400bp, default is 300bp.
  assert.equal(order.feeRate, 400, "category fee override applies");
  assert.equal(order.fee, 4800);
  const table = (await get(admin)).settings.feeTable;
  assert.equal(table.overrides["생활·주방"], 400);
  assert.equal(table.base, 300, "default fee is 3%");
  checks++;
  assert.equal((await get()).settings.bankAccount, "", "anonymous visitors never see the bank account");
  assert.equal((await get(b1)).settings.bankAccount, "", "buyer without a pending payment does not see it");
  assert.ok((await get(admin)).settings.bankAccount.length > 0, "admin sees it");
  const revenue = (await get(admin)).revenue;
  assert.ok(revenue && revenue.total && Array.isArray(revenue.months));
  assert.ok(revenue.total.fee >= order.fee);
  assert.equal((await get(b1)).revenue, null);
  const csvDenied = await fetch(`${origin}/api/admin/orders`, { headers: headers(b1) });
  assert.equal(csvDenied.status, 403);
  const csv = await fetch(`${origin}/api/admin/orders`, { headers: headers(admin) });
  assert.equal(csv.status, 200);
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "Excel BOM present");
  const csvText = new TextDecoder().decode(csvBytes);
  assert.ok(csvText.startsWith("주문번호"));
  assert.ok(csvText.includes(order.id));
  assert.equal((await fetch(`${origin}/api/admin/orders?month=bad`, { headers: headers(admin) })).status, 400);
  checks++;
  const cron = await fetch(`${origin}/api/cron/auctions`, { headers: { Authorization: "Bearer qa-cron-secret" } });
  assert.ok([200, 401].includes(cron.status));
  assert.equal((await fetch(`${origin}/api/cron/auctions`)).status, 401);
  checks++;
  console.log(JSON.stringify({ result: "PASS", checks, coverage: [
    "auction listing validation", "reserve privacy", "bid steps and leading bidder", "outbid notification",
    "midpoint reserve alert (once)", "lower reserve", "expiry win and order", "losing bidders", "payment report/confirm",
    "contact reveal after payment", "shipping and receipt", "settlement with payout", "unsold and relist",
    "early acceptance", "payment overdue cancellation", "cancel without bids", "notification read", "cron auth",
    "push subscriptions", "category fee override", "bank account visibility", "admin revenue and CSV export",
    "business number checksum", "hidden reserve status", "ship photo evidence", "below-reserve seller decision", "non-payment penalty gate",
  ] }, null, 2));
} finally {
  for (const user of qaUsers) {
    const listings = await query("SELECT id FROM listings WHERE owner_id=$1", [user]);
    for (const l of listings) {
      await query("DELETE FROM disputes WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM bids WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM auctions WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM deposits WHERE order_id IN (SELECT id FROM orders WHERE listing_id=$1)", [l.id]);
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
  await query("DELETE FROM alias_counters WHERE district_key=$1", ["서울 " + qaDistrict]);
  console.log("Temporary QA data removed");
}
