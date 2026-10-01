// Deposit ledger and matching, framework-free (injected query/batch) so the
// webhook route, admin actions, the cron sweep and scripts share one path.
import { adminIds, markPaid, notify, notifyPaid, type Batch, type Query } from "./auction-core";

export type DepositInput = {
  provider: "bank" | "manual" | "sms";
  eventId?: string;
  amount?: number;
  depositor?: string;
  occurredAt?: string;
  memo?: string;
  text?: string;
};
export type DepositResult = {
  result: "matched" | "unmatched" | "replay" | "unparsed" | "ignored";
  replay: boolean;
  depositId: string | null;
  reason?: string;
  orderId?: string;
};
export function normalizeDepositor(name: string) {
  return name
    .normalize("NFKC")
    .replace(/[\s\p{P}]/gu, "")
    .replace(/^(주식회사|유한회사|주)/, "")
    .toUpperCase();
}
// Parses the common Korean bank SMS shapes ("[KB]09/21 14:02 입금 1,980,000원 홍길동 잔액 ...").
export function parseBankSms(text: string): { amount: number; depositor: string } | { ignored: true } | null {
  const compact = text.replace(/\r?\n/g, " ");
  if (/출금/.test(compact)) return { ignored: true };
  const idx = compact.indexOf("입금");
  if (idx < 0) return null;
  const rest = compact.slice(idx + 2);
  const amountMatch = rest.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*원?/);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1].replace(/,/g, ""));
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const after = rest.slice((amountMatch.index ?? 0) + amountMatch[0].length);
  const clean = (part: string) => part.split(/[\s|/]+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const isName = (t: string) => t.length >= 2 && t.length <= 20 && !/^잔액/.test(t) && !/^\d+$/.test(t) && !/^\d{1,2}:\d{2}$/.test(t);
  // Depositor usually follows the amount ("입금 120,000원 홍길동"); some banks put it
  // before the keyword ("홍길동 입금 120,000원"), so fall back to the token just before 입금.
  const depositor = clean(after).find(isName) ?? clean(compact.slice(0, idx)).reverse().find(isName);
  if (!depositor) return null;
  return { amount, depositor };
}
async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
type OpenOrder = { id: string; buyer_id: string; amount: number; deposit_code: string | null; depositor: string | null; company: string | null; payment_due_at: string; product_title: string };
function nameEvidence(order: OpenOrder, key: string) {
  const names = [order.depositor, order.company].filter((v): v is string => !!v).map(normalizeDepositor).filter(Boolean);
  // Equal, one contains the other, or the first three characters agree (e.g. company vs. person who pays for it).
  return names.some((n) => n === key || n.includes(key) || key.includes(n) || (n.length >= 3 && key.length >= 3 && n.slice(0, 3) === key.slice(0, 3)));
}
async function markUnmatched(query: Query, depositId: string, reason: string, candidates: string[]) {
  await query(
    "UPDATE deposits SET status='unmatched', reason=$2, candidates=$3, resolved_at=NULL WHERE id=$1 AND status='received'",
    [depositId, reason, JSON.stringify(candidates)],
  );
}
function mask(name: string) {
  if (name.length <= 1) return "*";
  if (name.length === 2) return name[0] + "*";
  return name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
}
// Records one deposit event (idempotent by provider+event id) and tries to
// confirm exactly one open order. Exact amount is always required.
export async function recordDeposit(query: Query, batch: Batch, input: DepositInput, now: string): Promise<DepositResult> {
  let amount = input.amount;
  let depositor = input.depositor?.trim();
  if ((!amount || !depositor) && input.text) {
    const parsed = parseBankSms(input.text);
    if (parsed && "ignored" in parsed) return { result: "ignored", replay: false, depositId: null, reason: "withdrawal" };
    if (!parsed) {
      await notify(query, adminIds(), {
        kind: "admin_deposit_unmatched", title: "입금 문자를 해석하지 못했습니다",
        body: "입금 알림 문자의 금액이나 입금자명을 읽지 못했습니다. 관리 탭 입금 관리에서 수동으로 입력해 주세요.",
      }, now);
      return { result: "unparsed", replay: false, depositId: null, reason: "unparsed" };
    }
    amount = amount ?? parsed.amount;
    depositor = depositor ?? parsed.depositor;
  }
  if (!amount || !depositor) return { result: "unparsed", replay: false, depositId: null, reason: "missing_fields" };
  const key = normalizeDepositor(depositor);
  const eventId = input.eventId ?? (await sha256Hex([input.provider, amount, key, (input.occurredAt ?? "").slice(0, 16), input.memo ?? ""].join("|")));
  const id = crypto.randomUUID();
  const inserted = await query<{ id: string }>(
    `INSERT INTO deposits(id,provider,event_id,depositor,depositor_key,amount,occurred_at,raw,status,received_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'received',$9) ON CONFLICT (provider,event_id) DO NOTHING RETURNING id`,
    [id, input.provider, eventId, depositor, key, amount, input.occurredAt ?? null, input.text ?? input.memo ?? null, now],
  );
  let depositId = inserted[0]?.id;
  if (!depositId) {
    const existing = (await query<{ id: string; status: string; received_at: string }>(
      "SELECT id, status, received_at FROM deposits WHERE provider=$1 AND event_id=$2", [input.provider, eventId],
    ))[0];
    if (!existing) return { result: "unparsed", replay: true, depositId: null };
    if (existing.status !== "received" || Date.parse(existing.received_at) > Date.parse(now) - 120000)
      return { result: existing.status === "matched" ? "matched" : "replay", replay: true, depositId: existing.id };
    depositId = existing.id; // a previous attempt died mid-way: finish it
  }
  return matchDeposit(query, batch, { id: depositId, amount, key, depositor }, now);
}
export async function matchDeposit(query: Query, batch: Batch, deposit: { id: string; amount: number; key: string; depositor: string }, now: string): Promise<DepositResult> {
  const open = await query<OpenOrder>(
    `SELECT o.id, o.buyer_id, o.amount, o.deposit_code, o.depositor, p.company, o.payment_due_at, o.product_title
     FROM orders o LEFT JOIN profiles p ON p.user_id=o.buyer_id WHERE o.status IN ('awaiting_payment','payment_reported')`,
  );
  const base = { replay: false, depositId: deposit.id } as const;
  const unmatched = async (reason: string, candidates: OpenOrder[], hint?: string): Promise<DepositResult> => {
    await markUnmatched(query, deposit.id, reason, candidates.map((c) => c.id));
    await notify(query, adminIds(), {
      kind: "admin_deposit_unmatched", title: `미확인 입금 ${deposit.amount.toLocaleString("ko-KR")}원`,
      body: `입금자 ${mask(deposit.depositor)} · 사유 ${reason}${hint ? ` (${hint})` : ""} · 후보 ${candidates.length}건. 관리 탭 입금 관리에서 연결해 주세요.`,
      refType: "deposit", refId: deposit.id,
    }, now);
    return { ...base, result: "unmatched", reason };
  };
  const confirm = async (order: OpenOrder, note?: string): Promise<DepositResult> => {
    const paid = await markPaid(batch, order.id, now, "webhook", deposit.id, deposit.depositor);
    if (!paid) {
      await markUnmatched(query, deposit.id, "stale", [order.id]);
      return { ...base, result: "unmatched", reason: "stale" };
    }
    if (note) await query("UPDATE deposits SET note=$2 WHERE id=$1", [deposit.id, note]);
    await notifyPaid(query, paid, order.id, now);
    await notify(query, adminIds(), {
      kind: "admin_auto_paid", title: `입금 자동 확인 · ${paid.product_title}`,
      body: `${paid.amount.toLocaleString("ko-KR")}원이 입금자명 코드로 자동 확인되었습니다.${note ? ` (${note})` : ""}`, refType: "order", refId: order.id,
    }, now);
    return { ...base, result: "matched", orderId: order.id };
  };
  // a. deposit code inside the depositor name
  const byCode = open.filter((o) => o.deposit_code && deposit.key.includes(o.deposit_code));
  if (byCode.length === 1) {
    if (byCode[0].amount === deposit.amount) return confirm(byCode[0]);
    return unmatched("amount_mismatch", byCode);
  }
  if (byCode.length > 1) return unmatched("ambiguous", byCode);
  // b. same amount + name evidence
  const sameAmount = open.filter((o) => o.amount === deposit.amount);
  const byName = sameAmount.filter((o) => nameEvidence(o, deposit.key));
  if (byName.length === 1) return confirm(byName[0]);
  if (byName.length > 1) {
    const buyers = new Set(byName.map((o) => o.buyer_id));
    if (buyers.size === 1) return confirm([...byName].sort((x, y) => x.payment_due_at.localeCompare(y.payment_due_at))[0]);
    return unmatched("ambiguous", byName);
  }
  // A code that points at a closed order is stronger evidence than a same-amount coincidence.
  const closed = await query<{ id: string; status: string }>(
    "SELECT id, status FROM orders WHERE deposit_code IS NOT NULL AND status NOT IN ('awaiting_payment','payment_reported') AND position(deposit_code in $1) > 0 LIMIT 5",
    [deposit.key],
  );
  if (closed.length) {
    const paidLike = closed.some((c) => ["paid", "shipped", "completed", "settled"].includes(c.status));
    await markUnmatched(query, deposit.id, paidLike ? "already_paid" : "order_closed", closed.map((c) => c.id));
    return { ...base, result: "unmatched", reason: paidLike ? "already_paid" : "order_closed" };
  }
  // c. amount only (off unless explicitly enabled)
  if (sameAmount.length === 1 && process.env.DEPOSIT_MATCH_AMOUNT_ONLY === "true") return confirm(sameAmount[0], "amount_only");
  if (sameAmount.length >= 1) return unmatched("review", sameAmount);
  return unmatched("no_candidate", []);
}
// Re-tries pending deposits (after report_payment adds name evidence, or from the cron sweep).
export async function rematchDeposits(query: Query, batch: Batch, now: string, amount?: number) {
  const rows = await query<{ id: string; amount: number; depositor_key: string; depositor: string }>(
    `SELECT id, amount, depositor_key, depositor FROM deposits WHERE status IN ('received','unmatched') AND received_at < $1
       AND ($2::int IS NULL OR amount=$2::int) ORDER BY received_at DESC LIMIT 50`,
    [new Date(Date.parse(now) - 120000).toISOString(), amount ?? null],
  );
  let matched = 0;
  for (const d of rows) {
    await query("UPDATE deposits SET status='received' WHERE id=$1 AND status='unmatched'", [d.id]);
    const r = await matchDeposit(query, batch, { id: d.id, amount: d.amount, key: d.depositor_key, depositor: d.depositor }, now);
    if (r.result === "matched") matched++;
  }
  return matched;
}
