import { processAuctions } from "../lib/auction-core.ts";
import { assert, admin, batch, bizNo, cleanup, counter, district, get, notesOf, post, query, run, setupUsers, uploadImage } from "./qa-lib.mjs";
// Escrow evidence and disputes: shipment photos, automatic receipt, dispute hold,
// refunds, 10% penalties and the penalty gate. Requires ADMIN_USER_IDS=qa-admin-static
// and PLATFORM_FEE_RATES='{"생활·주방":0.04}' on the server.
const seller = `qa-dseller-${run}`, b1 = `qa-db1-${run}`, b2 = `qa-db2-${run}`, b3 = `qa-db3-${run}`, stranger = `qa-dx-${run}`, b3twin = `qa-db3t-${run}`;
const users = [seller, b1, b2, b3, stranger, b3twin, admin];
const qaDistrict = district("분쟁");
const later = (days) => new Date(Date.now() + days * 86400000);
// Time-injected runs touch one listing at a time, never real data.
const tick = (listingId, days) => processAuctions(query, later(days), batch, { listingIds: [listingId] });
const orderRow = async (id) => (await query("SELECT * FROM orders WHERE id=$1", [id]))[0];
const AMOUNT = 100000, PENALTY = 10000; // instant 10,000원 × 10박스, 10%
try {
  await setupUsers({ [seller]: "QA 분쟁 공급자", [b1]: "QA 분쟁 구매자1", [b2]: "QA 분쟁 구매자2", [b3]: "QA 분쟁 구매자3", [stranger]: "QA 제3자", [b3twin]: "QA 구매자3 두번째 계정", [admin]: "QA 운영자" }, qaDistrict,
    { [stranger]: { businessNumber: bizNo(b3) } });
  const image = await uploadImage(seller), buyerPhoto = await uploadImage(b2), b1Photo = await uploadImage(b1);
  const base = {
    category: "생활·주방", price: 5000, originalPrice: 20000, stock: 10, moq: 1, unit: "박스", region: "서울",
    condition: "새상품", image, description: "분쟁 검증용 상품입니다.", saleType: "auction", auctionDays: 7, reservePrice: 6000, instantPrice: 10000,
  };
  // A won lot via buy-now; optionally a runner-up bid first so succession has someone to offer to.
  async function lot(name, buyer, runnerUp) {
    const { id } = await post(seller, { action: "create_listing", product: { ...base, title: `QA 분쟁 ${name} ${run}` } }, 201);
    if (runnerUp) await post(runnerUp, { action: "bid", productId: id, amount: 6000 }, 201);
    const won = await post(buyer, { action: "bid", productId: id, buyNow: true, amount: 10000 }, 201);
    return { id, orderId: won.orderId };
  }
  async function pay(buyer, orderId) {
    await post(buyer, { action: "report_payment", orderId, depositor: "QA 구매자" });
    await post(admin, { action: "confirm_payment", orderId });
  }

  // 1) Shipment needs the seller's own photos; silence for 7 days completes the deal
  const one = await lot("자동확정", b1);
  assert.equal((await orderRow(one.orderId)).amount, AMOUNT);
  await pay(b1, one.orderId);
  await post(seller, { action: "mark_shipped", orderId: one.orderId }, 400);
  await post(seller, { action: "mark_shipped", orderId: one.orderId, photos: [] }, 400);
  await post(seller, { action: "mark_shipped", orderId: one.orderId, photos: [b1Photo] }, 400); // someone else's upload
  await post(seller, { action: "mark_shipped", orderId: one.orderId, photos: Array(6).fill(image) }, 400);
  await post(b1, { action: "mark_shipped", orderId: one.orderId, photos: [b1Photo] }, 404);
  await post(seller, { action: "mark_shipped", orderId: one.orderId, photos: [image] });
  let o = await orderRow(one.orderId);
  assert.equal(o.status, "shipped"); assert.deepEqual(JSON.parse(o.ship_photos), [image]);
  const autoDays = (Date.parse(o.auto_complete_at) - Date.parse(o.shipped_at)) / 86400000;
  assert.equal(Math.round(autoDays), 7);
  assert.deepEqual((await get(b1)).orders.find((x) => x.id === one.orderId).shipPhotos, [image]);
  assert.ok((await notesOf(b1, "shipped"))[0].body.includes("7일"));
  let r = await tick(one.id, 6);
  assert.equal((await orderRow(one.orderId)).status, "shipped", "not before 7 days");
  r = await tick(one.id, 7.5);
  assert.equal(r.autoCompleted, 1);
  o = await orderRow(one.orderId);
  assert.equal(o.status, "completed"); assert.ok(o.completed_at);
  assert.ok((await notesOf(b1, "completed")).some((n) => n.title.startsWith("자동 수령 확인")));
  counter.checks++;

  // 2) Misrepresentation on a shipped order: dispute holds auto-completion; admin grants a partial refund
  const two = await lot("부분환불", b2);
  await pay(b2, two.orderId);
  await post(seller, { action: "mark_shipped", orderId: two.orderId, photos: [image] });
  await post(stranger, { action: "open_dispute", orderId: two.orderId, kind: "misrepresentation", description: "남의 주문 신고 시도" }, 404);
  await post(b2, { action: "open_dispute", orderId: two.orderId, kind: "misrepresentation", description: "짧음" }, 400);
  await post(b2, { action: "open_dispute", orderId: two.orderId, kind: "misrepresentation", description: "수량이 사진과 다릅니다", photos: [image] }, 400); // not b2's upload
  await post(b2, { action: "open_dispute", orderId: two.orderId, kind: "buyer_cancel", description: "출고 후 단순 변심 취소" }, 400); // too late for a change of mind
  await post(seller, { action: "open_dispute", orderId: two.orderId, kind: "misrepresentation", description: "판매자는 이 유형 불가" }, 400);
  const d2 = await post(b2, { action: "open_dispute", orderId: two.orderId, kind: "misrepresentation", description: "10박스 중 3박스가 파손되어 있습니다", photos: [buyerPhoto] }, 201);
  await post(b2, { action: "open_dispute", orderId: two.orderId, kind: "other", description: "두 번째 신고는 막혀야 함" }, 409);
  assert.equal((await notesOf(seller, "dispute_opened")).length, 1);
  assert.ok((await notesOf(admin, "admin_dispute")).some((n) => n.refId === two.orderId));
  await post(b2, { action: "confirm_received", orderId: two.orderId }, 404); // held
  r = await tick(two.id, 9);
  assert.equal(r.autoCompleted, 0);
  assert.equal((await orderRow(two.orderId)).status, "shipped", "open dispute pauses auto-completion");
  await post(b2, { action: "respond_dispute", disputeId: d2.id, text: "신고자는 소명 불가" }, 404);
  await post(stranger, { action: "respond_dispute", disputeId: d2.id, text: "제3자 소명 불가" }, 404);
  await post(seller, { action: "respond_dispute", disputeId: d2.id, text: "출고 사진에는 정상입니다. 운송 중 파손으로 보입니다.", photos: [image] });
  const sellerView = (await get(seller)).disputes.find((d) => d.id === d2.id);
  assert.equal(sellerView.mine, false); assert.equal(sellerView.response.includes("운송"), true); assert.deepEqual(sellerView.photos, [buyerPhoto]);
  assert.equal((await get(b2)).disputes.find((d) => d.id === d2.id).mine, true);
  assert.ok(!(await get(stranger)).disputes.some((d) => d.id === d2.id));
  const adminView = (await get(admin)).disputes.find((d) => d.id === d2.id);
  assert.equal(adminView.amount, AMOUNT); assert.deepEqual(adminView.shipPhotos, [image]);
  await post(b2, { action: "resolve_dispute", disputeId: d2.id, resolution: "partial_refund", refundAmount: 30000 }, 403);
  await post(admin, { action: "resolve_dispute", disputeId: d2.id, resolution: "partial_refund", refundAmount: AMOUNT }, 400);
  await post(admin, { action: "resolve_dispute", disputeId: d2.id, resolution: "partial_refund" }, 400);
  const partial = await post(admin, { action: "resolve_dispute", disputeId: d2.id, resolution: "partial_refund", refundAmount: 30000, note: "파손 3박스분 환불" });
  assert.deepEqual([partial.refund, partial.penalty], [30000, 0]);
  await post(admin, { action: "resolve_dispute", disputeId: d2.id, resolution: "release" }, 404); // already resolved
  o = await orderRow(two.orderId);
  assert.equal(o.status, "shipped"); assert.equal(o.refund_amount, 30000);
  assert.equal(o.fee, Math.round((70000 * o.fee_rate) / 10000)); assert.equal(o.net, 70000 - o.fee);
  assert.equal(o.fee_rate, 400, "category fee override still applies");
  assert.ok(Date.parse(o.auto_complete_at) > Date.now() + 6 * 86400000, "auto-completion restarts after the ruling");
  assert.equal((await notesOf(b2, "dispute_resolved")).length, 1);
  let revenue = (await get(admin)).revenue;
  assert.ok(revenue.extras.refundsPending >= 30000);
  await post(b2, { action: "mark_refunded", orderId: two.orderId, amount: 30000 }, 403);
  await post(admin, { action: "mark_refunded", orderId: two.orderId, amount: 25000 }, 409); // not what is owed
  await post(admin, { action: "mark_refunded", orderId: two.orderId, amount: 30000 });
  await post(admin, { action: "mark_refunded", orderId: two.orderId, amount: 30000 }, 404);
  assert.ok((await orderRow(two.orderId)).refunded_at);
  assert.equal((await notesOf(b2, "refunded")).length, 1);
  await post(b2, { action: "confirm_received", orderId: two.orderId });
  assert.equal((await orderRow(two.orderId)).status, "completed");
  counter.checks++;

  // 2b) A second ruling on the same order adds to the refund instead of overwriting it
  const twoB = await lot("누적환불", b2);
  await pay(b2, twoB.orderId);
  await post(seller, { action: "mark_shipped", orderId: twoB.orderId, photos: [image] });
  const d2b = await post(b2, { action: "open_dispute", orderId: twoB.orderId, kind: "misrepresentation", description: "일부 박스가 다른 제품입니다" }, 201);
  await post(admin, { action: "resolve_dispute", disputeId: d2b.id, resolution: "partial_refund", refundAmount: 20000 });
  await post(admin, { action: "mark_refunded", orderId: twoB.orderId, amount: 20000 });
  let o2b = await orderRow(twoB.orderId);
  assert.deepEqual([o2b.refund_amount, o2b.refund_paid], [20000, 20000]);
  const d2c = await post(b2, { action: "open_dispute", orderId: twoB.orderId, kind: "misrepresentation", description: "나머지도 확인해 보니 전부 다른 제품입니다" }, 201);
  await post(admin, { action: "resolve_dispute", disputeId: d2c.id, resolution: "partial_refund", refundAmount: 80000 }, 400); // would reach the full amount
  const second = await post(admin, { action: "resolve_dispute", disputeId: d2c.id, resolution: "cancel_refund" });
  assert.equal(second.refund, 80000, "only the remainder is added");
  o2b = await orderRow(twoB.orderId);
  assert.deepEqual([o2b.status, o2b.refund_amount, o2b.refund_paid, o2b.refunded_at], ["cancelled", AMOUNT, 20000, null]);
  assert.ok((await get(admin)).revenue.extras.refundsPending >= 80000);
  await post(admin, { action: "mark_refunded", orderId: twoB.orderId, amount: 20000 }, 409); // a stale screen cannot close the new balance
  await post(admin, { action: "mark_refunded", orderId: twoB.orderId, amount: 80000 });
  assert.deepEqual((await orderRow(twoB.orderId)).refund_paid, AMOUNT);
  assert.ok((await notesOf(b2, "refunded")).some((n) => n.body.startsWith("80,000원")), "the second payout names only what was sent");
  counter.checks++;

  // 2c) A buyer penalty cannot be "taken from the refund" when earlier refunds left less than the penalty
  const twoC = await lot("환불후취소", b2);
  await pay(b2, twoC.orderId);
  const d2d = await post(b2, { action: "open_dispute", orderId: twoC.orderId, kind: "other", description: "일부 수량이 부족하다고 들었습니다" }, 201);
  await post(admin, { action: "resolve_dispute", disputeId: d2d.id, resolution: "partial_refund", refundAmount: 95000 });
  const d2e = await post(b2, { action: "open_dispute", orderId: twoC.orderId, kind: "buyer_cancel", description: "남은 수량도 필요 없어 취소합니다" }, 201);
  await post(admin, { action: "resolve_dispute", disputeId: d2e.id, resolution: "cancel_refund", penaltyParty: "buyer" }, 400);
  const plain = await post(admin, { action: "resolve_dispute", disputeId: d2e.id, resolution: "cancel_refund" });
  assert.equal(plain.refund, 5000);
  assert.equal((await orderRow(twoC.orderId)).refund_amount, AMOUNT);
  counter.checks++;

  // 3) Change of mind before paying: dispute pauses the payment deadline; buyer pays 10%; no runner-up offer (AUCTION_SUCCESSION off)
  const three = await lot("미입금취소", b3, b1);
  await post(b3, { action: "open_dispute", orderId: three.orderId, kind: "misrepresentation", description: "입금 전에는 허위매물 신고 불가" }, 400);
  const d3 = await post(b3, { action: "open_dispute", orderId: three.orderId, kind: "buyer_cancel", description: "사정이 생겨 구매를 취소하고 싶습니다" }, 201);
  r = await tick(three.id, 3);
  assert.equal(r.expiredOrders, 0);
  assert.equal((await orderRow(three.orderId)).status, "awaiting_payment", "open dispute pauses the payment deadline");
  await post(admin, { action: "cancel_order", orderId: three.orderId, reason: "분쟁 우회 시도" }, 409); // must go through the dispute
  const cancel3 = await post(admin, { action: "resolve_dispute", disputeId: d3.id, resolution: "cancel_refund", penaltyParty: "buyer" });
  assert.deepEqual([cancel3.refund, cancel3.penalty], [0, PENALTY]);
  o = await orderRow(three.orderId);
  assert.deepEqual([o.status, o.cancel_reason, o.refund_amount], ["cancelled", "dispute", 0]);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [three.id]))[0].n, 0, "runner-up offers are switched off");
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [three.id]))[0].status, "unsold", "the seller can relist");
  const d3row = (await query("SELECT * FROM disputes WHERE id=$1", [d3.id]))[0];
  assert.deepEqual([d3row.penalty_user_id, d3row.penalty_amount, d3row.penalty_status], [b3, PENALTY, "due"]);
  let b3Data = await get(b3);
  assert.equal(b3Data.penalty.due, PENALTY);
  assert.equal((await get(seller)).disputes.find((d) => d.id === d3.id).penaltyAmount, 0, "the other side never sees the penalty");
  assert.equal((await notesOf(b3, "penalty_due")).length, 1);
  // Penalty gate: no bidding or listing until paid
  const gateLot = await post(seller, { action: "create_listing", product: { ...base, title: `QA 분쟁 게이트 ${run}` } }, 201);
  await post(b3, { action: "bid", productId: gateLot.id, amount: 5000 }, 403);
  // Held the same number before the penalty existed: not blocked by someone else's default
  await post(stranger, { action: "bid", productId: gateLot.id, amount: 5000 }, 201);
  assert.equal((await get(stranger)).penalty.due, 0);
  // Took the number after the penalty (a debtor's fresh login): blocked, and told why
  await post(b3twin, { action: "profile", profile: { company: "QA 구매자3 두번째 계정", businessNumber: bizNo(b3), phone: "01000000000", businessAddress: `서울특별시 ${qaDistrict} 검증로 1` } });
  await post(b3twin, { action: "bid", productId: gateLot.id, amount: 5100 }, 403);
  const twinData = await get(b3twin);
  assert.deepEqual([twinData.penalty.due, twinData.penalty.items.length, twinData.penalty.viaBusiness], [PENALTY, 0, true]);
  await post(b3, { action: "create_listing", product: { ...base, image: undefined, title: "막힘" } }, 403);
  await post(b3, { action: "settle_penalty", disputeId: d3.id, status: "paid" }, 403);
  await post(admin, { action: "settle_penalty", disputeId: d3.id, status: "paid" });
  await post(admin, { action: "settle_penalty", disputeId: d3.id, status: "waived" }, 404);
  assert.equal((await notesOf(b3, "penalty_settled")).length, 1);
  await post(b3, { action: "bid", productId: gateLot.id, amount: 5100 }, 201);
  assert.equal((await get(b3)).penalty.due, 0);
  counter.checks++;

  // 4) Change of mind after paying: penalty is taken out of the refund
  const four = await lot("입금후취소", b1);
  await pay(b1, four.orderId);
  const d4 = await post(b1, { action: "open_dispute", orderId: four.orderId, kind: "buyer_cancel", description: "입금했지만 취소가 필요합니다" }, 201);
  const cancel4 = await post(admin, { action: "resolve_dispute", disputeId: d4.id, resolution: "cancel_refund", penaltyParty: "buyer" });
  assert.deepEqual([cancel4.refund, cancel4.penalty], [AMOUNT - PENALTY, PENALTY]);
  o = await orderRow(four.orderId);
  assert.deepEqual([o.status, o.refund_amount, o.refunded_at], ["cancelled", AMOUNT - PENALTY, null]);
  const d4row = (await query("SELECT penalty_status, penalty_settled_at FROM disputes WHERE id=$1", [d4.id]))[0];
  assert.equal(d4row.penalty_status, "paid"); assert.ok(d4row.penalty_settled_at);
  assert.equal((await get(b1)).penalty.due, 0, "deducted penalty does not block");
  // The seller learns the deal was cancelled, not how much of the refund the buyer forfeited
  assert.equal((await get(seller)).orders.find((x) => x.id === four.orderId).refundAmount, 0);
  assert.equal((await get(b1)).orders.find((x) => x.id === four.orderId).refundAmount, AMOUNT - PENALTY);
  assert.equal((await get(seller)).disputes.find((d) => d.id === d4.id).refundAmount, 0);
  const sellerNote = (await notesOf(seller, "dispute_resolved")).find((n) => n.refId === four.orderId);
  assert.ok(sellerNote && !sellerNote.body.includes("환불"), sellerNote?.body);
  revenue = (await get(admin)).revenue;
  assert.ok(revenue.extras.penaltiesCollected >= 2 * PENALTY);
  assert.ok(revenue.extras.refundsPending >= AMOUNT - PENALTY);
  await post(admin, { action: "mark_refunded", orderId: four.orderId, amount: AMOUNT - PENALTY });
  counter.checks++;

  // 5) Seller at fault: full refund, no succession, seller pays 10% and is blocked until settled
  const five = await lot("허위매물", b2, b3);
  await pay(b2, five.orderId);
  await post(b2, { action: "open_dispute", orderId: five.orderId, kind: "not_shipped", description: "입금 후 출고가 되지 않고 있습니다" }, 201);
  const d5 = (await query("SELECT id FROM disputes WHERE order_id=$1 AND status='open'", [five.orderId]))[0];
  const cancel5 = await post(admin, { action: "resolve_dispute", disputeId: d5.id, resolution: "cancel_refund", penaltyParty: "seller", note: "출고 불이행" });
  assert.deepEqual([cancel5.refund, cancel5.penalty], [AMOUNT, PENALTY]);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [five.id]))[0].n, 0, "seller fault never passes the lot on");
  assert.equal((await get(seller)).penalty.due, PENALTY);
  assert.equal((await get(b2)).disputes.find((d) => d.id === d5.id).penaltyStatus, "none");
  await post(seller, { action: "create_listing", product: { ...base, title: `QA 분쟁 막힘 ${run}` } }, 403);
  await post(admin, { action: "settle_penalty", disputeId: d5.id, status: "waived" });
  counter.checks++;

  // 6) Seller-opened "other" dispute released: the deal continues and the timers restart
  const six = await lot("계속진행", b3);
  await post(seller, { action: "open_dispute", orderId: six.orderId, kind: "not_shipped", description: "판매자는 출고지연 신고 불가" }, 400);
  const d6 = await post(seller, { action: "open_dispute", orderId: six.orderId, kind: "other", description: "구매자와 연락 일정 조율이 필요합니다" }, 201);
  assert.equal((await notesOf(b3, "dispute_opened")).length, 1);
  await post(b3, { action: "respond_dispute", disputeId: d6.id, text: "내일 입금하겠습니다" });
  await post(admin, { action: "resolve_dispute", disputeId: d6.id, resolution: "release" });
  o = await orderRow(six.orderId);
  assert.equal(o.status, "awaiting_payment");
  assert.ok(Date.parse(o.payment_due_at) > Date.now() + 23 * 3600000, "payment deadline is at least a day away after release");
  await post(b3, { action: "report_payment", orderId: six.orderId, depositor: "QA 구매자" });
  counter.checks++;

  // 7) Automatic non-payment penalty is visible only to the buyer who owes it
  // (an open "buy at your bid?" offer for b1 first, to check the penalty also blocks accepting it)
  process.env.BELOW_RESERVE_POLICY = "buyer_only";
  const offerLot = await post(seller, { action: "create_listing", product: { ...base, title: `QA 분쟁 구매의사 ${run}` } }, 201);
  await post(b1, { action: "bid", productId: offerLot.id, amount: 5500 }, 201);
  await tick(offerLot.id, 8);
  delete process.env.BELOW_RESERVE_POLICY;
  const openOffer = (await query("SELECT id FROM orders WHERE listing_id=$1 AND status='offered' AND buyer_id=$2", [offerLot.id, b1]))[0];
  assert.ok(openOffer);
  const seven = await lot("미입금", b1);
  r = await tick(seven.id, 3);
  assert.equal(r.expiredOrders, 1);
  const nopay = (await query("SELECT * FROM disputes WHERE order_id=$1", [seven.orderId]))[0];
  assert.deepEqual([nopay.kind, nopay.penalty_user_id, nopay.penalty_amount, nopay.penalty_status], ["no_payment", b1, PENALTY, "due"]);
  assert.ok((await get(b1)).disputes.some((d) => d.id === nopay.id));
  assert.ok(!(await get(seller)).disputes.some((d) => d.id === nopay.id), "seller does not see the buyer's penalty");
  assert.ok((await get(admin)).disputes.some((d) => d.id === nopay.id));
  await post(b1, { action: "bid", productId: gateLot.id, amount: 6000 }, 403);
  await post(b1, { action: "accept_offer", orderId: openOffer.id }, 403); // no new orders while a penalty is due
  await post(admin, { action: "settle_penalty", disputeId: nopay.id, status: "waived" });
  await post(b1, { action: "bid", productId: gateLot.id, amount: 6000 }, 201);
  counter.checks++;

  // 8) Partial lot, both winners default one after the other (no runner-up offers): a relist after
  // part was already relisted covers only what is still unsold, and nothing can be relisted twice
  process.env.PENALIZE_NONPAYMENT = "false";
  const partialBase = { ...base };
  delete partialBase.instantPrice; // partial auctions have no instant price
  const part = await post(seller, { action: "create_listing", product: { ...partialBase, title: `QA 분쟁 부분 재등록 ${run}`, stock: 20, auctionMode: "partial", minLot: 10 } }, 201);
  await post(b2, { action: "bid", productId: part.id, unitPrice: 6500, quantity: 10 }, 201);
  await post(b3, { action: "bid", productId: part.id, unitPrice: 6000, quantity: 10 }, 201);
  await tick(part.id, 8);
  const partOrders = await query("SELECT id, buyer_id FROM orders WHERE listing_id=$1 AND status='awaiting_payment'", [part.id]);
  assert.equal(partOrders.length, 2);
  const byBuyer = Object.fromEntries(partOrders.map((x) => [x.buyer_id, x.id]));
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [byBuyer[b2], new Date(Date.now() - 1000).toISOString()]);
  await tick(part.id, 0);
  assert.equal((await orderRow(byBuyer[b2])).status, "cancelled");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM orders WHERE listing_id=$1 AND status='offered'", [part.id]))[0].n, 0);
  await post(seller, { action: "relist_remainder", productId: part.id, auctionDays: 3, price: 5000, reservePrice: 6000, auctionMode: "partial", minLot: 10, expected: 10 }, 201);
  await query("UPDATE orders SET payment_due_at=$2 WHERE id=$1", [byBuyer[b3], new Date(Date.now() - 1000).toISOString()]);
  await tick(part.id, 0);
  const partAuction = (await query("SELECT status, unsold_quantity, relisted_quantity FROM auctions WHERE listing_id=$1", [part.id]))[0];
  assert.deepEqual([partAuction.status, partAuction.unsold_quantity, partAuction.relisted_quantity], ["unsold", 10, 10]);
  assert.equal((await query("SELECT status FROM listings WHERE id=$1", [part.id]))[0].status, "unsold");
  const again = await post(seller, { action: "relist_auction", productId: part.id, auctionDays: 3, price: 5000, reservePrice: 6000, auctionMode: "whole" }, 201);
  assert.equal((await query("SELECT quantity FROM auctions WHERE listing_id=$1", [again.id]))[0].quantity, 10, "only the still-unsold 10 are relisted");
  assert.equal(JSON.parse((await query("SELECT document FROM listings WHERE id=$1", [again.id]))[0].document).stock, 10);
  await post(seller, { action: "relist_remainder", productId: part.id, auctionDays: 3, price: 5000, reservePrice: 6000, auctionMode: "partial", minLot: 10, expected: 10 }, 404);
  await post(seller, { action: "relist_auction", productId: part.id, auctionDays: 3, price: 5000, reservePrice: 6000, auctionMode: "whole" }, 404);
  delete process.env.PENALIZE_NONPAYMENT;
  counter.checks++;

  console.log(JSON.stringify({ result: "PASS", checks: counter.checks, coverage: [
    "ship photos required and owned", "auto receipt after 7 days", "dispute hold on auto receipt", "who may open which dispute",
    "one open dispute per order", "counter-statement rules", "dispute visibility", "partial refund recomputes fee and net",
    "mark refunded", "unpaid change of mind: penalty due, deadline paused, no runner-up", "penalty gate and settlement",
    "paid change of mind: penalty deducted from refund", "seller fault: full refund, no succession, seller blocked",
    "release restarts timers", "automatic non-payment penalty visibility", "revenue extras", "cumulative refunds",
    "admin cancel blocked by open dispute", "penalty follows business number", "seller does not see buyer's forfeited refund",
    "penalised buyer cannot accept offers", "refund payout must match what is owed", "penalty larger than the kept amount refused",
    "earlier holder of a number is not blocked by a later default",
    "partial lot relist covers only unsold units, never twice",
  ] }, null, 2));
} finally {
  await cleanup(users, [qaDistrict]);
}
