// Pure auction rules shared by the API route, the cron endpoint and the
// verification scripts. No framework imports so Node can run it directly.
//
// Every multi-statement write runs as ONE injected batch (transaction):
//   [1] advisory lock on "auction:<listing_id>"
//   [2] the claim — a conditional UPDATE that stamps a fresh per-attempt token
//   [3..] every later statement carries WHERE EXISTS(<claim row with that token>)
// The caller decides success only from the claim's rowCount after commit;
// losers write and notify nothing. A timestamp is never used as a token.
export type Query = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;
export type Statement = { sql: string; params?: unknown[] };
export type Batch = (statements: Statement[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }[]>;

export type AuctionRow = {
  listing_id: string;
  seller_id: string;
  quantity: number;
  unit: string;
  start_price: number;
  reserve_price: number;
  current_price: number | null;
  current_bidder_id: string | null;
  bid_count: number;
  starts_at: string;
  midpoint_at: string;
  ends_at: string;
  midpoint_alerted_at: string | null;
  extended_count: number;
  status: string;
  close_reason: string | null;
  closed_at: string | null;
  mode: "whole" | "partial";
  min_lot: number;
  sold_quantity: number;
  unsold_quantity: number;
  last_bid_id: string | null;
  close_token: string | null;
  reserve_met_at: string | null;
  succession_enabled: boolean;
  succession_until: string | null;
  relisted_to: string | null;
  relisted_quantity: number;
  instant_price: number | null;
  decision_stage: "seller" | null;
  decision_due_at: string | null;
};

export const AUCTION_DAYS = [3, 5, 7, 10, 14] as const;
export const PAYMENT_HOURS = 24;
export const EXTENSION_MINUTES = 5;
export const SUCCESSION_MAX_ROUNDS = 2;
export const SUCCESSION_WINDOW_DAYS = 7;
export const OFFER_HOURS = 24;
// Whole-lot auctions that end below the hidden reserve: the seller has this long to
// accept the top bid. Accepting makes the sale at once — the bid already committed the buyer.
export const DECISION_HOURS = 24;
// Shipped orders complete automatically when the buyer neither confirms nor disputes.
export const AUTO_CONFIRM_DAYS = 7;
// Penalty for backing out of a committed purchase (or seller fault), in basis points.
export const PENALTY_BPS = 1000;
// Default: the seller decides; accepting sells at the top bid with no second question to
// the buyer. "buyer_only" (unused in production) asks the top bidder instead.
export type BelowReservePolicy = "seller_decides" | "buyer_only";
// Switch values typed into the Vercel dashboard may carry stray spaces or capitals.
function envFlag(name: string) {
  return (process.env[name] ?? "").trim().toLowerCase();
}
export function belowReservePolicy(): BelowReservePolicy {
  return envFlag("BELOW_RESERVE_POLICY") === "buyer_only" ? "buyer_only" : "seller_decides";
}
// Offering a lot to the next bidder after a cancellation. Off unless AUCTION_SUCCESSION=on:
// an unpaid order is simply cancelled and the seller told they can relist.
export function successionEnabled() {
  return envFlag("AUCTION_SUCCESSION") === "on";
}
export function penalizeNonpayment() {
  return envFlag("PENALIZE_NONPAYMENT") !== "false";
}
// orders.amount/fee/net are int4; every price × quantity is capped here.
export const MONEY_CAP = 2_000_000_000;

// Fee rate is stored in basis points so integer money never drifts.
// PLATFORM_FEE_RATE is the default (0.03 = 3%, seller-paid); PLATFORM_FEE_RATES is an
// optional JSON map of category → rate, e.g. {"식품·음료":0.04,"디지털·가전":0.06}.
function toBps(value: unknown, fallback: number) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 && raw <= 0.5 ? Math.round(raw * 10000) : fallback;
}
// Unpaid penalties block bidding, listing and accepting offers until an admin marks them
// paid or waived. A penalty also reaches another account on the same business number, but
// only one that took that number after the penalty existed: a debtor's fresh login is
// caught, while an earlier holder of the number cannot be locked out by someone who
// registers it later and then defaults (numbers are public and ownership is not verified).
export async function penaltyDue(query: Query, userId: string) {
  const rows = await query<{ total: number }>(
    `SELECT COALESCE(SUM(d.penalty_amount),0)::int AS total FROM disputes d
     WHERE d.penalty_status='due' AND (d.penalty_user_id=$1 OR EXISTS (
       SELECT 1 FROM profiles x JOIN profiles y ON y.business_number=x.business_number
       WHERE x.user_id=$1 AND y.user_id=d.penalty_user_id AND COALESCE(x.business_number_since,'') > d.created_at))`,
    [userId],
  );
  return rows[0]?.total ?? 0;
}
export function feeRateBps(category?: string | null) {
  const base = toBps(process.env.PLATFORM_FEE_RATE ?? "0.03", 300);
  if (!category || !process.env.PLATFORM_FEE_RATES) return base;
  try {
    const map = JSON.parse(process.env.PLATFORM_FEE_RATES) as Record<string, unknown>;
    return category in map ? toBps(map[category], base) : base;
  } catch {
    return base;
  }
}
export function feeRateTable() {
  const base = feeRateBps();
  let overrides: Record<string, number> = {};
  try {
    const map = JSON.parse(process.env.PLATFORM_FEE_RATES || "{}") as Record<string, unknown>;
    overrides = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, toBps(v, base)]));
  } catch {
    overrides = {};
  }
  return { base, overrides };
}
export function feeFor(amount: number, bps: number) {
  return Math.round((amount * bps) / 10000);
}
// Korean-style bid steps keep amounts round at every price band.
export function bidStep(price: number) {
  if (price < 1000) return 10;
  if (price < 10000) return 100;
  if (price < 100000) return 500;
  if (price < 1000000) return 1000;
  return 10000;
}
export function minimumBid(auction: { current_price: number | null; start_price: number; instant_price?: number | null }) {
  const next = auction.current_price === null
    ? auction.start_price
    : auction.current_price + bidStep(auction.current_price);
  // The public instant price is always a valid bid, even off the step grid.
  return auction.instant_price ? Math.min(next, auction.instant_price) : next;
}
export function auctionWindow(now: Date, days: number) {
  const ends = new Date(now.getTime() + days * 86400000);
  const midpoint = new Date(now.getTime() + (days * 86400000) / 2);
  return { startsAt: now.toISOString(), midpointAt: midpoint.toISOString(), endsAt: ends.toISOString() };
}
export function kstDate(iso: string) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}
export function remainingLabel(endsAt: string, now = new Date()) {
  const ms = Date.parse(endsAt) - now.getTime();
  if (ms <= 0) return "종료";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}분 남음`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 ${minutes % 60}분 남음`;
  const days = Math.floor(hours / 24);
  return `${days}일 ${hours % 24}시간 남음`;
}
const won = (n: number) => n.toLocaleString("ko-KR");
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

export type NotifyNote = { kind: string; title: string; body: string; refType?: string; refId?: string };
// Optional side channel (web push) installed by server code; scripts leave it unset.
let notifyHook: ((userIds: string[], note: NotifyNote) => Promise<void>) | null = null;
export function setNotifyHook(hook: typeof notifyHook) {
  notifyHook = hook;
}
export async function notify(
  query: Query,
  userIds: string[],
  note: NotifyNote,
  now: string,
) {
  const targets = [...new Set(userIds.filter(Boolean))];
  for (const userId of targets) {
    await query(
      "INSERT INTO notifications(id,user_id,kind,title,body,ref_type,ref_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [crypto.randomUUID(), userId, note.kind, note.title, note.body, note.refType ?? null, note.refId ?? null, now],
    );
  }
  if (targets.length && notifyHook) await notifyHook(targets, note);
}

export function adminIds() {
  return (process.env.ADMIN_USER_IDS || "").split(",").map((v) => v.trim()).filter(Boolean);
}
export function lockStatement(listingId: string): Statement {
  return { sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", params: ["auction:" + listingId] };
}
// 4-digit code the buyer writes into the depositor name; unique among open orders.
export function depositCode() {
  return String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
}
export function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
// A listing becomes unsold again only when no live order remains on it.
export const listingUnsoldSql =
  "UPDATE listings SET status='unsold' WHERE id=$1 AND status='sold' AND NOT EXISTS (SELECT 1 FROM orders WHERE listing_id=$1 AND status<>'cancelled')";

export async function listingInfo(query: Query, listingId: string) {
  const rows = await query<{ document: string }>("SELECT document FROM listings WHERE id=$1", [listingId]);
  if (!rows[0]) return { title: "재고", image: "", category: null as string | null };
  const doc = JSON.parse(rows[0].document) as { title: string; image: string; category?: string };
  return { title: doc.title, image: doc.image, category: doc.category ?? null };
}

// ---------------------------------------------------------------------------
// Allocation (partial-quantity auctions). One pure function for the live
// view, the midpoint alert, expiry close, accept-now and succession.
export type AllocBid = { id: string; bidderId: string; unitPrice: number; quantity: number; createdAt: string; capacity?: number };
export function rankBids(bids: AllocBid[]) {
  return [...bids].sort((x, y) => y.unitPrice - x.unitPrice || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
}
export function allocate(bids: AllocBid[], stock: number, minLot: number, floor: number) {
  // floor 0 = ignore the reserve (live view / accept-now); floor = reserve_price at expiry and in succession.
  const fills: { bid: AllocBid; qty: number }[] = [];
  let remaining = stock;
  for (const b of rankBids(bids)) {
    if (remaining <= 0) break;
    if (b.unitPrice < floor) break; // sorted → every later bid is below the floor too
    const want = b.capacity ?? b.quantity;
    if (want <= 0) continue;
    const fill = Math.min(want, remaining);
    if (fill < minLot) break; // unreachable under stock%minLot==0 && quantity%minLot==0; kept as the explicit rule
    fills.push({ bid: b, qty: fill });
    remaining -= fill;
  }
  const cutoff = fills.length && remaining === 0 ? fills[fills.length - 1].bid.unitPrice : null;
  return { fills, remaining, filled: stock - remaining, cutoff };
}
export function partialSummary(standing: AllocBid[], stock: number, minLot: number, reserve: number) {
  const live = allocate(standing, stock, minLot, 0);
  const atReserve = allocate(standing, stock, minLot, reserve);
  return {
    subscribedQty: standing.reduce((s, b) => s + b.quantity, 0),
    cutoff: live.cutoff, // "현재 낙찰 하한가", null until fully subscribed
    filledQty: live.filled,
    remainingQty: live.remaining,
    sellableQty: atReserve.filled, // seller-only
    fillPrice: live.cutoff, // "이 가격 이하로 최저가를 낮추면 전량 낙찰"
    allocatedBy: new Map(live.fills.map((f) => [f.bid.id, f.qty])),
    reserveMet: atReserve.filled > 0, // public: something would sell
  };
}
export function partialMinimumBid(a: { start_price: number }, othersStanding: AllocBid[], stock: number, minLot: number) {
  const s = allocate(othersStanding, stock, minLot, 0); // the bidder's own active bid is excluded (it is being replaced)
  return s.cutoff === null ? a.start_price : s.cutoff + bidStep(s.cutoff);
}
type StandingRow = { id: string; bidder_id: string; amount: number; quantity: number; created_at: string };
export async function standingBids(query: Query, listingId: string): Promise<AllocBid[]> {
  const rows = await query<StandingRow>(
    "SELECT id, bidder_id, amount, quantity, created_at FROM bids WHERE listing_id=$1 AND status='active' AND quantity IS NOT NULL",
    [listingId],
  );
  return rows.map((r) => ({ id: r.id, bidderId: r.bidder_id, unitPrice: r.amount, quantity: r.quantity, createdAt: r.created_at }));
}
function requireBatch(batch: Batch | undefined): Batch {
  if (!batch) throw new Error("batch is required for partial-mode auctions and succession");
  return batch;
}

// ---------------------------------------------------------------------------
// Closing
type Winner = { bid: AllocBid; qty: number; orderId: string; amount: number; fee: number; net: number; code: string };
const orderInsertSql = `INSERT INTO orders(id,listing_id,seller_id,buyer_id,product_title,image,unit,quantity,unit_price,amount,fee_rate,fee,net,status,payment_due_at,created_at,bid_id,bid_quantity,deposit_code,batch_token)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8::int,$9::int,$10::int,$11::int,$12::int,$13::int,'awaiting_payment',$14,$15,$16,$17::int,$18,$19
  WHERE EXISTS (SELECT 1 FROM auctions WHERE listing_id=$2 AND close_token=$19)`;

// Closes one active auction. `mode` "expire" applies the reserve rule; "accept"
// is the seller taking the standing bids early (whole: the top bid even below
// the reserve; partial: every bid at or above `floor`, default 0).
export type CloseResult = { status: "won" | "unsold" | "deciding"; orderId: string | null; orderIds: string[] };
export async function closeAuction(
  query: Query,
  auction: AuctionRow,
  now: string,
  mode: "expire" | "accept",
  batch?: Batch,
  floor = 0,
): Promise<CloseResult | null> {
  if (auction.mode === "partial") return closePartial(query, requireBatch(batch), auction, now, mode, floor);
  return closeWhole(query, requireBatch(batch), auction, now, mode);
}

const wholeOrderSql = `INSERT INTO orders(id,listing_id,seller_id,buyer_id,product_title,image,unit,quantity,unit_price,amount,fee_rate,fee,net,status,payment_due_at,offer_expires_at,created_at,bid_id,bid_quantity,deposit_code,batch_token,offer_kind)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8::int,$9::int,$10::int,$11::int,$12::int,$13::int,$14,$15,$16::text,$17,$18,$8::int,$19,$20,$21::text
  WHERE EXISTS (SELECT 1 FROM auctions WHERE listing_id=$2 AND close_token=$20)`;
type Award = { orderId: string; code: string; amount: number };
// Claims the auction with `claim(tok)` and, in the same transaction, creates the
// single whole-lot order (awaiting payment, or an offer the buyer must accept)
// and marks the listing sold. Returns null when the claim lost a race.
async function awardWhole(
  query: Query, batch: Batch, a: AuctionRow, now: string,
  claim: (tok: string) => Statement,
  offer: "below_reserve" | null,
): Promise<Award | null> {
  const { title, image, category } = await listingInfo(query, a.listing_id);
  const bps = feeRateBps(category);
  const amount = a.current_price! * a.quantity;
  const fee = feeFor(amount, bps);
  const top = await query<{ id: string }>(
    "SELECT id FROM bids WHERE listing_id=$1 AND bidder_id=$2 ORDER BY amount DESC, created_at DESC LIMIT 1",
    [a.listing_id, a.current_bidder_id],
  );
  const due = plus(now, (offer ? OFFER_HOURS : PAYMENT_HOURS) * 3600000);
  for (let attempt = 0; ; attempt++) {
    const tok = crypto.randomUUID(), orderId = crypto.randomUUID(), code = depositCode();
    try {
      const results = await batch([
        lockStatement(a.listing_id),
        claim(tok),
        {
          sql: wholeOrderSql,
          params: [orderId, a.listing_id, a.seller_id, a.current_bidder_id, title, image, a.unit, a.quantity, a.current_price, amount, bps, fee,
            amount - fee, offer ? "offered" : "awaiting_payment", due, offer ? due : null, now, top[0]?.id ?? null, code, tok, offer],
        },
        {
          sql: "UPDATE listings SET status='sold' WHERE id=$1 AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_token=$2)",
          params: [a.listing_id, tok],
        },
      ]);
      if (results[1].rowCount !== 1) return null;
      return { orderId, code, amount };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 3) throw error;
    }
  }
}
async function notifyLosers(query: Query, a: AuctionRow, title: string, body: string, now: string) {
  const losers = await query<{ bidder_id: string }>(
    "SELECT DISTINCT bidder_id FROM bids WHERE listing_id=$1 AND bidder_id IS DISTINCT FROM $2",
    [a.listing_id, a.current_bidder_id],
  );
  await notify(query, losers.map((r) => r.bidder_id), { kind: "auction_lost", title: `경매 종료 · ${title}`, body, refType: "listing", refId: a.listing_id }, now);
}
async function notifyWholeWin(query: Query, a: AuctionRow, award: Award, how: "expire" | "accept" | "instant", now: string) {
  const { title } = await listingInfo(query, a.listing_id);
  const price = won(a.current_price!);
  await notify(query, [a.current_bidder_id!], {
    kind: "auction_won",
    title: `${how === "instant" ? "즉시구매 낙찰" : "낙찰"} · ${title}`,
    body: `${how === "instant" ? `즉시구매가 ${price}원으로 바로 낙찰되었습니다. ` : ""}총 ${won(award.amount)}원. ${PAYMENT_HOURS}시간 안에 입금하고 입금자명에 코드 ${award.code}를 함께 적어 주세요. 입금이 확인되면 공급자 연락처가 공개됩니다.`,
    refType: "order", refId: award.orderId,
  }, now);
  await notify(query, [a.seller_id], {
    kind: "auction_sold",
    title: `${how === "instant" ? "즉시체결" : "낙찰 완료"} · ${title}`,
    body: `${how === "instant" ? "즉시체결가에 입찰이 들어와 경매가 바로 끝났습니다. " : ""}${won(award.amount)}원에 낙찰되었습니다. 구매자 입금이 확인되면 연락처가 서로 공개됩니다.`,
    refType: "order", refId: award.orderId,
  }, now);
  await notifyLosers(query, a, title, how === "instant" ? "다른 구매자가 즉시구매가로 낙찰받아 경매가 종료되었습니다." : LOSER_TEXT, now);
}
// Losers get the same words whether the reserve was met, missed, or is still being decided:
// anything else would tell them where the hidden reserve sits. Succession offers arrive separately.
const LOSER_TEXT = "경매가 종료되었습니다. 다른 구매자가 최고가로 입찰했습니다.";
// Seller accepted a top bid below the reserve: a sale, exactly like a normal win for the buyer.
// Losers were already told when the auction closed.
async function notifyBelowReserveSale(query: Query, a: AuctionRow, award: Award, now: string) {
  const { title } = await listingInfo(query, a.listing_id);
  await notify(query, [a.current_bidder_id!], {
    kind: "auction_won",
    title: `낙찰 · ${title}`,
    body: `판매자가 회원님의 입찰가 ${won(a.current_price!)}원에 판매하기로 해 낙찰되었습니다. 총 ${won(award.amount)}원. ${PAYMENT_HOURS}시간 안에 입금하고 입금자명에 코드 ${award.code}를 함께 적어 주세요. 입금이 확인되면 공급자 연락처가 공개됩니다.`,
    refType: "order", refId: award.orderId,
  }, now);
  await notify(query, [a.seller_id], {
    kind: "auction_sold",
    title: `판매 확정 · ${title}`,
    body: `최고 입찰가 ${won(a.current_price!)}원(총 ${won(award.amount)}원)에 판매했습니다. 구매자가 ${PAYMENT_HOURS}시간 안에 입금하면 연락처가 서로 공개됩니다.`,
    refType: "order", refId: award.orderId,
  }, now);
}
async function notifyBelowReserveOffer(query: Query, a: AuctionRow, award: Award, now: string, sellerAccepted: boolean) {
  const { title } = await listingInfo(query, a.listing_id);
  await notify(query, [a.current_bidder_id!], {
    kind: "below_reserve_offer",
    title: `구매 의사 확인 · ${title}`,
    body: `${sellerAccepted ? "경매는 판매 조건에 못 미쳐 끝났지만 판매자가 회원님의 입찰가에 판매하기로 했습니다. " : "경매가 판매 조건에 못 미쳐 끝났습니다. "}회원님이 제시한 ${won(a.current_price!)}원(총 ${won(award.amount)}원)으로 구매하시겠습니까? ${OFFER_HOURS}시간 안에 답하지 않으면 유찰됩니다.`,
    refType: "order", refId: award.orderId,
  }, now);
  await notify(query, [a.seller_id], {
    kind: "below_reserve_offered",
    title: `구매 의사 확인 중 · ${title}`,
    body: `최고 입찰자에게 ${won(a.current_price!)}원으로 구매할지 묻고 있습니다. 수락하면 입금 절차가 시작되고, 거절하거나 ${OFFER_HOURS}시간이 지나면 유찰됩니다.`,
    refType: "listing", refId: a.listing_id,
  }, now);
}

async function closeWhole(query: Query, batch: Batch, a: AuctionRow, now: string, mode: "expire" | "accept"): Promise<CloseResult | null> {
  const hasTop = a.current_price !== null && a.current_bidder_id !== null;
  const meets = hasTop && (mode === "accept" || a.current_price! >= a.reserve_price);
  const succUntil = plus(now, SUCCESSION_WINDOW_DAYS * 86400000);
  // The claim re-checks the state this decision was made from: a bid that slipped
  // in (bid_count) or extended the auction (ends_at) makes it lose.
  // It also re-checks the reserve the met/below-reserve branch was chosen from (an integer, safe to inline).
  const claimWhere = `listing_id=$1 AND status='active' AND mode='whole' AND bid_count=$2::int AND ($3::boolean OR ends_at <= $4) AND (NOT $3::boolean OR seller_id=$5::text) AND reserve_price=${Math.trunc(a.reserve_price)}`;
  const base = [a.listing_id, a.bid_count, mode === "accept", now, a.seller_id];
  const { title } = await listingInfo(query, a.listing_id);
  if (meets) {
    const award = await awardWhole(query, batch, a, now, (tok) => ({
      sql: `UPDATE auctions SET status='won', close_reason=$6, closed_at=$4, close_token=$7, sold_quantity=quantity, unsold_quantity=0, succession_until=$8
            WHERE ${claimWhere} RETURNING listing_id`,
      params: [...base, mode === "accept" ? "seller_accepted" : "reserve_met", tok, succUntil],
    }), null);
    if (!award) return null;
    await notifyWholeWin(query, a, award, mode, now);
    return { status: "won", orderId: award.orderId, orderIds: [award.orderId] };
  }
  if (hasTop) {
    // Ended below the hidden reserve (mode is necessarily "expire").
    if (belowReservePolicy() === "buyer_only") {
      const award = await awardWhole(query, batch, a, now, (tok) => ({
        sql: `UPDATE auctions SET status='won', close_reason='below_reserve_offer', closed_at=$4, close_token=$6, sold_quantity=quantity, unsold_quantity=0, succession_until=$7
              WHERE ${claimWhere} RETURNING listing_id`,
        params: [...base, tok, succUntil],
      }), "below_reserve");
      if (!award) return null;
      await notifyBelowReserveOffer(query, a, award, now, false);
      await notifyLosers(query, a, title, LOSER_TEXT, now);
      return { status: "won", orderId: award.orderId, orderIds: [award.orderId] };
    }
    const tok = crypto.randomUUID();
    const due = plus(now, DECISION_HOURS * 3600000);
    const results = await batch([
      lockStatement(a.listing_id),
      {
        sql: `UPDATE auctions SET status='deciding', decision_stage='seller', decision_due_at=$6, closed_at=$4, close_reason='below_reserve', close_token=$7
              WHERE ${claimWhere} RETURNING listing_id`,
        params: [...base, due, tok],
      },
      { sql: "UPDATE listings SET status='pending' WHERE id=$1 AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_token=$2)", params: [a.listing_id, tok] },
    ]);
    if (results[1].rowCount !== 1) return null;
    const deadline = new Date(due).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    await notify(query, [a.seller_id], {
      kind: "below_reserve_decision",
      title: `판매 결정 필요 · ${title}`,
      body: `경매가 끝났지만 최고 입찰가 ${won(a.current_price!)}원이 최저 매각가에 못 미쳤습니다. 이 가격에 판매할지 ${deadline}까지 정해 주세요. 판매하면 바로 낙찰되어 구매자에게 입금 안내가 가고, 정하지 않으면 유찰됩니다.`,
      refType: "listing", refId: a.listing_id,
    }, now);
    await notify(query, [a.current_bidder_id!], {
      kind: "auction_pending",
      title: `경매 종료 · ${title}`,
      body: `경매가 끝났습니다. 판매자가 ${DECISION_HOURS}시간 안에 회원님의 입찰가로 판매할지 정합니다. 판매하기로 하면 바로 낙찰되어 입금 안내를 드려요.`,
      refType: "listing", refId: a.listing_id,
    }, now);
    await notifyLosers(query, a, title, LOSER_TEXT, now);
    return { status: "deciding", orderId: null, orderIds: [] };
  }
  // No bids at all.
  const tok = crypto.randomUUID();
  const results = await batch([
    lockStatement(a.listing_id),
    {
      sql: `UPDATE auctions SET status='unsold', close_reason='no_bids', closed_at=$4, close_token=$6, sold_quantity=0, unsold_quantity=quantity
            WHERE ${claimWhere} AND current_price IS NULL RETURNING listing_id`,
      params: [...base, tok],
    },
    { sql: "UPDATE listings SET status='unsold' WHERE id=$1 AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_token=$2)", params: [a.listing_id, tok] },
  ]);
  if (results[1].rowCount !== 1) return null;
  await notify(query, [a.seller_id], {
    kind: "auction_unsold", title: `유찰 · ${title}`,
    body: "경매 기간 동안 입찰이 없었습니다. 시작가나 최저 매각가를 조정해 다시 등록할 수 있어요.",
    refType: "listing", refId: a.listing_id,
  }, now);
  return { status: "unsold", orderId: null, orderIds: [] };
}

// Seller's answer (or the deadline) for a whole-lot auction that ended below reserve.
export async function resolveBelowReserve(
  query: Query, batch: Batch, listingId: string, now: string,
  how: { accept: boolean; sellerId?: string; expired?: boolean },
): Promise<{ ok: true; orderId?: string } | { ok: false; error: string }> {
  const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1", [listingId]))[0];
  if (!a || a.status !== "deciding" || a.decision_stage !== "seller") return { ok: false, error: "판매 결정을 기다리는 경매가 아닙니다." };
  if (how.sellerId && a.seller_id !== how.sellerId) return { ok: false, error: "판매 결정을 기다리는 경매가 아닙니다." };
  const { title } = await listingInfo(query, listingId);
  if (how.accept) {
    const award = await awardWhole(query, batch, a, now, (tok) => ({
      sql: `UPDATE auctions SET status='won', decision_stage=NULL, decision_due_at=NULL, close_reason='seller_accepted_below_reserve', close_token=$3,
              sold_quantity=quantity, unsold_quantity=0, succession_until=$4
            WHERE listing_id=$1 AND seller_id=$2 AND status='deciding' AND decision_stage='seller' AND decision_due_at > $5 RETURNING listing_id`,
      params: [listingId, a.seller_id, tok, plus(now, SUCCESSION_WINDOW_DAYS * 86400000), now],
    }), null);
    if (!award) return { ok: false, error: "결정 기한이 지났거나 이미 처리되었습니다." };
    await notifyBelowReserveSale(query, a, award, now);
    return { ok: true, orderId: award.orderId };
  }
  const reason = how.expired ? "decision_expired" : "seller_declined_below_reserve";
  const results = await batch([
    lockStatement(listingId),
    {
      sql: `UPDATE auctions SET status='unsold', decision_stage=NULL, decision_due_at=NULL, close_reason=$2, sold_quantity=0, unsold_quantity=quantity
            WHERE listing_id=$1 AND status='deciding' AND decision_stage='seller'
              AND ($3::text IS NULL OR seller_id=$3::text) AND (NOT $4::boolean OR decision_due_at <= $5) RETURNING listing_id`,
      params: [listingId, reason, how.sellerId ?? null, how.expired === true, now],
    },
    { sql: "UPDATE listings SET status='unsold' WHERE id=$1 AND status='pending' AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_reason=$2 AND status='unsold')", params: [listingId, reason] },
  ]);
  if (results[1].rowCount !== 1) return { ok: false, error: "결정 기한이 지났거나 이미 처리되었습니다." };
  await notify(query, [a.seller_id], {
    kind: "auction_unsold", title: `유찰 · ${title}`,
    body: how.expired ? "판매 결정 기한이 지나 유찰되었습니다. 최저 매각가를 조정해 다시 경매할 수 있어요." : "판매하지 않기로 해 유찰되었습니다. 조건을 조정해 다시 경매할 수 있어요.",
    refType: "listing", refId: listingId,
  }, now);
  await notify(query, [a.current_bidder_id!], {
    kind: "auction_lost", title: `경매 종료 · ${title}`,
    body: how.expired ? "판매자가 기한 내 판매 여부를 정하지 않아 거래가 성사되지 않았습니다." : "판매자가 이번 입찰가로는 판매하지 않기로 해 거래가 성사되지 않았습니다.",
    refType: "listing", refId: listingId,
  }, now);
  return { ok: true };
}

// Whole-lot bid. One transaction: the auction row is updated with a CAS on the
// price the bidder saw; if the bid reaches the public instant price the same
// statement closes the auction at the instant price and the order is created.
export type WholeBidResult =
  | { ok: true; instant: boolean; price: number; endsAt: string; extended: boolean; orderId?: string }
  | { ok: false; conflict: true };
export async function placeWholeBid(
  query: Query, batch: Batch, a: AuctionRow, bidderId: string, amount: number, now: string,
  opts: { buyNow?: boolean; ipHash?: string | null; extensionMinutes: number },
): Promise<WholeBidResult> {
  const { title, image, category } = await listingInfo(query, a.listing_id);
  const bps = feeRateBps(category);
  const min = minimumBid({ ...a, instant_price: null });
  const extendTo = plus(now, opts.extensionMinutes * 60000);
  const hit = "(instant_price IS NOT NULL AND $6::int >= instant_price)";
  for (let attempt = 0; ; attempt++) {
    const bidId = crypto.randomUUID(), tok = crypto.randomUUID(), orderId = crypto.randomUUID(), code = depositCode();
    const due = plus(now, PAYMENT_HOURS * 3600000);
    try {
      const results = await batch([
        lockStatement(a.listing_id),
        {
          sql: `UPDATE auctions SET
                  current_price = CASE WHEN ${hit} THEN instant_price ELSE $6::int END,
                  current_bidder_id=$3, bid_count=bid_count+1, last_bid_id=$7,
                  status = CASE WHEN ${hit} THEN 'won' ELSE status END,
                  close_reason = CASE WHEN ${hit} THEN 'instant' ELSE close_reason END,
                  closed_at = CASE WHEN ${hit} THEN $4 ELSE closed_at END,
                  close_token = CASE WHEN ${hit} THEN $8 ELSE close_token END,
                  sold_quantity = CASE WHEN ${hit} THEN quantity ELSE sold_quantity END,
                  succession_until = CASE WHEN ${hit} THEN $9 ELSE succession_until END,
                  extended_count = extended_count + CASE WHEN NOT ${hit} AND ends_at < $10 THEN 1 ELSE 0 END,
                  ends_at = CASE WHEN NOT ${hit} AND ends_at < $10 THEN $10 ELSE ends_at END
                WHERE listing_id=$1 AND status='active' AND mode='whole' AND ends_at > $4 AND seller_id <> $3
                  AND current_price IS NOT DISTINCT FROM $2::int
                  AND (NOT $11::boolean OR instant_price = $6::int)
                  AND (${hit} OR ($6::int >= $5::int AND current_bidder_id IS DISTINCT FROM $3))
                  AND LEAST($6::bigint, COALESCE(instant_price, $6::int)::bigint) * quantity <= 2000000000
                RETURNING status, current_price, ends_at, extended_count`,
          params: [a.listing_id, a.current_price, bidderId, now, min, amount, bidId, tok, plus(now, SUCCESSION_WINDOW_DAYS * 86400000), extendTo, opts.buyNow === true],
        },
        {
          sql: `INSERT INTO bids(id, listing_id, bidder_id, amount, created_at, ip_hash)
                SELECT $2, $1, $3, current_price, $4, $5 FROM auctions WHERE listing_id=$1 AND last_bid_id=$2`,
          params: [a.listing_id, bidId, bidderId, now, opts.ipHash ?? null],
        },
        {
          sql: `INSERT INTO orders(id,listing_id,seller_id,buyer_id,product_title,image,unit,quantity,unit_price,amount,fee_rate,fee,net,status,payment_due_at,created_at,bid_id,bid_quantity,deposit_code,batch_token)
                SELECT $2, a.listing_id, a.seller_id, a.current_bidder_id, $3, $4, a.unit, a.quantity, a.current_price, a.current_price * a.quantity, $5::int,
                  ROUND((a.current_price::numeric * a.quantity * $5::int) / 10000)::int,
                  (a.current_price * a.quantity - ROUND((a.current_price::numeric * a.quantity * $5::int) / 10000))::int,
                  'awaiting_payment', $6, $7, $8, a.quantity, $9, $10
                FROM auctions a WHERE a.listing_id=$1 AND a.close_token=$10 AND a.status='won'`,
          params: [a.listing_id, orderId, title, image, bps, due, now, bidId, code, tok],
        },
        {
          sql: "UPDATE listings SET status='sold' WHERE id=$1 AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_token=$2 AND status='won')",
          params: [a.listing_id, tok],
        },
      ]);
      if (results[1].rowCount !== 1) return { ok: false, conflict: true };
      const row = results[1].rows[0] as { status: string; current_price: number; ends_at: string; extended_count: number };
      if (row.status === "won") {
        const closed = { ...a, current_price: row.current_price, current_bidder_id: bidderId };
        await notifyWholeWin(query, closed, { orderId, code, amount: row.current_price * a.quantity }, "instant", now);
        return { ok: true, instant: true, price: row.current_price, endsAt: row.ends_at, extended: false, orderId };
      }
      if (a.current_bidder_id && a.current_bidder_id !== bidderId)
        await notify(query, [a.current_bidder_id], {
          kind: "outbid", title: `더 높은 입찰 · ${title}`,
          body: `다른 구매자가 ${won(row.current_price)}원에 입찰했습니다. 다시 입찰할 수 있어요.`,
          refType: "listing", refId: a.listing_id,
        }, now);
      if (row.current_price >= a.reserve_price && (a.current_price === null || a.current_price < a.reserve_price))
        await notify(query, [a.seller_id], {
          kind: "reserve_met", title: `최저 매각가 도달 · ${title}`,
          body: `${won(row.current_price)}원 입찰로 최저 매각가에 도달했습니다. 마감 시 자동 낙찰됩니다.`,
          refType: "listing", refId: a.listing_id,
        }, now);
      return { ok: true, instant: false, price: row.current_price, endsAt: row.ends_at, extended: row.extended_count > a.extended_count };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 3) throw error;
    }
  }
}

async function closePartial(query: Query, batch: Batch, a: AuctionRow, now: string, mode: "expire" | "accept", acceptFloor: number) {
  const standing = await standingBids(query, a.listing_id);
  const { title, image, category } = await listingInfo(query, a.listing_id);
  const bps = feeRateBps(category);
  const floor = mode === "expire" ? a.reserve_price : acceptFloor;
  const { fills, remaining } = allocate(standing, a.quantity, a.min_lot, floor);
  const sold = fills.length > 0;
  const status: "won" | "unsold" = sold ? "won" : "unsold";
  const reason = sold
    ? mode === "accept" ? "seller_accepted" : remaining > 0 ? "partial_fill" : "reserve_met"
    : standing.length ? "below_reserve" : "no_bids";
  const dueAt = plus(now, PAYMENT_HOURS * 3600000);
  for (let attempt = 0; ; attempt++) {
    const tok = crypto.randomUUID();
    const winners: Winner[] = fills.map((f) => {
      const amount = f.qty * f.bid.unitPrice;
      const fee = feeFor(amount, bps);
      return { bid: f.bid, qty: f.qty, orderId: crypto.randomUUID(), amount, fee, net: amount - fee, code: depositCode() };
    });
    const statements: Statement[] = [
      lockStatement(a.listing_id),
      {
        sql: `UPDATE auctions SET status=$2, close_reason=$3, closed_at=$4, close_token=$5, sold_quantity=$6, unsold_quantity=$7, succession_until=$8
              WHERE listing_id=$1 AND status='active' AND mode='partial' AND bid_count=$9 AND reserve_price=$10
                AND ($11::boolean OR ends_at <= $4) AND (NOT $11::boolean OR seller_id=$12::text) RETURNING listing_id`,
        params: [a.listing_id, status, reason, now, tok, a.quantity - remaining, remaining, plus(now, SUCCESSION_WINDOW_DAYS * 86400000),
          a.bid_count, a.reserve_price, mode === "accept", a.seller_id],
      },
    ];
    for (const w of winners) {
      statements.push({
        sql: orderInsertSql,
        params: [w.orderId, a.listing_id, a.seller_id, w.bid.bidderId, title, image, a.unit, w.qty, w.bid.unitPrice, w.amount, bps, w.fee, w.net,
          dueAt, now, w.bid.id, w.bid.quantity, w.code, tok],
      });
      statements.push({
        sql: `UPDATE bids SET status=CASE WHEN $2::int >= quantity THEN 'won' ELSE 'partial' END, allocated_quantity=$2::int, order_id=$3
              WHERE id=$1 AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$4 AND close_token=$5)`,
        params: [w.bid.id, w.qty, w.orderId, a.listing_id, tok],
      });
    }
    statements.push({
      sql: `UPDATE bids SET status='lost', lost_reason=CASE WHEN amount < $2::int THEN 'below_reserve' ELSE 'sold_out' END
            WHERE listing_id=$1 AND status='active' AND quantity IS NOT NULL AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_token=$3)`,
      params: [a.listing_id, floor, tok],
    });
    statements.push({
      sql: "UPDATE listings SET status=$2 WHERE id=$1 AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_token=$3)",
      params: [a.listing_id, sold ? "sold" : "unsold", tok],
    });
    let results;
    try {
      results = await batch(statements);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 3) throw error;
      continue; // deposit code collision: new codes and a new token
    }
    if (results[1].rowCount !== 1) return null;
    if (!sold) {
      await notify(query, [a.seller_id], {
        kind: "auction_unsold",
        title: `유찰 · ${title}`,
        body: standing.length
          ? "최저 매각가 이상 입찰이 없어 유찰되었습니다. 최저 매각가를 낮춰 다시 등록해 보세요."
          : "경매 기간 동안 입찰이 없었습니다. 시작가나 최저 매각가를 조정해 다시 등록할 수 있어요.",
        refType: "listing", refId: a.listing_id,
      }, now);
      return { status, orderId: null, orderIds: [] };
    }
    const total = winners.reduce((s, w) => s + w.amount, 0);
    for (const w of winners) {
      const partial = w.qty < w.bid.quantity;
      await notify(query, [w.bid.bidderId], {
        kind: partial ? "auction_partial_won" : "auction_won",
        title: `${partial ? "일부 낙찰" : "낙찰"} · ${title}`,
        body: `${partial ? `입찰 ${won(w.bid.quantity)}${a.unit} 중 ${won(w.qty)}${a.unit}가 낙찰되었습니다. ` : ""}${won(w.bid.unitPrice)}원 × ${won(w.qty)}${a.unit} = ${won(w.amount)}원. ${PAYMENT_HOURS}시간 안에 입금하고 입금자명에 코드 ${w.code}를 함께 적어 주세요.`,
        refType: "order", refId: w.orderId,
      }, now);
    }
    await notify(query, [a.seller_id], {
      kind: "auction_sold",
      title: `낙찰 완료 · ${title}`,
      body: `${winners.length}명에게 ${won(a.quantity - remaining)}/${won(a.quantity)}${a.unit} 낙찰 · 총 ${won(total)}원.` +
        (remaining > 0 ? ` 미낙찰 ${won(remaining)}${a.unit}는 다시 경매할 수 있어요.` : "") + " 구매자 입금이 확인되면 연락처가 서로 공개됩니다.",
      refType: "listing", refId: a.listing_id,
    }, now);
    const winnerIds = new Set(winners.map((w) => w.bid.bidderId));
    const losers = standing.map((b) => b.bidderId).filter((id) => !winnerIds.has(id));
    await notify(query, losers, {
      kind: "auction_lost",
      title: `경매 종료 · ${title}`,
      body: "다른 구매자가 더 높은 가격으로 낙찰받았습니다." +
        (a.succession_enabled && successionEnabled() ? " 낙찰자가 미입금하면 마감 후 7일 이내 차순위로 제안될 수 있어요." : ""),
      refType: "listing", refId: a.listing_id,
    }, now);
    return { status, orderId: winners[0]?.orderId ?? null, orderIds: winners.map((w) => w.orderId) };
  }
}

// ---------------------------------------------------------------------------
// Orders: cancellation, succession, payment
export type CancelledOrder = {
  id: string; listing_id: string; seller_id: string; buyer_id: string; quantity: number;
  succession_round: number; product_title: string; bid_id: string | null; amount: number; offer_kind: string | null;
};
export async function cancelOrder(
  query: Query,
  orderId: string,
  now: string,
  reason: string,
  allowed: string[],
  extra: { buyerId?: string; expiredOnly?: boolean; noOpenDispute?: boolean; penaltyBatch?: Batch } = {},
) {
  const clauses = ["id=$1", "status = ANY($4::text[])"];
  const params: unknown[] = [orderId, now, reason, allowed];
  if (extra.buyerId) {
    params.push(extra.buyerId);
    clauses.push(`buyer_id=$${params.length}`);
  }
  if (extra.expiredOnly) clauses.push("offer_expires_at <= $2");
  if (extra.noOpenDispute) clauses.push(openDispute);
  const cancelSql = `UPDATE orders SET status='cancelled', cancelled_at=$2, cancel_reason=$3 WHERE ${clauses.join(" AND ")}
     RETURNING id, listing_id, seller_id, buyer_id, quantity, succession_round, product_title, bid_id, amount, offer_kind`;
  if (extra.penaltyBatch) {
    // Non-payment: the cancel and the 10% penalty commit together or not at all.
    const results = await extra.penaltyBatch([
      { sql: cancelSql, params },
      {
        sql: `INSERT INTO disputes(id, order_id, listing_id, opened_by, opener_role, kind, description, status, resolution,
                penalty_party, penalty_user_id, penalty_amount, penalty_status, resolved_by, resolved_at, created_at)
              SELECT $2, o.id, o.listing_id, 'system', 'system', 'no_payment', '입금 기한이 지나 낙찰이 자동 취소되었습니다.', 'resolved', 'cancel',
                'buyer', o.buyer_id, ROUND((o.amount::numeric * $3::int) / 10000)::int, 'due', 'system', $4, $4
              FROM orders o WHERE o.id=$1 AND o.status='cancelled' AND o.cancel_reason=$5 AND o.cancelled_at=$4
              ON CONFLICT DO NOTHING`,
        params: [orderId, crypto.randomUUID(), PENALTY_BPS, now, reason],
      },
    ]);
    return (results[0].rows[0] as CancelledOrder | undefined) ?? null;
  }
  const rows = await query<CancelledOrder>(cancelSql, params);
  return rows[0] ?? null;
}
const successorInsertSql = `INSERT INTO orders(id,listing_id,seller_id,buyer_id,product_title,image,unit,quantity,unit_price,amount,fee_rate,fee,net,status,payment_due_at,offer_expires_at,created_at,bid_id,bid_quantity,deposit_code,succession_round,parent_order_id,batch_token,offer_kind)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8::int,$9::int,$10::int,$11::int,$12::int,$13::int,'offered',$14,$14,$15,$16,$17::int,$18,$19::int,$20,$21,'succession'
  WHERE EXISTS (SELECT 1 FROM orders WHERE id=$20 AND succession_token=$21)
    AND (SELECT COALESCE(SUM(quantity),0) FROM orders WHERE listing_id=$2 AND buyer_id=$4 AND status<>'cancelled') + $8::int <= $22::int
    AND NOT EXISTS (SELECT 1 FROM orders WHERE listing_id=$2 AND buyer_id=$4 AND status IN ('cancelled','offered'))`;
// Offers the freed quantity of a cancelled order to the next eligible bids.
// Exactly once per cancelled order (succession_token claim); re-drivable.
export async function succeed(query: Query, batch: Batch, orderId: string, now: string, opts: { noSuccession?: boolean } = {}) {
  const o = (await query<{
    id: string; listing_id: string; seller_id: string; buyer_id: string; quantity: number; succession_round: number;
    product_title: string; image: string; unit: string; offer_kind: string | null;
  }>("SELECT id, listing_id, seller_id, buyer_id, quantity, succession_round, product_title, image, unit, offer_kind FROM orders WHERE id=$1 AND status='cancelled' AND succession_token IS NULL", [orderId]))[0];
  if (!o) return null;
  const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1", [o.listing_id]))[0];
  if (!a) return null;
  // A below-reserve offer that the buyer turned down (or let lapse) simply fails:
  // every other bid is lower still, so there is no one to pass it to.
  const belowReserve = o.offer_kind === "below_reserve";
  const eligible = successionEnabled() && !opts.noSuccession && !belowReserve && a.succession_enabled && a.status === "won" && !!a.succession_until && now < a.succession_until &&
    o.succession_round < SUCCESSION_MAX_ROUNDS;
  let fills: { bid: AllocBid; qty: number }[] = [];
  const capacityBase = new Map<string, number>();
  if (eligible) {
    const excluded = new Set(
      (await query<{ buyer_id: string }>("SELECT DISTINCT buyer_id FROM orders WHERE listing_id=$1 AND status IN ('cancelled','offered')", [o.listing_id]))
        .map((r) => r.buyer_id),
    );
    excluded.add(a.seller_id);
    // Anyone the penalty gate would block (own or same-business penalty) could not accept.
    const bidderIds = (await query<{ bidder_id: string }>("SELECT DISTINCT bidder_id FROM bids WHERE listing_id=$1", [o.listing_id])).map((r) => r.bidder_id);
    for (const id of bidderIds) if (!excluded.has(id) && (await penaltyDue(query, id)) > 0) excluded.add(id);
    const taken = new Map(
      (await query<{ buyer_id: string; q: number }>("SELECT buyer_id, COALESCE(SUM(quantity),0)::int AS q FROM orders WHERE listing_id=$1 AND status<>'cancelled' GROUP BY buyer_id", [o.listing_id]))
        .map((r) => [r.buyer_id, r.q]),
    );
    let candidates: AllocBid[];
    if (a.mode === "partial") {
      candidates = (await query<StandingRow>(
        "SELECT id, bidder_id, amount, quantity, created_at FROM bids WHERE listing_id=$1 AND quantity IS NOT NULL AND status IN ('partial','lost')",
        [o.listing_id],
      )).map((r) => ({ id: r.id, bidderId: r.bidder_id, unitPrice: r.amount, quantity: r.quantity, createdAt: r.created_at,
        capacity: r.quantity - (taken.get(r.bidder_id) ?? 0) }));
    } else {
      candidates = (await query<{ id: string; bidder_id: string; amount: number; created_at: string }>(
        "SELECT DISTINCT ON (bidder_id) id, bidder_id, amount, created_at FROM bids WHERE listing_id=$1 AND quantity IS NULL ORDER BY bidder_id, amount DESC, created_at ASC",
        [o.listing_id],
      )).map((r) => ({ id: r.id, bidderId: r.bidder_id, unitPrice: r.amount, quantity: a.quantity, createdAt: r.created_at,
        capacity: (taken.get(r.bidder_id) ?? 0) > 0 ? 0 : a.quantity }));
    }
    const minLot = a.mode === "partial" ? a.min_lot : a.quantity;
    candidates = candidates.filter((c) => !excluded.has(c.bidderId) && c.unitPrice >= a.reserve_price && (c.capacity ?? 0) >= minLot);
    for (const c of candidates) capacityBase.set(c.bidderId, c.quantity);
    fills = allocate(candidates, o.quantity, minLot, a.reserve_price).fills;
  }
  const { category } = await listingInfo(query, o.listing_id);
  const bps = feeRateBps(category);
  const expires = plus(now, OFFER_HOURS * 3600000);
  for (let attempt = 0; ; attempt++) {
    const tok = crypto.randomUUID();
    const successors = fills.map((f) => {
      const amount = f.qty * f.bid.unitPrice;
      const fee = feeFor(amount, bps);
      return { bid: f.bid, qty: f.qty, orderId: crypto.randomUUID(), amount, fee, net: amount - fee, code: depositCode() };
    });
    const statements: Statement[] = [
      lockStatement(o.listing_id),
      {
        sql: "UPDATE orders SET succession_token=$2, succession_at=$3 WHERE id=$1 AND status='cancelled' AND succession_token IS NULL RETURNING listing_id, quantity, succession_round",
        params: [o.id, tok, now],
      },
    ];
    for (const s of successors)
      statements.push({
        sql: successorInsertSql,
        params: [s.orderId, o.listing_id, o.seller_id, s.bid.bidderId, o.product_title, o.image, o.unit, s.qty, s.bid.unitPrice, s.amount, bps, s.fee, s.net,
          expires, now, s.bid.id, s.bid.quantity, s.code, o.succession_round + 1, o.id, tok, capacityBase.get(s.bid.bidderId) ?? s.bid.quantity],
      });
    // Recompute from live orders (offered included) so a re-driven claim can never double-free.
    statements.push({
      sql: `UPDATE auctions a SET sold_quantity = s.q, unsold_quantity = GREATEST(a.quantity - s.q - a.relisted_quantity, 0),
              status = CASE WHEN s.q = 0 AND a.status = 'won' THEN 'unsold' ELSE a.status END
            FROM (SELECT COALESCE(SUM(quantity),0)::int AS q FROM orders WHERE listing_id=$1 AND status<>'cancelled') s
            WHERE a.listing_id=$1 AND EXISTS (SELECT 1 FROM orders WHERE id=$2 AND succession_token=$3)`,
      params: [o.listing_id, o.id, tok],
    });
    statements.push({
      sql: listingUnsoldSql + " AND EXISTS (SELECT 1 FROM orders WHERE id=$2 AND succession_token=$3)",
      params: [o.listing_id, o.id, tok],
    });
    let results;
    try {
      results = await batch(statements);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 3) throw error;
      continue;
    }
    if (results[1].rowCount !== 1) return null;
    const offered = await query<{ id: string; buyer_id: string; quantity: number; unit_price: number; amount: number; deposit_code: string; offer_expires_at: string }>(
      "SELECT id, buyer_id, quantity, unit_price, amount, deposit_code, offer_expires_at FROM orders WHERE parent_order_id=$1 AND batch_token=$2",
      [o.id, tok],
    );
    const deadline = new Date(expires).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    for (const s of offered)
      await notify(query, [s.buyer_id], {
        kind: "succession_offer",
        title: `차순위 낙찰 제안 · ${o.product_title}`,
        body: `앞선 낙찰자가 입금하지 않아 내 입찰 ${won(s.unit_price)}원 × ${won(s.quantity)}${o.unit} = ${won(s.amount)}원으로 낙찰받을 수 있습니다. ${deadline}까지 수락하면 ${PAYMENT_HOURS}시간 입금 기한이 시작됩니다.`,
        refType: "order", refId: s.id,
      }, now);
    const offeredQty = offered.reduce((s, r) => s + r.quantity, 0);
    // A re-driven claim whose offers already exist (from an earlier attempt) must not report exhaustion.
    const priorOffers = offered.length ? 0 : (await query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM orders WHERE parent_order_id=$1 AND status<>'cancelled'", [o.id],
    ))[0].n;
    if (!offered.length && priorOffers > 0) return { offered: 0, quantity: 0 };
    // No runner-up step at all (switched off, or not applicable): the cancel notices say what happened.
    if (!offered.length && (belowReserve || opts.noSuccession || !successionEnabled())) return { offered: 0, quantity: 0 };
    await notify(query, [o.seller_id], offered.length
      ? {
        kind: "succession_offered",
        title: `차순위 제안 중 · ${o.product_title}`,
        body: `${offered.length}명에게 ${won(offeredQty)}${o.unit} 차순위 제안 중입니다. ${deadline}까지 수락하지 않으면 다음 후보에게 넘어갑니다.`,
        refType: "listing", refId: o.listing_id,
      }
      : {
        kind: "succession_exhausted",
        title: `차순위 후보 없음 · ${o.product_title}`,
        body: `차순위 후보가 없어 ${won(o.quantity)}${o.unit}은 미판매로 남았습니다. 내 재고에서 다시 경매할 수 있어요.`,
        refType: "listing", refId: o.listing_id,
      }, now);
    return { offered: offered.length, quantity: offeredQty };
  }
}
// One shared payment confirmation for admin confirm, admin match and the webhook.
export async function markPaid(batch: Batch, orderId: string, now: string, by: "admin" | "webhook", depositId: string | null = null, depositor: string | null = null) {
  const statements: Statement[] = [{
    sql: `UPDATE orders SET status='paid', paid_at=$2, paid_by=$3, deposit_id=$4::text, depositor=COALESCE(depositor,$5::text)
          WHERE id=$1 AND status IN ('awaiting_payment','payment_reported') AND deposit_id IS NULL
          RETURNING seller_id, buyer_id, product_title, amount`,
    params: [orderId, now, by, depositId, depositor],
  }];
  if (depositId)
    statements.push({
      sql: `UPDATE deposits SET status='matched', order_id=$1, resolved_at=$2, resolved_by=$3
            WHERE id=$4 AND status IN ('received','unmatched') AND EXISTS (SELECT 1 FROM orders WHERE id=$1 AND deposit_id=$4)`,
      params: [orderId, now, by, depositId],
    });
  const results = await batch(statements);
  return (results[0].rows[0] as { seller_id: string; buyer_id: string; product_title: string; amount: number } | undefined) ?? null;
}
export async function notifyPaid(query: Query, order: { seller_id: string; buyer_id: string; product_title: string }, orderId: string, now: string) {
  await notify(query, [order.seller_id, order.buyer_id], {
    kind: "contact_revealed", title: `연락처 공개 · ${order.product_title}`,
    body: "입금이 확인되어 거래 상대의 상호와 연락처가 공개되었습니다. 인수 일정과 배송을 직접 협의해 주세요.", refType: "order", refId: orderId,
  }, now);
}
// Runs succession for a cancelled order and sends the cancellation notices.
export async function afterCancel(
  query: Query, batch: Batch, o: CancelledOrder, now: string,
  reason: "payment_overdue" | "offer_expired" | "offer_declined" | "admin" | "dispute", detail?: string,
  opts: { noSuccession?: boolean } = {},
) {
  // The penalty row itself was written with the cancel (cancelOrder penaltyBatch); this only tells the buyer.
  const penaltyRow = reason === "payment_overdue"
    ? (await query<{ penalty_amount: number }>("SELECT penalty_amount FROM disputes WHERE order_id=$1 AND kind='no_payment' AND penalty_status='due'", [o.id]))[0]
    : undefined;
  if (penaltyRow) {
    const penalty = penaltyRow.penalty_amount;
    await notify(query, [o.buyer_id], {
      kind: "penalty_due", title: `위약금 부과 · ${o.product_title}`,
      body: `낙찰 후 입금하지 않아 위약금 ${won(penalty)}원(낙찰가의 ${PENALTY_BPS / 100}%)이 부과되었습니다. 납부가 확인될 때까지 입찰과 재고 등록이 제한됩니다.`,
      refType: "order", refId: o.id,
    }, now);
  }
  const result = await succeed(query, batch, o.id, now, opts);
  if (o.offer_kind === "below_reserve" && (reason === "offer_expired" || reason === "offer_declined")) {
    await notify(query, [o.buyer_id], {
      kind: "order_cancelled", title: `구매 의사 확인 종료 · ${o.product_title}`,
      body: reason === "offer_expired" ? "구매 의사 확인 기한이 지나 거래가 성사되지 않았습니다." : "구매하지 않기로 해 거래가 종료되었습니다.",
      refType: "order", refId: o.id,
    }, now);
    await notify(query, [o.seller_id], {
      kind: "auction_unsold", title: `유찰 · ${o.product_title}`,
      body: `${reason === "offer_expired" ? "최고 입찰자가 기한 내 구매 의사를 밝히지 않아" : "최고 입찰자가 제시가 구매를 거절해"} 유찰되었습니다. 조건을 조정해 다시 경매할 수 있어요.`,
      refType: "listing", refId: o.listing_id,
    }, now);
    return result;
  }
  const sellerTail = result && result.offered > 0 ? "차순위 입찰자에게 제안 중입니다." : "재고를 다시 경매에 올릴 수 있어요.";
  if (reason === "payment_overdue") {
    await notify(query, [o.buyer_id], { kind: "order_cancelled", title: `주문 취소 · ${o.product_title}`, body: "입금 기한이 지나 낙찰이 취소되었습니다.", refType: "order", refId: o.id }, now);
    await notify(query, [o.seller_id], { kind: "order_cancelled", title: `입금 기한 초과 · ${o.product_title}`, body: `구매자가 기한 내 입금하지 않아 낙찰이 취소되었습니다. ${sellerTail}`, refType: "order", refId: o.id }, now);
  } else if (reason === "offer_expired") {
    await notify(query, [o.buyer_id], { kind: "order_cancelled", title: `제안 만료 · ${o.product_title}`, body: "차순위 낙찰 제안을 기한 내 수락하지 않아 만료되었습니다.", refType: "order", refId: o.id }, now);
    // With no further offer, the seller needs to know the lot is back.
    if (!result || result.offered === 0)
      await notify(query, [o.seller_id], { kind: "order_cancelled", title: `차순위 제안 만료 · ${o.product_title}`, body: `구매자가 기한 내 수락하지 않았습니다. ${sellerTail}`, refType: "order", refId: o.id }, now);
  } else if (reason === "offer_declined") {
    await notify(query, [o.seller_id], { kind: "order_cancelled", title: `차순위 제안 거절 · ${o.product_title}`, body: `구매자가 차순위 제안을 거절했습니다. ${sellerTail}`, refType: "order", refId: o.id }, now);
  } else if (reason === "dispute") {
    await notify(query, [o.seller_id, o.buyer_id], { kind: "order_cancelled", title: `분쟁 조정으로 거래 취소 · ${o.product_title}`, body: `운영자가 분쟁을 검토해 거래를 취소했습니다. ${detail ?? ""}`, refType: "order", refId: o.id }, now);
  } else {
    await notify(query, [o.seller_id, o.buyer_id], { kind: "order_cancelled", title: `주문 취소 · ${o.product_title}`, body: `운영자가 주문을 취소했습니다. 사유: ${detail ?? ""} ${sellerTail}`, refType: "order", refId: o.id }, now);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Time-based transitions. Safe to call from any request: every state change
// is a conditional UPDATE, so concurrent callers cannot double-run.
// `scope.ownerIds` restricts the sweep to those sellers' auctions and orders.
// Verification scripts pass their QA sellers so a time-injected run can never
// touch a real listing in the shared database; production calls pass nothing.
// `scope.listingIds` limits it to specific listings (the live auction endpoint).
export type ProcessScope = { ownerIds?: string[]; listingIds?: string[] };
const openDispute = "NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id=orders.id AND d.status='open')";
export async function processAuctions(query: Query, nowDate = new Date(), batch?: Batch, scope: ProcessScope = {}) {
  const now = nowDate.toISOString();
  const result = { alerted: 0, won: 0, unsold: 0, deciding: 0, decisionsExpired: 0, expiredOrders: 0, expiredOffers: 0, succeeded: 0, autoCompleted: 0 };
  const owners = scope.ownerIds ?? null;
  const listings = scope.listingIds ?? null;
  const inScope = "($2::text[] IS NULL OR seller_id = ANY($2::text[])) AND ($3::text[] IS NULL OR listing_id = ANY($3::text[]))";
  const midpoint = await query<AuctionRow>(
    `SELECT * FROM auctions WHERE status='active' AND midpoint_alerted_at IS NULL AND midpoint_at<=$1 AND ends_at>$1 AND ${inScope} LIMIT 100`,
    [now, owners, listings],
  );
  for (const a of midpoint) {
    const marked = await query(
      "UPDATE auctions SET midpoint_alerted_at=$2 WHERE listing_id=$1 AND midpoint_alerted_at IS NULL AND status='active' RETURNING listing_id",
      [a.listing_id, now],
    );
    if (!marked.length) continue;
    let body: string;
    if (a.mode === "partial") {
      const s = partialSummary(await standingBids(query, a.listing_id), a.quantity, a.min_lot, a.reserve_price);
      if (s.sellableQty >= a.quantity) continue;
      body = s.subscribedQty === 0
        ? "경매 기간의 절반이 지났지만 아직 입찰이 없습니다. 최저 매각가를 낮추면 낙찰 가능성이 높아집니다."
        : s.subscribedQty < a.quantity
          ? `경매 기간의 절반이 지났습니다. 신청 수량 ${won(s.subscribedQty)}/${won(a.quantity)}${a.unit}, 최저 매각가 이상 낙찰 예정은 ${won(s.sellableQty)}${a.unit}입니다. 최저가를 낮추거나 마감을 기다려 주세요.`
          : `경매 기간의 절반이 지났습니다. 최저 매각가를 ${won(s.fillPrice ?? 0)}원 이하로 낮추면 현재 입찰로 전량 낙찰됩니다.`;
    } else {
      if (a.current_price !== null && a.current_price >= a.reserve_price) continue;
      body = a.current_price === null
        ? "경매 기간의 절반이 지났지만 아직 입찰이 없습니다. 최저 매각가를 낮추면 낙찰 가능성이 높아집니다."
        : `경매 기간의 절반이 지났지만 최고 입찰가 ${won(a.current_price)}원이 최저 매각가보다 낮습니다. 최저 매각가를 낮추면 현재 입찰로 낙찰될 수 있어요.`;
    }
    const { title } = await listingInfo(query, a.listing_id);
    await notify(query, [a.seller_id], { kind: "reserve_alert", title: `최저 매각가 검토 · ${title}`, body, refType: "listing", refId: a.listing_id }, now);
    result.alerted++;
  }
  const ended = await query<AuctionRow>(
    `SELECT * FROM auctions WHERE status='active' AND ends_at<=$1 AND ${inScope} LIMIT 100`,
    [now, owners, listings],
  );
  for (const a of ended) {
    const closed = await closeAuction(query, a, now, "expire", batch);
    if (closed?.status === "won") result.won++;
    else if (closed?.status === "deciding") result.deciding++;
    else if (closed) result.unsold++;
  }
  const deciding = await query<{ listing_id: string }>(
    `SELECT listing_id FROM auctions WHERE status='deciding' AND decision_due_at<=$1 AND ${inScope} LIMIT 100`,
    [now, owners, listings],
  );
  for (const d of deciding) {
    const r = await resolveBelowReserve(query, requireBatch(batch), d.listing_id, now, { accept: false, expired: true });
    if (r.ok) result.decisionsExpired++;
  }
  const overdue = await query<{ id: string }>(
    `SELECT id FROM orders WHERE status='awaiting_payment' AND payment_due_at<=$1 AND ${inScope} AND ${openDispute} LIMIT 100`,
    [now, owners, listings],
  );
  for (const row of overdue) {
    const o = await cancelOrder(query, row.id, now, "payment_overdue", ["awaiting_payment"], {
      noOpenDispute: true, penaltyBatch: penalizeNonpayment() ? requireBatch(batch) : undefined,
    });
    if (!o) continue;
    await afterCancel(query, requireBatch(batch), o, now, "payment_overdue");
    result.expiredOrders++;
  }
  const expiredOffers = await query<{ id: string }>(
    `SELECT id FROM orders WHERE status='offered' AND offer_expires_at<=$1 AND ${inScope} LIMIT 100`,
    [now, owners, listings],
  );
  for (const row of expiredOffers) {
    const o = await cancelOrder(query, row.id, now, "offer_expired", ["offered"], { expiredOnly: true });
    if (!o) continue;
    await afterCancel(query, requireBatch(batch), o, now, "offer_expired");
    result.expiredOffers++;
  }
  if (batch) {
    const pending = await query<{ id: string }>(
      `SELECT id FROM orders WHERE status='cancelled' AND succession_token IS NULL AND cancelled_at >= $1 AND ${inScope} LIMIT 100`,
      [plus(now, -30 * 86400000), owners, listings],
    );
    for (const row of pending) {
      const r = await succeed(query, batch, row.id, now);
      if (r) result.succeeded++;
    }
  }
  // Buyer neither confirmed receipt nor opened a dispute: receipt is assumed.
  const toComplete = await query<{ id: string }>(
    `SELECT id FROM orders WHERE status='shipped' AND auto_complete_at<=$1 AND ${inScope} AND ${openDispute} LIMIT 100`,
    [now, owners, listings],
  );
  for (const row of toComplete) {
    const done = await query<{ seller_id: string; buyer_id: string; product_title: string; net: number }>(
      `UPDATE orders SET status='completed', completed_at=$2 WHERE id=$1 AND status='shipped' AND auto_complete_at<=$2 AND ${openDispute}
       RETURNING seller_id, buyer_id, product_title, net`,
      [row.id, now],
    );
    if (!done.length) continue;
    const o = done[0];
    await notify(query, [o.buyer_id], {
      kind: "completed", title: `자동 수령 확인 · ${o.product_title}`,
      body: `출고 후 ${AUTO_CONFIRM_DAYS}일 동안 수령 확인이나 문제 신고가 없어 거래가 자동으로 완료되었습니다.`, refType: "order", refId: row.id,
    }, now);
    await notify(query, [o.seller_id], {
      kind: "completed", title: `거래 완료 · ${o.product_title}`,
      body: `구매자 수령이 자동 확인되었습니다. 수수료를 제외한 ${won(o.net)}원이 정산 계좌로 지급됩니다.`, refType: "order", refId: row.id,
    }, now);
    await notify(query, adminIds(), {
      kind: "admin_settle", title: `정산 대기 · ${o.product_title}`,
      body: `자동 수령 확인. 공급자 정산액 ${won(o.net)}원. 관리 탭에서 정산을 완료해 주세요.`, refType: "order", refId: row.id,
    }, now);
    result.autoCompleted++;
  }
  return result;
}
