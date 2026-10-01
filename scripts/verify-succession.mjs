// This suite covers allocation/succession; the non-payment penalty is covered by verify-disputes.mjs.
process.env.PENALIZE_NONPAYMENT = "false";
// Runner-up offers are off in production; this suite exercises them (start the server with AUCTION_SUCCESSION=on).
process.env.AUCTION_SUCCESSION = "on";
import { processAuctions, succeed } from "../lib/auction-core.ts";
import { assert, admin, assertInvariant, batch, cleanup, counter, district, get, notesOf, post, postRaw, query, run, setupUsers, uploadImage } from "./qa-lib.mjs";
// Second-bidder succession: whole-lot and partial, accept/decline/expire,
// round and window limits, idempotency. Requires ADMIN_USER_IDS=qa-admin-static.
const seller = `qa-sseller-${run}`, b1 = `qa-sb1-${run}`, b2 = `qa-sb2-${run}`, b3 = `qa-sb3-${run}`;
const scope = { ownerIds: [seller] }; // never touch real listings in the shared DB
const users = [seller, b1, b2, b3, admin];
const qaDistrict = district("승계");
const later = (days) => new Date(Date.now() + days * 86400000);
const status = async (id) => (await query("SELECT status, succession_round, parent_order_id, offer_expires_at, payment_due_at FROM orders WHERE id=$1", [id]))[0];
try {
  await setupUsers({ [seller]: "QA 승계 공급자", [b1]: "QA 승계 구매자1", [b2]: "QA 승계 구매자2", [b3]: "QA 승계 구매자3", [admin]: "QA 운영자" }, qaDistrict);
  const image = await uploadImage(seller);
  const base = {
    title: `QA 승계 경매 ${run}`, category: "생활·주방", price: 1000, originalPrice: 5000, stock: 100, moq: 1, unit: "박스", region: "서울",
    condition: "새상품", image, description: "차순위 승계 검증용 상품입니다.", saleType: "auction", auctionDays: 7, reservePrice: 1100,
  };
  // Whole-lot: b1 wins at 1200, b2 bid 1100 (>= reserve), b3 bid 1000 (< reserve)
  const { id } = await post(seller, { action: "create_listing", product: base }, 201);
  await post(b3, { action: "bid", productId: id, amount: 1000 }, 201);
  await post(b2, { action: "bid", productId: id, amount: 1100 }, 201);
  await post(b1, { action: "bid", productId: id, amount: 1200 }, 201);
  await post(b2, { action: "bid", productId: id, amount: 1300 }, 201); // b2 is now top with two bids
  await post(b1, { action: "bid", productId: id, amount: 1400 }, 201);
  let result = await processAuctions(query, later(8), batch, scope);
  assert.equal(result.won, 1);
  const first = (await query("SELECT * FROM orders WHERE listing_id=$1", [id]))[0];
  assert.equal(first.buyer_id, b1); assert.equal(first.amount, 1400 * 100);
  // b1 defaults → b2 (highest bid 1300, counted once) is offered
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [first.id, new Date(Date.now() - 1000).toISOString()]);
  result = await processAuctions(query, new Date(), batch, scope);
  assert.equal(result.expiredOrders, 1);
  const offers = await query("SELECT * FROM orders WHERE listing_id=$1 AND status='offered'", [id]);
  assert.equal(offers.length, 1);
  const offer = offers[0];
  assert.equal(offer.buyer_id, b2); assert.equal(offer.succession_round, 1); assert.equal(offer.parent_order_id, first.id);
  assert.equal(offer.amount, 1300 * 100); assert.equal(offer.unit_price, 1300);
  assert.ok(Date.parse(offer.offer_expires_at) > Date.now() + 23 * 3600000);
  assert.equal((await notesOf(b2, "succession_offer")).length, 1);
  assert.equal((await notesOf(seller, "succession_offered")).length, 1);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [id]))[0].status, "sold");
  const a1 = (await query("SELECT sold_quantity, unsold_quantity FROM auctions WHERE listing_id=$1", [id]))[0];
  assert.equal(a1.sold_quantity, 100); assert.equal(a1.unsold_quantity, 0);
  const buyerView = (await get(b2)).orders.find((o) => o.id === offer.id);
  assert.equal(buyerView.status, "offered"); assert.ok(buyerView.depositCode);
  await assertInvariant();
  counter.checks++;
  // Idempotency: succeed() again for the same cancelled order → nothing new
  assert.equal(await succeed(query, batch, first.id, new Date().toISOString()), null);
  await query("UPDATE orders SET succession_token=NULL WHERE id=$1", [first.id]);
  result = await processAuctions(query, new Date(), batch, scope);
  assert.equal(result.succeeded, 1);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [id]))[0].n, 1, "re-driven succession creates no duplicate offer");
  counter.checks++;
  // accept_offer by the wrong buyer → 409; by b2 → awaiting_payment with a fresh 24h due
  await post(b1, { action: "accept_offer", orderId: offer.id }, 409);
  await post(b2, { action: "accept_offer", orderId: offer.id });
  let s = await status(offer.id);
  assert.equal(s.status, "awaiting_payment"); assert.ok(Date.parse(s.payment_due_at) > Date.now() + 23 * 3600000);
  assert.equal((await notesOf(seller, "succession_accepted")).length, 1);
  await post(b2, { action: "accept_offer", orderId: offer.id }, 409);
  // b2 defaults too → round 2: b3 bid 1000 is below reserve → no candidate → unsold
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [offer.id, new Date(Date.now() - 1000).toISOString()]);
  result = await processAuctions(query, new Date(), batch, scope);
  assert.equal(result.expiredOrders, 1);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [id]))[0].n, 0);
  assert.equal((await notesOf(seller, "succession_exhausted")).length, 1);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [id]))[0].status, "unsold");
  const a2 = (await query("SELECT sold_quantity, unsold_quantity FROM auctions WHERE listing_id=$1", [id]))[0];
  assert.equal(a2.sold_quantity, 0); assert.equal(a2.unsold_quantity, 100);
  await assertInvariant();
  counter.checks++;
  // Decline path: fresh auction, b1 wins, b2 declines the offer → b3 (>= reserve) gets round 2
  const two = await post(seller, { action: "create_listing", product: { ...base, title: `QA 거절 ${run}` } }, 201);
  await post(b3, { action: "bid", productId: two.id, amount: 1100 }, 201);
  await post(b2, { action: "bid", productId: two.id, amount: 1200 }, 201);
  await post(b1, { action: "bid", productId: two.id, amount: 1300 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const w2 = (await query("SELECT id FROM orders WHERE listing_id=$1 AND buyer_id=$2", [two.id, b1]))[0];
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [w2.id, new Date(Date.now() - 1000).toISOString()]);
  await processAuctions(query, new Date(), batch, scope);
  const o2 = (await query("SELECT id FROM orders WHERE listing_id=$1 AND buyer_id=$2 AND status='offered'", [two.id, b2]))[0];
  assert.ok(o2);
  await post(b3, { action: "decline_offer", orderId: o2.id }, 404);
  await post(b2, { action: "decline_offer", orderId: o2.id });
  assert.equal((await status(o2.id)).status, "cancelled");
  const o3 = (await query("SELECT * FROM orders WHERE listing_id=$1 AND buyer_id=$2 AND status='offered'", [two.id, b3]))[0];
  assert.ok(o3, "next candidate offered after decline"); assert.equal(o3.succession_round, 2);
  // Offer expiry via time injection → no round 3 → unsold
  result = await processAuctions(query, new Date(Date.now() + 25 * 3600000), batch, scope);
  assert.equal(result.expiredOffers, 1);
  assert.equal((await status(o3.id)).status, "cancelled");
  assert.equal((await query("SELECT cancel_reason FROM orders WHERE id=$1", [o3.id]))[0].cancel_reason, "offer_expired");
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [two.id]))[0].status, "unsold");
  await assertInvariant();
  counter.checks++;
  // Succession disabled → cancelled winner leaves the listing unsold immediately
  const off = await post(seller, { action: "create_listing", product: { ...base, title: `QA 승계 없음 ${run}`, successionEnabled: false } }, 201);
  await post(b2, { action: "bid", productId: off.id, amount: 1100 }, 201);
  await post(b1, { action: "bid", productId: off.id, amount: 1200 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const w3 = (await query("SELECT id FROM orders WHERE listing_id=$1", [off.id]))[0];
  await post(admin, { action: "cancel_order", orderId: w3.id, reason: "QA 운영자 취소" });
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [off.id]))[0].n, 0);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [off.id]))[0].status, "unsold");
  // Window passed → no offer
  const late = await post(seller, { action: "create_listing", product: { ...base, title: `QA 기간 경과 ${run}` } }, 201);
  await post(b2, { action: "bid", productId: late.id, amount: 1100 }, 201);
  await post(b1, { action: "bid", productId: late.id, amount: 1200 }, 201);
  await processAuctions(query, later(8), batch, scope);
  await query("UPDATE auctions SET succession_until=$2 WHERE listing_id=$1", [late.id, new Date(Date.now() - 1000).toISOString()]);
  const w4 = (await query("SELECT id FROM orders WHERE listing_id=$1", [late.id]))[0];
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [w4.id, new Date(Date.now() - 1000).toISOString()]);
  await processAuctions(query, new Date(), batch, scope);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [late.id]))[0].n, 0);
  counter.checks++;
  // Partial succession: 500 lot, min 100; b1 1300×300 (won), b2 1200×200 (won), b3 1100×200 (lost). b1 defaults → b3 gets 200, 100 unsold.
  const part = await post(seller, { action: "create_listing", product: { ...base, title: `QA 부분 승계 ${run}`, stock: 500, auctionMode: "partial", minLot: 100 } }, 201);
  await post(b3, { action: "bid", productId: part.id, unitPrice: 1100, quantity: 200 }, 201);
  await post(b2, { action: "bid", productId: part.id, unitPrice: 1200, quantity: 200 }, 201);
  await post(b1, { action: "bid", productId: part.id, unitPrice: 1300, quantity: 300 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const pOrders = await query("SELECT id, buyer_id, quantity FROM orders WHERE listing_id=$1 ORDER BY unit_price DESC", [part.id]);
  assert.deepEqual(pOrders.map((o) => [o.buyer_id, o.quantity]), [[b1, 300], [b2, 200]]);
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [pOrders[0].id, new Date(Date.now() - 1000).toISOString()]);
  await processAuctions(query, new Date(), batch, scope);
  const pOffers = await query("SELECT buyer_id, quantity, unit_price FROM orders WHERE listing_id=$1 AND status='offered'", [part.id]);
  assert.deepEqual(pOffers.map((o) => [o.buyer_id, o.quantity, o.unit_price]), [[b3, 200, 1100]]);
  const pa = (await query("SELECT sold_quantity, unsold_quantity FROM auctions WHERE listing_id=$1", [part.id]))[0];
  assert.equal(pa.sold_quantity, 400); assert.equal(pa.unsold_quantity, 100);
  const pOfferId = (await query("SELECT id FROM orders WHERE listing_id=$1 AND status='offered'", [part.id]))[0].id;
  await post(b3, { action: "accept_offer", orderId: pOfferId });
  assert.equal((await query("SELECT status, allocated_quantity FROM bids WHERE listing_id=$1 AND bidder_id=$2 AND status<>'replaced'", [part.id, b3]))[0].status, "won");
  assert.equal((await query("SELECT allocated_quantity FROM bids WHERE listing_id=$1 AND bidder_id=$2 AND status<>'replaced'", [part.id, b3]))[0].allocated_quantity, 200);
  // Remainder relist blocked while an offer is pending, allowed afterwards
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [pOrders[1].id, new Date(Date.now() - 1000).toISOString()]);
  await processAuctions(query, new Date(), batch, scope); // b2 defaults; no remaining candidate (b3 already has an order) → unsold grows
  const pa2 = (await query("SELECT sold_quantity, unsold_quantity FROM auctions WHERE listing_id=$1", [part.id]))[0];
  assert.equal(pa2.sold_quantity, 200); assert.equal(pa2.unsold_quantity, 300);
  const rr = await postRaw(seller, { action: "relist_remainder", productId: part.id, auctionDays: 3, price: 800, reservePrice: 900, expected: 300 });
  assert.equal(rr.status, 201);
  await assertInvariant();
  counter.checks++;
  // Two concurrent succeed() calls on two cancelled orders of one listing never over-offer
  const race = await post(seller, { action: "create_listing", product: { ...base, title: `QA 승계 경합 ${run}`, stock: 400, auctionMode: "partial", minLot: 100 } }, 201);
  await post(b3, { action: "bid", productId: race.id, unitPrice: 1100, quantity: 200 }, 201);
  await post(b2, { action: "bid", productId: race.id, unitPrice: 1200, quantity: 200 }, 201);
  await post(b1, { action: "bid", productId: race.id, unitPrice: 1300, quantity: 200 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const rOrders = await query("SELECT id FROM orders WHERE listing_id=$1", [race.id]);
  assert.equal(rOrders.length, 2);
  const now = new Date().toISOString();
  for (const o of rOrders) await query("UPDATE orders SET status='cancelled', cancelled_at=$2, cancel_reason='payment_overdue' WHERE id=$1", [o.id, now]);
  await Promise.all(rOrders.map((o) => succeed(query, batch, o.id, now)));
  const offeredQty = (await query("SELECT COALESCE(SUM(quantity),0)::int AS q FROM orders WHERE listing_id=$1 AND status='offered' AND buyer_id=$2", [race.id, b3]))[0].q;
  assert.ok(offeredQty <= 200, `b3 offered ${offeredQty} > capacity 200`);
  await assertInvariant();
  counter.checks++;
  console.log(JSON.stringify({ result: "PASS", checks: counter.checks, coverage: [
    "whole-lot succession offer", "per-bidder highest bid once", "listing stays sold while offered", "idempotent and re-drivable succession",
    "accept offer with fresh due", "round limit → unsold", "decline → next candidate", "offer expiry", "succession disabled", "window passed",
    "partial succession with capacity", "bid allocation on accept", "remainder relist after offers", "concurrent succession capacity",
  ] }, null, 2));
} finally {
  await cleanup(users, [qaDistrict]);
}
