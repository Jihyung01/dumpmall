// This suite covers allocation/succession; the non-payment penalty is covered by verify-disputes.mjs.
process.env.PENALIZE_NONPAYMENT = "false";
// Runner-up offers are off in production; this suite exercises them (start the server with AUCTION_SUCCESSION=on).
process.env.AUCTION_SUCCESSION = "on";
import { allocate, partialMinimumBid, feeFor, processAuctions, bidStep } from "../lib/auction-core.ts";
import { assert, admin, assertInvariant, batch, cleanup, counter, district, get, notesOf, post, postRaw, query, run, setupUsers, uploadImage } from "./qa-lib.mjs";
// Partial-quantity auctions: validation, allocation, replacement, concurrency,
// close, accept-now, relist. Requires ADMIN_USER_IDS=qa-admin-static.
const seller = `qa-pseller-${run}`, b1 = `qa-pb1-${run}`, b2 = `qa-pb2-${run}`, b3 = `qa-pb3-${run}`;
const scope = { ownerIds: [seller] }; // never touch real listings in the shared DB
const users = [seller, b1, b2, b3, admin];
const qaDistrict = district("부분");
const bid = (u, id, unitPrice, quantity, status = 201) => post(u, { action: "bid", productId: id, unitPrice, quantity }, status);
const later = (days) => new Date(Date.now() + days * 86400000);
try {
  // Pure allocation rules
  const t = (p, q, id, createdAt = "2026-01-01T00:00:00.000Z") => ({ id, bidderId: id, unitPrice: p, quantity: q, createdAt });
  let r = allocate([t(1200, 60, "A"), t(1100, 50, "B"), t(1000, 30, "C")], 100, 10, 0);
  assert.deepEqual(r.fills.map((f) => [f.bid.id, f.qty]), [["A", 60], ["B", 40]]);
  assert.equal(r.cutoff, 1100); assert.equal(r.remaining, 0);
  r = allocate([t(1200, 60, "A"), t(1100, 50, "B"), t(1000, 30, "C")], 100, 10, 1150);
  assert.deepEqual(r.fills.map((f) => f.bid.id), ["A"]); assert.equal(r.remaining, 40); assert.equal(r.cutoff, null);
  assert.equal(allocate([t(1200, 60, "A")], 100, 10, 1300).fills.length, 0);
  const tie1 = allocate([t(1000, 70, "A", "2026-01-01T00:00:01.000Z"), t(1000, 70, "B", "2026-01-01T00:00:02.000Z")], 100, 10, 0);
  const tie2 = allocate([t(1000, 70, "B", "2026-01-01T00:00:02.000Z"), t(1000, 70, "A", "2026-01-01T00:00:01.000Z")], 100, 10, 0);
  assert.deepEqual(tie1.fills.map((f) => [f.bid.id, f.qty]), [["A", 70], ["B", 30]]);
  assert.deepEqual(tie2.fills.map((f) => [f.bid.id, f.qty]), tie1.fills.map((f) => [f.bid.id, f.qty]));
  r = allocate([t(1200, 90, "A"), t(1100, 60, "B")], 120, 30, 0);
  assert.deepEqual(r.fills.map((f) => [f.bid.id, f.qty]), [["A", 90], ["B", 30]]);
  assert.equal(partialMinimumBid({ start_price: 800 }, [t(1200, 300, "A")], 500, 100), 800);
  assert.equal(partialMinimumBid({ start_price: 800 }, [t(1200, 300, "A"), t(1100, 200, "B")], 500, 100), 1100 + bidStep(1100));
  assert.equal(feeFor(12345, 500), 617); assert.equal(feeFor(10, 500), 1);
  counter.checks++;
  await setupUsers({ [seller]: "QA 부분 공급자", [b1]: "QA 부분 구매자1", [b2]: "QA 부분 구매자2", [b3]: "QA 부분 구매자3", [admin]: "QA 운영자" }, qaDistrict);
  const image = await uploadImage(seller);
  const base = {
    title: `QA 부분 경매 ${run}`, category: "생활·주방", price: 1000, originalPrice: 5000, stock: 500, moq: 1, unit: "박스", region: "서울",
    condition: "새상품", image, description: "부분 수량 경매 검증용 상품입니다.", saleType: "auction", auctionDays: 7, reservePrice: 1100, auctionMode: "partial",
  };
  await post(seller, { action: "create_listing", product: { ...base, minLot: 0 } }, 400);
  await post(seller, { action: "create_listing", product: { ...base, minLot: 600 } }, 400);
  await post(seller, { action: "create_listing", product: { ...base, minLot: 60 } }, 400);
  await post(seller, { action: "create_listing", product: { ...base, price: 100000, originalPrice: 100000, reservePrice: 100000, stock: 30000, minLot: 100 } }, 400); // overflow
  const whole = await post(seller, { action: "create_listing", product: { ...base, title: `QA 전량으로 정규화 ${run}`, minLot: 500 } }, 201);
  assert.equal((await get()).products.find((p) => p.id === whole.id).auction.mode, "whole");
  const { id } = await post(seller, { action: "create_listing", product: { ...base, minLot: 100 } }, 201);
  const pub = (await get()).products.find((p) => p.id === id);
  assert.equal(pub.auction.mode, "partial"); assert.equal(pub.auction.minLot, 100); assert.equal(pub.moq, 100);
  assert.equal(pub.auction.reservePrice, undefined); assert.equal(pub.auction.minimumBid, 1000);
  counter.checks++;
  // Whole-lot auction rejects quantity
  await post(b1, { action: "bid", productId: whole.id, amount: 1000, quantity: 100 }, 400);
  // Partial validation
  await post(b1, { action: "bid", productId: id, unitPrice: 1000 }, 400);
  await bid(b1, id, 1000, 150, 400);
  await bid(b1, id, 1000, 50, 400);
  await bid(b1, id, 1000, 600, 400);
  await bid(b1, id, 900, 100, 400);
  await bid(seller, id, 1000, 100, 400);
  let res = await bid(b1, id, 1200, 300);
  assert.equal(res.allocated, 300); assert.equal(res.cutoff, null);
  assert.equal((await query("SELECT current_price FROM auctions WHERE listing_id=$1", [id]))[0].current_price, null);
  res = await bid(b2, id, 1100, 200);
  assert.equal(res.cutoff, 1100);
  let view = (await get(b2)).products.find((p) => p.id === id);
  assert.equal(view.auction.cutoffPrice, 1100); assert.equal(view.auction.filledQuantity, 500);
  assert.equal(view.auction.subscribedQuantity, 500); assert.equal(view.auction.myBid.state, "full");
  assert.equal(view.auction.sellableQuantity, undefined, "seller-only field hidden");
  assert.equal((await get(seller)).ownListings.find((p) => p.id === id).auction.sellableQuantity, 500);
  await bid(b3, id, 1100, 100, 400); // exactly the cutoff → below minimum
  assert.equal((await get(b3)).products.find((p) => p.id === id).auction.minimumBid, 1200);
  res = await bid(b3, id, 1200, 100);
  assert.equal(res.allocated, 100);
  assert.equal((await notesOf(b2, "outbid")).length, 1, "displaced bidder notified once");
  assert.equal((await notesOf(b1, "outbid")).length, 0, "unchanged bidder not notified");
  view = (await get(b2)).products.find((p) => p.id === id);
  assert.equal(view.auction.myBid.allocated, 100); assert.equal(view.auction.myBid.state, "partial");
  const bids = (await get(b2)).bids.filter((b) => b.listingId === id);
  assert.equal(bids.length, 3); assert.equal(bids.find((b) => b.mine).allocated, 100);
  counter.checks++;
  // Replacement rules
  await bid(b2, id, 1000, 200, 400);
  await bid(b2, id, 1100, 100, 400);
  await bid(b2, id, 1100, 200, 400);
  res = await bid(b2, id, 1100, 300);
  const rows = await query("SELECT status, quantity, replaced_by FROM bids WHERE listing_id=$1 AND bidder_id=$2 ORDER BY created_at", [id, b2]);
  assert.equal(rows.length, 2); assert.equal(rows[0].status, "replaced"); assert.equal(rows[1].status, "active"); assert.equal(rows[1].quantity, 300);
  assert.equal((await query("SELECT bid_count FROM auctions WHERE listing_id=$1", [id]))[0].bid_count, 4);
  await assert.rejects(query("INSERT INTO bids(id,listing_id,bidder_id,amount,quantity,status,created_at) VALUES($1,$2,$3,1100,100,'active',$4)", [crypto.randomUUID(), id, b2, new Date().toISOString()]),
    (e) => e.code === "23505");
  counter.checks++;
  // Concurrency: two bidders with the same read
  const pair = await Promise.all([postRaw(b1, { action: "bid", productId: id, unitPrice: 1300, quantity: 300 }), postRaw(b3, { action: "bid", productId: id, unitPrice: 1300, quantity: 100 })]);
  const statuses = pair.map((p) => p.status).sort();
  assert.ok(statuses.join() === "201,409" || statuses.join() === "201,201", `unexpected ${statuses}`);
  const active = await query("SELECT bidder_id, COUNT(*)::int AS n FROM bids WHERE listing_id=$1 AND status='active' AND quantity IS NOT NULL GROUP BY bidder_id", [id]);
  assert.ok(active.every((a) => a.n === 1));
  counter.checks++;
  // Anti-snipe and reserve_met once
  await query("UPDATE auctions SET ends_at=$2 WHERE listing_id=$1", [id, new Date(Date.now() + 3 * 60000).toISOString()]);
  if (statuses.join() === "201,409") {
    const loser = pair[0].status === 201 ? b3 : b1; // a replacement may never lower the standing quantity
    res = await bid(loser, id, 1400, loser === b1 ? 300 : 100);
  } else res = await bid(b2, id, 1400, 300);
  assert.equal(res.extended, true);
  assert.equal((await query("SELECT extended_count FROM auctions WHERE listing_id=$1", [id]))[0].extended_count, 1);
  assert.equal((await notesOf(seller, "reserve_met")).length, 1, "reserve met notified exactly once");
  await query("UPDATE auctions SET ends_at=$2 WHERE listing_id=$1", [id, new Date(Date.now() + 5 * 86400000).toISOString()]);
  counter.checks++;
  // Midpoint alert for a second auction whose reserve is above every bid
  const high = await post(seller, { action: "create_listing", product: { ...base, title: `QA 고가 ${run}`, reservePrice: 3000, minLot: 100 } }, 201);
  await bid(b1, high.id, 1000, 200);
  let result = await processAuctions(query, later(4), batch, scope);
  assert.ok(result.alerted >= 1); // the bid-less whole-lot listing above is alerted too
  const alert = (await notesOf(seller, "reserve_alert")).filter((n) => n.refId === high.id);
  assert.equal(alert.length, 1); assert.ok(alert[0].body.includes("신청 수량 200/500"));
  assert.equal((await processAuctions(query, later(4), batch, scope)).alerted, 0);
  // Late bid vs close: extension keeps the auction open
  await query("UPDATE auctions SET ends_at=$2 WHERE listing_id=$1", [high.id, new Date(Date.now() + 60000).toISOString()]);
  await bid(b2, high.id, 1000, 100);
  result = await processAuctions(query, new Date(Date.now() + 2 * 60000), batch, scope);
  assert.equal((await query("SELECT status FROM auctions WHERE listing_id=$1", [high.id]))[0].status, "active", "extended auction survives an early close");
  // All below reserve → unsold (only the extended "high" auction ends within 10 minutes)
  result = await processAuctions(query, new Date(Date.now() + 10 * 60000), batch, scope);
  assert.equal((await query("SELECT status, unsold_quantity FROM auctions WHERE listing_id=$1", [high.id]))[0].status, "unsold");
  assert.equal((await query("SELECT status, unsold_quantity FROM auctions WHERE listing_id=$1", [high.id]))[0].unsold_quantity, 500);
  assert.deepEqual([...new Set((await query("SELECT status FROM bids WHERE listing_id=$1 AND quantity IS NOT NULL", [high.id])).map((b) => b.status))], ["lost"]);
  assert.equal((await get(seller)).ownListings.find((p) => p.id === high.id).status, "unsold");
  counter.checks++;
  // Expiry close of the main auction, twice concurrently → one order set
  const auctionBefore = (await query("SELECT * FROM auctions WHERE listing_id=$1", [id]))[0];
  const standing = await query("SELECT id, bidder_id, amount, quantity, created_at FROM bids WHERE listing_id=$1 AND status='active' AND quantity IS NOT NULL", [id]);
  const expected = allocate(standing.map((b) => ({ id: b.id, bidderId: b.bidder_id, unitPrice: b.amount, quantity: b.quantity, createdAt: b.created_at })), 500, 100, auctionBefore.reserve_price);
  const same = later(8);
  const [c1, c2] = await Promise.all([processAuctions(query, same, batch, scope), processAuctions(query, same, batch, scope)]);
  assert.equal(c1.won + c2.won, 1, "exactly one closer wins");
  const orders = await query("SELECT * FROM orders WHERE listing_id=$1 ORDER BY unit_price DESC", [id]);
  assert.equal(orders.length, expected.fills.length);
  assert.equal(orders.reduce((s, o) => s + o.quantity, 0), expected.filled);
  for (const o of orders) {
    assert.equal(o.amount, o.quantity * o.unit_price);
    assert.equal(o.fee, feeFor(o.amount, o.fee_rate));
    assert.equal(o.net, o.amount - o.fee);
    assert.match(o.deposit_code, /^\d{4}$/);
    assert.ok(o.bid_id && o.bid_quantity && o.batch_token);
  }
  assert.equal(new Set(orders.map((o) => o.deposit_code)).size, orders.length);
  const closed = (await query("SELECT * FROM auctions WHERE listing_id=$1", [id]))[0];
  assert.equal(closed.status, "won"); assert.equal(closed.sold_quantity + closed.unsold_quantity, 500);
  assert.equal((await query("SELECT COUNT(DISTINCT close_token)::int AS n FROM auctions WHERE listing_id=$1", [id]))[0].n, 1);
  const bidStatuses = await query("SELECT status, allocated_quantity, order_id FROM bids WHERE listing_id=$1 AND quantity IS NOT NULL AND status<>'replaced'", [id]);
  assert.ok(bidStatuses.every((b) => ["won", "partial", "lost"].includes(b.status)));
  assert.equal((await get(seller)).ownListings.find((p) => p.id === id).status, "sold");
  assert.equal((await notesOf(seller, "auction_sold")).length, 1);
  for (const o of orders) assert.equal((await notesOf(o.buyer_id, o.quantity < o.bid_quantity ? "auction_partial_won" : "auction_won")).length, 1, "each winner notified once");
  await assertInvariant();
  // Deposit code visible to buyer, hidden from a stranger
  const buyerOrder = (await get(orders[0].buyer_id)).orders.find((o) => o.id === orders[0].id);
  assert.equal(buyerOrder.depositCode, orders[0].deposit_code);
  assert.ok(!JSON.stringify((await get(b3 === orders[0].buyer_id ? b2 : b3)).products).includes(orders[0].deposit_code));
  counter.checks++;
  // One overdue order among several: only that order is cancelled, listing stays sold
  if (orders.length >= 2) {
    await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [orders[1].id, new Date(Date.now() - 1000).toISOString()]);
    result = await processAuctions(query, new Date(), batch, scope);
    assert.equal(result.expiredOrders, 1);
    assert.equal((await query("SELECT status FROM orders WHERE id=$1", [orders[1].id]))[0].status, "cancelled");
    assert.equal((await query("SELECT status FROM orders WHERE id=$1", [orders[0].id]))[0].status, "awaiting_payment");
    assert.equal((await query("SELECT status FROM listings WHERE id=$1", [id]))[0].status, "sold");
    assert.ok((await query("SELECT succession_token FROM orders WHERE id=$1", [orders[1].id]))[0].succession_token, "succession claimed");
    await assertInvariant();
    counter.checks++;
  }
  // Accept-now with a floor on a fresh auction, preview equals the result
  const acc = await post(seller, { action: "create_listing", product: { ...base, title: `QA 즉시 낙찰 ${run}`, reservePrice: 2000, minLot: 100 } }, 201);
  await bid(b1, acc.id, 1500, 200);
  await bid(b2, acc.id, 1000, 300);
  await post(b1, { action: "preview_close", productId: acc.id, floor: 0 }, 404);
  const preview = await post(seller, { action: "preview_close", productId: acc.id, floor: 1200 });
  assert.equal(preview.fills.length, 1); assert.equal(preview.remaining, 300);
  await post(seller, { action: "accept_bid", productId: acc.id, floor: 1600 }, 400);
  const accepted = await post(seller, { action: "accept_bid", productId: acc.id, floor: 1200 });
  assert.equal(accepted.orderIds.length, 1);
  const accA = (await query("SELECT * FROM auctions WHERE listing_id=$1", [acc.id]))[0];
  assert.equal(accA.close_reason, "seller_accepted"); assert.equal(accA.unsold_quantity, 300);
  assert.equal((await query("SELECT status, lost_reason FROM bids WHERE listing_id=$1 AND bidder_id=$2", [acc.id, b2]))[0].lost_reason, "below_reserve"); // below the accept floor
  // Relist the remainder twice: one wins
  const relistBody = { action: "relist_remainder", productId: acc.id, auctionDays: 3, price: 800, reservePrice: 900, auctionMode: "partial", minLot: 100, expected: 300 };
  const pairR = await Promise.all([postRaw(seller, relistBody), postRaw(seller, relistBody)]);
  const rStatuses = pairR.map((p) => p.status).sort();
  assert.ok(rStatuses[0] === 201 && [404, 409].includes(rStatuses[1]), `remainder relist race: ${rStatuses}`); // loser fails the pre-read or the claim
  const newId = pairR.find((p) => p.status === 201).body.id;
  const relisted = (await get()).products.find((p) => p.id === newId);
  assert.equal(relisted.stock, 300); assert.equal(relisted.auction.mode, "partial");
  assert.equal((await query("SELECT unsold_quantity, relisted_to FROM auctions WHERE listing_id=$1", [acc.id]))[0].unsold_quantity, 0);
  // Relist an unsold listing twice: one wins
  const relistU = { action: "relist_auction", productId: high.id, auctionDays: 3, price: 800, reservePrice: 900 };
  const pairU = await Promise.all([postRaw(seller, relistU), postRaw(seller, relistU)]);
  const uStatuses = pairU.map((p) => p.status).sort();
  assert.ok(uStatuses[0] === 201 && [404, 409].includes(uStatuses[1]), `unsold relist race: ${uStatuses}`);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM listings WHERE relisted_to IS NOT NULL AND id=$1", [high.id]))[0].n, 1);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [high.id]))[0].status, "archived");
  await assertInvariant();
  counter.checks++;
  console.log(JSON.stringify({ result: "PASS", checks: counter.checks, coverage: [
    "allocation determinism", "partial listing validation", "min lot multiples", "partial bid validation", "cutoff and minimum bid",
    "displacement notifications", "bid replacement and unique active row", "concurrent bids", "anti-snipe", "reserve met once",
    "partial midpoint alert", "late bid beats early close", "unsold below reserve", "concurrent closers", "per-winner orders and fees",
    "deposit codes", "single-order overdue", "accept-now with floor and preview", "remainder relist race", "unsold relist race", "invariant",
  ] }, null, 2));
} finally {
  await cleanup(users, [qaDistrict]);
}
