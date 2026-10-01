import { processAuctions, feeFor } from "../lib/auction-core.ts";
import { assert, admin, batch, bizNo, cleanup, counter, district, get, headers, notesOf, origin, post, postRaw, query, run, setupUsers, uploadImage } from "./qa-lib.mjs";
// 전량경매 design doc: public instant price, fully hidden reserve, live endpoint,
// below-reserve decision flow, self-dealing guards. Requires ADMIN_USER_IDS=qa-admin-static.
// Time-injected closes below only touch seller2's listings; unpaid test orders must
// not turn into real penalties that would block the buyers mid-run.
process.env.PENALIZE_NONPAYMENT = "false";
const seller = `qa-iseller-${run}`, seller2 = `qa-iseller2-${run}`, b1 = `qa-ib1-${run}`, b2 = `qa-ib2-${run}`, b3 = `qa-ib3-${run}`, twin = `qa-itwin-${run}`;
const scope = { ownerIds: [seller2] }; // never touch real listings in the shared DB
const users = [seller, seller2, b1, b2, b3, twin, admin];
const qaDistrict = district("즉시");
const later = (days) => new Date(Date.now() + days * 86400000);
const RESERVE = 7313; // distinctive, so a leak is detectable anywhere in a JSON body
async function live(user, id, etag) {
  const r = await fetch(`${origin}/api/auctions/${id}/live`, { headers: { ...headers(user), ...(etag ? { "If-None-Match": etag } : {}) } });
  counter.checks++;
  return { status: r.status, etag: r.headers.get("etag"), body: r.status === 200 ? await r.json() : null };
}
// The reserve as a number or formatted text, but not as part of an id or a larger number.
const leaks = (json) => {
  const text = JSON.stringify(json);
  return /(?<![\w-])7,?313(?![\w-])/.test(text) || text.includes('"reservePrice"') || text.includes('"reserveMet"');
};
try {
  await setupUsers({ [seller]: "QA 즉시 공급자", [b1]: "QA 즉시 구매자1", [b2]: "QA 즉시 구매자2", [b3]: "QA 즉시 구매자3", [twin]: "QA 공급자 쌍둥이", [seller2]: "QA 즉시 공급자2", [admin]: "QA 운영자" }, qaDistrict,
    { [twin]: { businessNumber: bizNo(seller) } });
  const image = await uploadImage(seller), image2 = await uploadImage(seller2);
  const base = {
    title: `QA 즉시체결 ${run}`, category: "생활·주방", price: 5000, originalPrice: 20000, stock: 10, moq: 1, unit: "박스", region: "서울",
    condition: "새상품", image, description: "즉시체결가 검증용 상품입니다.", saleType: "auction", auctionDays: 7, reservePrice: RESERVE,
  };
  // Validation of the instant price
  await post(seller, { action: "create_listing", product: { ...base, instantPrice: 7000 } }, 400); // below reserve
  await post(seller, { action: "create_listing", product: { ...base, instantPrice: 25000 } }, 400); // above 정상가
  await post(seller, { action: "create_listing", product: { ...base, auctionMode: "partial", minLot: 5, instantPrice: 9000 } }, 400);
  const { id } = await post(seller, { action: "create_listing", product: { ...base, instantPrice: 12000 } }, 201);
  counter.checks++;
  // Buyers never see the reserve, its status or the close reason — in the market snapshot or the live feed
  const anon = await get();
  const pub = anon.products.find((p) => p.id === id);
  assert.equal(pub.auction.instantPrice, 12000);
  assert.ok(!leaks(pub), "reserve leaked to anonymous visitors");
  assert.ok(!leaks((await get(b1)).products.find((p) => p.id === id)), "reserve leaked to a buyer");
  const own = (await get(seller)).ownListings.find((p) => p.id === id);
  assert.equal(own.auction.reservePrice, RESERVE);
  assert.equal((await get(admin)).products.find((p) => p.id === id).auction.reservePrice, RESERVE, "admins see the reserve");
  let lv = await live(b1, id);
  assert.equal(lv.status, 200); assert.equal(lv.body.instantPrice, 12000); assert.equal(lv.body.bidderCount, 0);
  assert.ok(!leaks(lv.body), "reserve leaked through the live feed");
  const sellerLive = await live(seller, id);
  assert.equal(sellerLive.body.reservePrice, RESERVE);
  // ETag: unchanged → 304
  const again = await live(b1, id, lv.etag);
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${origin}/api/auctions/not-a-uuid/live`)).status, 404);
  counter.checks++;
  // Self-dealing: an account on the seller's business number cannot bid
  await post(twin, { action: "bid", productId: id, amount: 5000 }, 403);
  // Normal bids, live counters and the ETag changing
  await post(b1, { action: "bid", productId: id, amount: 5000 }, 201);
  await post(b2, { action: "bid", productId: id, amount: 5500 }, 201);
  lv = await live(b1, id, lv.etag);
  assert.equal(lv.status, 200); assert.equal(lv.body.currentPrice, 5500); assert.equal(lv.body.bidderCount, 2);
  assert.equal(lv.body.leading, false); assert.equal(lv.body.myTopBid, 5000); assert.equal(lv.body.bids[0].alias === "나", false);
  assert.ok(!leaks(lv.body));
  counter.checks++;
  // Seller adjusts the instant price: raise freely, lower only above the top bid and reserve
  await post(b1, { action: "set_instant_price", productId: id, instantPrice: 11000 }, 404);
  await post(seller, { action: "set_instant_price", productId: id, instantPrice: 15000 });
  await post(seller, { action: "set_instant_price", productId: id, instantPrice: 5500 }, 400); // not above the top bid
  await post(seller, { action: "set_instant_price", productId: id, instantPrice: 7000 }, 400); // below reserve
  await post(seller, { action: "set_instant_price", productId: id, instantPrice: 9000 });
  assert.equal((await notesOf(b1, "instant_price_changed")).length, 1, "bidders hear about a lower instant price only");
  // Buy-now at a stale price is refused; the leading bidder may still buy now
  await post(b1, { action: "bid", productId: id, buyNow: true, amount: 12000 }, 409);
  await post(b1, { action: "bid", productId: id, buyNow: true }, 400); // must name the price seen
  await post(b2, { action: "bid", productId: id, amount: 5600 }, 400); // already leading, below instant
  // A bid above the instant price wins at the instant price (never more)
  const won = await post(b3, { action: "bid", productId: id, amount: 9900 }, 201);
  assert.equal(won.instant, true); assert.equal(won.price, 9000); assert.ok(won.orderId);
  const order = (await query("SELECT * FROM orders WHERE id=$1", [won.orderId]))[0];
  assert.equal(order.buyer_id, b3); assert.equal(order.unit_price, 9000); assert.equal(order.amount, 90000);
  assert.equal(order.fee, feeFor(90000, order.fee_rate)); assert.equal(order.net, 90000 - order.fee);
  const closed = (await query("SELECT status, close_reason, current_price FROM auctions WHERE listing_id=$1", [id]))[0];
  assert.deepEqual([closed.status, closed.close_reason, closed.current_price], ["won", "instant", 9000]);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [id]))[0].status, "sold");
  assert.equal((await query("SELECT amount FROM bids WHERE listing_id=$1 AND bidder_id=$2", [id, b3]))[0].amount, 9000, "bid history shows the instant price");
  await post(b1, { action: "bid", productId: id, amount: 10000 }, 404); // auction over
  assert.equal((await notesOf(b3, "auction_won")).length, 1);
  assert.equal((await notesOf(seller, "auction_sold")).length, 1);
  assert.equal((await notesOf(b1, "auction_lost")).length, 1);
  assert.ok(!(await get()).products.some((p) => p.id === id), "sold listing leaves the market");
  assert.ok((await get(b1)).bidListings.some((p) => p.id === id), "losing bidder still sees the ended auction");
  counter.checks++;
  // Two buyers press buy-now at the same moment: exactly one order
  const race = await post(seller, { action: "create_listing", product: { ...base, title: `QA 즉시 경합 ${run}`, instantPrice: 10000 } }, 201);
  const pair = await Promise.all([
    postRaw(b1, { action: "bid", productId: race.id, buyNow: true, amount: 10000 }),
    postRaw(b2, { action: "bid", productId: race.id, buyNow: true, amount: 10000 }),
  ]);
  const statuses = pair.map((r) => r.status).sort();
  assert.equal(statuses[0], 201, JSON.stringify(pair)); assert.ok([404, 409].includes(statuses[1]), JSON.stringify(pair));
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1", [race.id]))[0].n, 1);
  // A bid racing the seller lowering the instant price never produces two outcomes
  const race2 = await post(seller, { action: "create_listing", product: { ...base, title: `QA 즉시 인하 경합 ${run}`, instantPrice: 15000 } }, 201);
  await post(b1, { action: "bid", productId: race2.id, amount: 8000 }, 201);
  const [bidRes, setRes] = await Promise.all([
    postRaw(b2, { action: "bid", productId: race2.id, amount: 9000 }),
    postRaw(seller, { action: "set_instant_price", productId: race2.id, instantPrice: 8500 }),
  ]);
  const a2 = (await query("SELECT status, current_price, instant_price FROM auctions WHERE listing_id=$1", [race2.id]))[0];
  if (setRes.status === 200 && bidRes.status === 201) assert.equal(a2.status, "won", "bid after the cut wins instantly");
  if (a2.status === "won") assert.equal(a2.current_price, a2.instant_price);
  assert.ok((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1", [race2.id]))[0].n <= 1);
  counter.checks++;
  // Live endpoint closes lazily at the deadline, for that listing only
  const lazy = await post(seller, { action: "create_listing", product: { ...base, title: `QA 즉시 지연마감 ${run}`, reservePrice: 5000, instantPrice: 9000 } }, 201);
  await post(b2, { action: "bid", productId: lazy.id, amount: 5000 }, 201);
  await query("UPDATE auctions SET ends_at=$2 WHERE listing_id=$1", [lazy.id, new Date(Date.now() - 1000).toISOString()]);
  lv = await live(b2, lazy.id);
  assert.equal(lv.body.status, "won");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND buyer_id=$2", [lazy.id, b2]))[0].n, 1);
  counter.checks++;
  // Admin sees the self-dealing signal (shared hashed IP in local runs) and can stop an auction
  const watch = await post(seller, { action: "create_listing", product: { ...base, title: `QA 의심 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: watch.id, amount: 5000 }, 201);
  const adminData = await get(admin);
  assert.ok(adminData.fraud.some((f) => f.listingId === watch.id), "shared-IP bidder flagged");
  assert.ok(adminData.duplicateBusiness.some((d) => d.businessNumber === bizNo(seller)), "shared business number flagged");
  assert.deepEqual((await get(b1)).fraud, []);
  await post(b1, { action: "admin_cancel_auction", productId: watch.id, reason: "QA" }, 403);
  await post(admin, { action: "admin_cancel_auction", productId: watch.id, reason: "QA 자전거래 의심" });
  assert.equal((await query("SELECT status FROM auctions WHERE listing_id=$1", [watch.id]))[0].status, "cancelled");
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [watch.id]))[0].status, "archived");
  assert.equal((await notesOf(b1, "auction_cancelled")).length, 1);
  counter.checks++;
  // Below reserve at expiry → seller decides; accepting sells at the top bid at once (the bid is the buyer's commitment)
  const low = await post(seller2, { action: "create_listing", product: { ...base, image: image2, title: `QA 미달 수락 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: low.id, amount: 6000 }, 201);
  await post(b2, { action: "bid", productId: low.id, amount: 6500 }, 201);
  let result = await processAuctions(query, later(8), batch, scope);
  assert.ok(result.deciding >= 1);
  let a = (await query("SELECT status, decision_stage FROM auctions WHERE listing_id=$1", [low.id]))[0];
  assert.deepEqual([a.status, a.decision_stage], ["deciding", "seller"]);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [low.id]))[0].status, "pending");
  assert.ok(!(await get()).products.some((p) => p.id === low.id), "pending listing is hidden from the market");
  assert.equal((await notesOf(seller2, "below_reserve_decision")).length, 1);
  assert.equal((await notesOf(b2, "auction_pending")).length, 1);
  const pendingView = (await get(b2)).bidListings.find((p) => p.id === low.id);
  assert.equal(pendingView.auction.status, "deciding"); assert.ok(!leaks(pendingView));
  // A losing bidder cannot tell this apart from a normal win
  const loserView = (await get(b1)).bidListings.find((p) => p.id === low.id);
  assert.deepEqual([loserView.status, loserView.auction.status, loserView.auction.soldQuantity], ["sold", "won", loserView.auction.quantity]);
  assert.equal((await live(b1, low.id)).body.status, "won");
  assert.equal((await live(b2, low.id)).body.status, "deciding");
  assert.equal((await live(null, low.id)).body.status, "won");
  assert.equal((await live(seller2, low.id)).body.status, "deciding");
  const lostNote = (await notesOf(b1, "auction_lost")).find((n) => n.refId === low.id);
  assert.equal(lostNote.body, "경매가 종료되었습니다. 다른 구매자가 최고가로 입찰했습니다.");
  await post(b2, { action: "decide_below_reserve", productId: low.id, accept: true }, 409);
  const decided = await post(seller2, { action: "decide_below_reserve", productId: low.id, accept: true });
  const sale = (await query("SELECT * FROM orders WHERE id=$1", [decided.orderId]))[0];
  assert.deepEqual([sale.status, sale.offer_kind, sale.buyer_id, sale.amount, sale.unit_price], ["awaiting_payment", null, b2, 65000, 6500]);
  const hours = (Date.parse(sale.payment_due_at) - Date.parse(sale.created_at)) / 3600000;
  assert.equal(Math.round(hours), 24, "24-hour payment deadline");
  assert.ok((await notesOf(b2, "auction_won")).some((n) => n.refId === sale.id && n.body.includes("24시간")), "buyer is told to pay, not asked again");
  assert.equal((await notesOf(b2, "below_reserve_offer")).length, 0);
  assert.ok((await notesOf(seller2, "auction_sold")).some((n) => n.refId === sale.id));
  assert.equal((await notesOf(b1, "auction_lost")).filter((n) => n.refId === low.id).length, 1, "losers are not notified twice");
  const lowRow = (await query("SELECT a.status, a.close_reason, l.status AS listing FROM auctions a JOIN listings l ON l.id=a.listing_id WHERE a.listing_id=$1", [low.id]))[0];
  assert.deepEqual([lowRow.status, lowRow.close_reason, lowRow.listing], ["won", "seller_accepted_below_reserve", "sold"]);
  await post(seller2, { action: "decide_below_reserve", productId: low.id, accept: true }, 409); // only once
  counter.checks++;
  // The buyer does not pay within 24h → cancelled, seller told, no penalty (PENALIZE_NONPAYMENT=false), no runner-up offer
  result = await processAuctions(query, later(2), batch, scope);
  assert.ok(result.expiredOrders >= 1);
  const unpaid = (await query("SELECT status, cancel_reason FROM orders WHERE id=$1", [sale.id]))[0];
  assert.deepEqual([unpaid.status, unpaid.cancel_reason], ["cancelled", "payment_overdue"]);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [low.id]))[0].n, 0, "no runner-up offer");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM disputes WHERE order_id=$1", [sale.id]))[0].n, 0, "no automatic penalty");
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [low.id]))[0].status, "unsold");
  const overdueNote = (await notesOf(seller2, "order_cancelled")).find((n) => n.refId === sale.id);
  assert.ok(overdueNote && overdueNote.body.includes("다시 경매"), overdueNote?.body);
  assert.ok((await notesOf(b2, "order_cancelled")).some((n) => n.refId === sale.id));
  counter.checks++;
  // Seller declines, and seller never answers → both 유찰
  const low3 = await post(seller2, { action: "create_listing", product: { ...base, image: image2, title: `QA 미달 판매 안함 ${run}` } }, 201);
  const low4 = await post(seller2, { action: "create_listing", product: { ...base, image: image2, title: `QA 미달 무응답 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: low3.id, amount: 6000 }, 201);
  await post(b1, { action: "bid", productId: low4.id, amount: 6000 }, 201);
  await processAuctions(query, later(8), batch, scope);
  await post(seller2, { action: "decide_below_reserve", productId: low3.id, accept: false });
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [low3.id]))[0].status, "unsold");
  result = await processAuctions(query, later(10), batch, scope);
  assert.ok(result.decisionsExpired >= 1);
  assert.equal((await query("SELECT status, close_reason FROM auctions WHERE listing_id=$1", [low4.id]))[0].close_reason, "decision_expired");
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [low4.id]))[0].status, "unsold");
  assert.ok((await notesOf(b1, "auction_lost")).find((n) => n.refId === low4.id && n.body.includes("기한 내")), "expiry is not described as a refusal");
  await post(seller2, { action: "relist_auction", productId: low4.id, auctionDays: 3, price: 5000, reservePrice: 6000, instantPrice: 8000 }, 201);
  counter.checks++;
  // Literal policy from the design doc: skip the seller step and ask the buyer directly
  process.env.BELOW_RESERVE_POLICY = "buyer_only";
  const low5 = await post(seller2, { action: "create_listing", product: { ...base, image: image2, title: `QA 미달 구매자 확인 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: low5.id, amount: 6200 }, 201);
  await processAuctions(query, later(8), batch, scope);
  const direct = (await query("SELECT id, status, offer_kind, buyer_id FROM orders WHERE listing_id=$1", [low5.id]))[0];
  assert.deepEqual([direct.status, direct.offer_kind, direct.buyer_id], ["offered", "below_reserve", b1]);
  delete process.env.BELOW_RESERVE_POLICY;
  // Buyer says no → 유찰, seller told once
  await post(b1, { action: "decline_offer", orderId: direct.id });
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [low5.id]))[0].status, "unsold");
  assert.equal((await notesOf(seller2, "auction_unsold")).filter((n) => n.refId === low5.id).length, 1, "seller hears the buyer said no, once");
  counter.checks++;
  console.log(JSON.stringify({ result: "PASS", checks: counter.checks, coverage: [
    "instant price validation", "reserve never in buyer JSON (market, live, pending)", "admin sees reserve", "live ETag 304",
    "same business number blocked", "bidder count", "instant price raise/lower rules", "stale buy-now refused",
    "instant win clamped to instant price", "concurrent buy-now", "bid vs instant cut race", "below-reserve seller accept → sale at once",
    "24h payment deadline", "unpaid → cancelled, seller told, no penalty, no runner-up", "buyer_only decline → unsold", "seller declines", "decision deadline", "buyer_only policy", "lazy close from live feed",
    "fraud signals", "admin cancel auction",
  ] }, null, 2));
} finally {
  await cleanup(users, [qaDistrict]);
}
