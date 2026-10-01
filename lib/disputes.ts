// Disputes and penalties (framework-free, injected query/batch).
// A dispute holds an order: while it is open, the payment-deadline cancel and the
// automatic receipt confirmation are paused. Only an admin resolves it.
import {
  AUTO_CONFIRM_DAYS, PENALTY_BPS, adminIds, afterCancel, notify,
  type Batch, type CancelledOrder, type Query, type Statement,
} from "./auction-core";

export type DisputeKind = "buyer_cancel" | "misrepresentation" | "not_shipped" | "other" | "no_payment";
export type Resolution = "release" | "cancel_refund" | "partial_refund";
export const disputeKindLabels: Record<DisputeKind, string> = {
  buyer_cancel: "구매자 취소 요청(단순 변심)",
  misrepresentation: "허위매물·상품 불일치",
  not_shipped: "출고 지연",
  other: "기타",
  no_payment: "미입금",
};
const won = (n: number) => n.toLocaleString("ko-KR");
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
export function penaltyFor(amount: number) {
  return Math.round((amount * PENALTY_BPS) / 10000);
}
type OrderRow = {
  id: string; listing_id: string; seller_id: string; buyer_id: string; status: string; amount: number;
  product_title: string; fee_rate: number; paid_at: string | null; refund_amount: number;
};
const orderCols = "id, listing_id, seller_id, buyer_id, status, amount, product_title, fee_rate, paid_at, refund_amount";
// Which kinds each side may open, and in which order states.
const allowed: Record<"buyer" | "seller", Partial<Record<DisputeKind, string[]>>> = {
  buyer: {
    buyer_cancel: ["awaiting_payment", "payment_reported", "paid"],
    misrepresentation: ["paid", "shipped"],
    not_shipped: ["paid"],
    other: ["awaiting_payment", "payment_reported", "paid", "shipped"],
  },
  seller: {
    other: ["awaiting_payment", "payment_reported", "paid", "shipped"],
  },
};
export async function openDispute(
  query: Query, input: { orderId: string; userId: string; kind: DisputeKind; description: string; photos: string[] }, now: string,
): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  const o = (await query<OrderRow>(
    `SELECT ${orderCols} FROM orders WHERE id=$1 AND (buyer_id=$2 OR seller_id=$2)`,
    [input.orderId, input.userId],
  ))[0];
  if (!o) return { ok: false, status: 404, error: "내 주문이 아닙니다." };
  const role = o.buyer_id === input.userId ? "buyer" : "seller";
  const states = allowed[role][input.kind];
  if (!states) return { ok: false, status: 400, error: "이 유형의 신고는 할 수 없습니다." };
  if (!states.includes(o.status)) return { ok: false, status: 400, error: "현재 주문 단계에서는 이 신고를 할 수 없습니다." };
  const id = crypto.randomUUID();
  try {
    // Re-checks the order state in the same statement: a receipt confirmation that lands
    // first (completed) must not be followed by a dispute nobody can act on.
    const inserted = await query<{ id: string }>(
      `INSERT INTO disputes(id, order_id, listing_id, opened_by, opener_role, kind, description, photos, status, created_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,'open',$9 WHERE EXISTS (SELECT 1 FROM orders WHERE id=$2 AND status = ANY($10::text[]))
       RETURNING id`,
      [id, o.id, o.listing_id, input.userId, role, input.kind, input.description, JSON.stringify(input.photos), now, states],
    );
    if (!inserted.length) return { ok: false, status: 409, error: "주문 상태가 방금 바뀌었습니다. 새로고침 후 다시 확인해 주세요." };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return { ok: false, status: 409, error: "이미 처리 중인 신고가 있습니다." };
    throw error;
  }
  const other = role === "buyer" ? o.seller_id : o.buyer_id;
  await notify(query, [other], {
    kind: "dispute_opened", title: `거래 신고 접수 · ${o.product_title}`,
    body: `${role === "buyer" ? "구매자" : "공급자"}가 "${disputeKindLabels[input.kind]}" 신고를 접수했습니다. 운영자가 검토하는 동안 입금 기한과 자동 수령 확인이 멈춥니다. 주문 화면에서 소명과 사진을 남겨 주세요.`,
    refType: "order", refId: o.id,
  }, now);
  await notify(query, adminIds(), {
    kind: "admin_dispute", title: `분쟁 접수 · ${o.product_title}`,
    body: `${disputeKindLabels[input.kind]} · ${won(o.amount)}원. 관리 탭 분쟁·위약금에서 검토해 주세요.`,
    refType: "order", refId: o.id,
  }, now);
  return { ok: true, id };
}
export async function respondDispute(
  query: Query, input: { disputeId: string; userId: string; text: string; photos: string[] }, now: string,
) {
  const rows = await query<{ id: string; order_id: string; product_title: string }>(
    `UPDATE disputes d SET response=$3, response_photos=$4, responded_at=$5
     FROM orders o WHERE d.id=$1 AND d.status='open' AND o.id=d.order_id AND (o.buyer_id=$2 OR o.seller_id=$2) AND d.opened_by<>$2
     RETURNING d.id, d.order_id, o.product_title`,
    [input.disputeId, input.userId, input.text, JSON.stringify(input.photos), now],
  );
  if (!rows.length) return false;
  await notify(query, adminIds(), {
    kind: "admin_dispute", title: `분쟁 소명 도착 · ${rows[0].product_title}`,
    body: "상대방이 소명을 남겼습니다. 관리 탭에서 확인해 주세요.", refType: "order", refId: rows[0].order_id,
  }, now);
  return true;
}
export async function resolveDispute(
  query: Query, batch: Batch,
  input: { disputeId: string; adminId: string; resolution: Resolution; refundAmount?: number; penaltyParty?: "buyer" | "seller" | null; note?: string },
  now: string,
): Promise<{ ok: true; refund: number; penalty: number } | { ok: false; status: number; error: string }> {
  const d = (await query<{ id: string; order_id: string; kind: DisputeKind; status: string }>(
    "SELECT id, order_id, kind, status FROM disputes WHERE id=$1", [input.disputeId],
  ))[0];
  if (!d || d.status !== "open") return { ok: false, status: 404, error: "처리할 분쟁이 아닙니다." };
  const o = (await query<OrderRow>(`SELECT ${orderCols} FROM orders WHERE id=$1`, [d.order_id]))[0];
  if (!o) return { ok: false, status: 404, error: "주문을 찾을 수 없습니다." };
  const paid = ["paid", "shipped"].includes(o.status);
  const party = input.penaltyParty ?? null;
  const penalty = party ? penaltyFor(o.amount) : 0;
  // refund_amount is the running total owed back to the buyer across every ruling on
  // this order; `refund` below is only what this ruling adds.
  const prior = o.refund_amount;
  let total = prior;
  if (input.resolution === "cancel_refund") {
    if (!["awaiting_payment", "payment_reported", "paid", "shipped"].includes(o.status))
      return { ok: false, status: 400, error: "취소할 수 있는 주문 단계가 아닙니다." };
    // A buyer at fault pays the penalty out of the refund when money is held.
    if (paid && party === "buyer" && prior > o.amount - penalty)
      return { ok: false, status: 400, error: `이미 환불한 ${won(prior)}원이 커서 위약금 ${won(penalty)}원을 환불에서 뺄 수 없습니다. 위약금 없이 처리하거나 따로 받아 주세요.` };
    if (paid) total = Math.max(prior, o.amount - (party === "buyer" ? penalty : 0));
  } else if (input.resolution === "partial_refund") {
    if (!paid) return { ok: false, status: 400, error: "입금 확인 후에만 부분 환불할 수 있습니다." };
    const add = input.refundAmount ?? 0;
    if (!Number.isInteger(add) || add < 1 || prior + add >= o.amount)
      return { ok: false, status: 400, error: `부분 환불액은 1원 이상이고, 이전 환불 ${won(prior)}원을 더해 거래 금액 미만이어야 합니다.` };
    total = prior + add;
  } else if (o.status === "cancelled") return { ok: false, status: 400, error: "이미 취소된 주문입니다." };
  const refund = total - prior;
  const penaltyStatus = !party ? "none" : party === "buyer" && input.resolution === "cancel_refund" && paid ? "paid" : "due";
  const penaltyUser = party === "buyer" ? o.buyer_id : party === "seller" ? o.seller_id : null;
  // [0] locks the order row so a concurrent payment confirmation waits for this ruling;
  // [1] resolves the dispute only if the order is still in the state the amounts were computed from.
  const statements: Statement[] = [
    { sql: "SELECT id FROM orders WHERE id=$1 FOR UPDATE", params: [o.id] },
    {
      sql: `UPDATE disputes SET status='resolved', resolution=$2, refund_amount=$3, penalty_party=$4, penalty_user_id=$5, penalty_amount=$6,
              penalty_status=$7, admin_note=$8, resolved_by=$9, resolved_at=$10, penalty_settled_at=CASE WHEN $7='paid' THEN $10 ELSE NULL END
            WHERE id=$1 AND status='open' AND EXISTS (SELECT 1 FROM orders WHERE id=$11 AND status=$12 AND refund_amount=$13::int) RETURNING id`,
      params: [d.id, input.resolution, refund, party, penaltyUser, penalty, penaltyStatus, input.note ?? null, input.adminId, now, o.id, o.status, prior],
    },
  ];
  const autoAt = plus(now, AUTO_CONFIRM_DAYS * 86400000);
  if (input.resolution === "cancel_refund")
    statements.push({
      sql: `UPDATE orders SET status='cancelled', cancelled_at=$2, cancel_reason='dispute', refund_amount=$3::int,
              refunded_at=CASE WHEN $3::int > refund_paid THEN NULL ELSE refunded_at END
            WHERE id=$1 AND status=$4 AND EXISTS (SELECT 1 FROM disputes WHERE id=$5 AND status='resolved' AND resolved_by=$6 AND resolved_at=$2)
            RETURNING id, listing_id, seller_id, buyer_id, quantity, succession_round, product_title, bid_id, amount, offer_kind`,
      params: [o.id, now, total, o.status, d.id, input.adminId],
    });
  else if (input.resolution === "partial_refund")
    statements.push({
      sql: `UPDATE orders SET refund_amount=$3::int, refunded_at=NULL,
              fee=ROUND(((amount-$3::int)::numeric * fee_rate) / 10000)::int,
              net=((amount-$3::int) - ROUND(((amount-$3::int)::numeric * fee_rate) / 10000))::int,
              auto_complete_at=CASE WHEN status='shipped' THEN $4 ELSE auto_complete_at END
            WHERE id=$1 AND status=$7 AND EXISTS (SELECT 1 FROM disputes WHERE id=$5 AND status='resolved' AND resolved_by=$6 AND resolved_at=$2)
            RETURNING id`,
      params: [o.id, now, total, autoAt, d.id, input.adminId, o.status],
    });
  else
    statements.push({
      sql: `UPDATE orders SET
              auto_complete_at=CASE WHEN status='shipped' THEN $3 ELSE auto_complete_at END,
              payment_due_at=CASE WHEN status='awaiting_payment' AND payment_due_at < $4 THEN $4 ELSE payment_due_at END
            WHERE id=$1 AND EXISTS (SELECT 1 FROM disputes WHERE id=$5 AND status='resolved' AND resolved_by=$6 AND resolved_at=$2)
            RETURNING id`,
      params: [o.id, now, autoAt, plus(now, 24 * 3600000), d.id, input.adminId],
    });
  const results = await batch(statements);
  if (results[1].rowCount !== 1) return { ok: false, status: 409, error: "이미 처리되었거나 그 사이 주문 상태가 바뀌었습니다. 새로고침 후 다시 처리해 주세요." };
  if (results[2].rowCount !== 1) throw new Error("dispute order update did not apply");
  // The buyer's refund reveals any penalty taken out of it, so the seller only hears the outcome.
  const summary = (forBuyer: boolean) =>
    input.resolution === "cancel_refund"
      ? `거래를 취소했습니다.${forBuyer && refund ? ` 환불 예정액 ${won(refund)}원.` : ""}`
      : input.resolution === "partial_refund"
        ? `부분 환불 ${won(refund)}원으로 조정하고 거래를 계속합니다.`
        : "신고 내용을 검토한 결과 거래를 그대로 진행합니다.";
  const note = input.note ? ` 운영자 메모: ${input.note}` : "";
  await notify(query, [o.buyer_id], {
    kind: "dispute_resolved", title: `분쟁 처리 결과 · ${o.product_title}`, body: `${summary(true)}${note}`, refType: "order", refId: o.id,
  }, now);
  await notify(query, [o.seller_id], {
    kind: "dispute_resolved", title: `분쟁 처리 결과 · ${o.product_title}`, body: `${summary(false)}${note}`, refType: "order", refId: o.id,
  }, now);
  if (party && penaltyUser)
    await notify(query, [penaltyUser], {
      kind: "penalty_due", title: `위약금 ${penaltyStatus === "paid" ? "정산" : "부과"} · ${o.product_title}`,
      body: penaltyStatus === "paid"
        ? `위약금 ${won(penalty)}원(거래대금의 ${PENALTY_BPS / 100}%)을 환불액에서 차감했습니다.`
        : `위약금 ${won(penalty)}원(거래대금의 ${PENALTY_BPS / 100}%)이 부과되었습니다. 납부가 확인될 때까지 입찰과 재고 등록이 제한됩니다.`,
      refType: "order", refId: o.id,
    }, now);
  if (input.resolution === "cancel_refund") {
    const cancelled = results[2].rows[0] as unknown as CancelledOrder;
    // A buyer who backed out frees the lot for the next bidder; a bad listing does not.
    await afterCancel(query, batch, cancelled, now, "dispute", summary(false), { noSuccession: d.kind !== "buyer_cancel" });
  }
  return { ok: true, refund, penalty };
}
export async function settlePenalty(query: Query, disputeId: string, status: "paid" | "waived", now: string) {
  const rows = await query<{ penalty_user_id: string; penalty_amount: number }>(
    "UPDATE disputes SET penalty_status=$2, penalty_settled_at=$3 WHERE id=$1 AND penalty_status='due' RETURNING penalty_user_id, penalty_amount",
    [disputeId, status, now],
  );
  if (!rows.length) return false;
  await notify(query, [rows[0].penalty_user_id], {
    kind: "penalty_settled", title: status === "paid" ? "위약금 납부 확인" : "위약금 면제",
    body: `위약금 ${won(rows[0].penalty_amount)}원이 ${status === "paid" ? "납부 확인" : "면제"}되었습니다. 제한이 풀렸는지 거래 관리에서 확인해 주세요.`,
  }, now);
  return true;
}
