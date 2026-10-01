import { getUser } from "@/lib/auth/server";
import { database, bucket, query, batch } from "@/db";
import { samples, categories, type Product, daysLeft } from "@/lib/catalog";
import { z } from "zod";
import { businessRegion } from "@/lib/business-region";
import { saveBusinessProfile } from "@/lib/business-profile";
import {
  AUCTION_DAYS,
  EXTENSION_MINUTES,
  AUTO_CONFIRM_DAYS,
  MONEY_CAP,
  PAYMENT_HOURS,
  PENALTY_BPS,
  belowReservePolicy,
  successionEnabled,
  penalizeNonpayment,
  placeWholeBid,
  resolveBelowReserve,
  adminIds,
  afterCancel,
  allocate,
  auctionWindow,
  cancelOrder,
  closeAuction,
  depositCode,
  feeRateBps,
  feeRateTable,
  isUniqueViolation,
  kstDate,
  lockStatement,
  markPaid,
  minimumBid,
  notify,
  notifyPaid,
  partialMinimumBid,
  partialSummary,
  processAuctions,
  standingBids,
  type AllocBid,
  type AuctionRow,
  type Statement,
} from "@/lib/auction-core";
import { recordDeposit, matchDeposit, rematchDeposits } from "@/lib/deposits";
import { openDispute, respondDispute, resolveDispute, settlePenalty } from "@/lib/disputes";
import { businessNumberValid, fraudSignals, ipHashFrom, ntsBusinessStatus, penaltyDue, recordActivity, sameBusiness } from "@/lib/trust";
import type { Auction, Bid, Deposit, Dispute, Order, RevenueRow } from "@/lib/models";
import { installPushHook, pushConfigured, validPushEndpoint } from "@/lib/push";
export const dynamic = "force-dynamic";
installPushHook();
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
const uid = z.string().min(1).max(100);
const regions = [
  "서울",
  "경기",
  "인천",
  "충청",
  "경상",
  "전라",
  "강원",
  "제주",
] as const;
const price = z.number().int().min(1).max(100000000);
const quantity = z.number().int().min(1).max(1000000);
const auctionMode = z.enum(["whole", "partial"]).default("whole");
const listingSchema = z
  .object({
    title: z.string().trim().min(2).max(100),
    category: z.enum(categories.slice(1) as [string, ...string[]]),
    price,
    originalPrice: price,
    stock: quantity,
    moq: quantity,
    unit: z.enum(["개", "박스", "장", "봉", "병", "세트", "팔레트"]),
    region: z.enum(regions),
    condition: z.enum([
      "새상품",
      "재고정리",
      "시즌오프",
      "소비기한 임박",
      "박스훼손",
      "패키지 변경",
    ]),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    image: z.string().regex(/^\/api\/images\/[a-f0-9-]{36}$/),
    description: z.string().trim().min(10).max(2000),
    saleType: z.enum(["quote", "auction"]).default("quote"),
    auctionDays: z.number().int().optional(),
    reservePrice: price.optional(),
    auctionMode,
    minLot: z.number().int().optional(),
    successionEnabled: z.boolean().default(true),
    instantPrice: price.optional().nullable(),
  })
  .refine((v) => v.moq <= v.stock, {
    message: "최소 수량은 전체 재고 이하로 입력해 주세요.",
  })
  .refine((v) => v.price <= v.originalPrice, {
    message: "희망가는 정상가 이하로 입력해 주세요.",
  })
  .superRefine((v, ctx) => {
    if (v.saleType === "auction") {
      if (!v.auctionDays || !(AUCTION_DAYS as readonly number[]).includes(v.auctionDays))
        ctx.addIssue({ code: "custom", message: "경매 기간을 선택해 주세요." });
      if (!v.reservePrice)
        ctx.addIssue({ code: "custom", message: "최저 매각가를 입력해 주세요." });
      else if (v.reservePrice < v.price)
        ctx.addIssue({ code: "custom", message: "최저 매각가는 시작가 이상으로 입력해 주세요." });
      else if (v.reservePrice > v.originalPrice)
        ctx.addIssue({ code: "custom", message: "최저 매각가는 정상가 이하로 입력해 주세요." });
      if (v.price * v.stock > MONEY_CAP)
        ctx.addIssue({ code: "custom", message: "시작가 × 수량이 너무 큽니다. 수량을 나누어 등록해 주세요." });
      if (v.instantPrice) {
        if (v.auctionMode === "partial")
          ctx.addIssue({ code: "custom", message: "즉시체결가는 전량 경매에서만 쓸 수 있습니다." });
        else if (v.reservePrice && v.instantPrice < v.reservePrice)
          ctx.addIssue({ code: "custom", message: "즉시체결가는 최저 매각가 이상으로 입력해 주세요." });
        else if (v.instantPrice > v.originalPrice)
          ctx.addIssue({ code: "custom", message: "즉시체결가는 정상가 이하로 입력해 주세요." });
        else if (v.instantPrice * v.stock > MONEY_CAP)
          ctx.addIssue({ code: "custom", message: "즉시체결가 × 수량이 너무 큽니다." });
      }
      if (v.auctionMode === "partial") {
        if (!v.minLot || v.minLot < 1 || v.minLot > v.stock)
          ctx.addIssue({ code: "custom", message: "최소 입찰 단위는 1 이상, 전량 수량 이하로 입력해 주세요." });
        else if (v.stock % v.minLot !== 0)
          ctx.addIssue({ code: "custom", message: "전량 수량은 최소 입찰 단위의 배수여야 합니다." });
      }
      return;
    }
    const d = v.deadline;
    if (
      !d ||
      !Number.isFinite(Date.parse(d)) ||
      new Date(d + "T00:00:00Z").toISOString().slice(0, 10) !== d ||
      daysLeft(d) < 0 ||
      daysLeft(d) > 730
    )
      ctx.addIssue({ code: "custom", message: "마감일은 오늘부터 2년 이내로 선택해 주세요." });
  });
const profileSchema = z.object({
  company: z.string().trim().min(2).max(60),
  businessNumber: z
    .string()
    .regex(/^\d{10}$/, "사업자등록번호 10자리를 입력해 주세요.")
    .refine(businessNumberValid, "사업자등록번호가 올바르지 않습니다. 사업자등록증의 번호를 다시 확인해 주세요."),
  phone: z.string().regex(/^0\d{8,10}$/, "연락처를 확인해 주세요."),
  businessAddress: z.string().trim().min(8).max(200).refine(
    value => businessRegion(value) !== null,
    "시·도와 시·군·구를 포함한 사업자 주소를 입력해 주세요. 예: 서울특별시 강남구 테헤란로 123",
  ),
  payoutBank: z.string().trim().max(30).optional().default(""),
  payoutAccount: z.string().trim().regex(/^[\d-]{0,30}$/, "정산 계좌번호는 숫자와 -만 입력해 주세요.").optional().default(""),
  payoutHolder: z.string().trim().max(40).optional().default(""),
}).refine(
  (v) => (!v.payoutBank && !v.payoutAccount && !v.payoutHolder) || (v.payoutBank && v.payoutAccount.replace(/-/g, "").length >= 6 && v.payoutHolder),
  { message: "정산 계좌는 은행, 계좌번호, 예금주를 모두 입력해 주세요." },
);
async function findProduct(id: string): Promise<Product | null> {
  const sample = samples.find((p) => p.id === id);
  if (sample) return sample;
  const row = await database()
    .prepare(
      "SELECT l.document, l.owner_id, p.public_alias FROM listings l LEFT JOIN profiles p ON p.user_id=l.owner_id WHERE l.id = ? AND l.status = ?",
    )
    .bind(id, "active")
    .first<{ document: string; owner_id: string; public_alias: string | null }>();
  return row ? { ...JSON.parse(row.document), seller: row.public_alias || "사업자 정보 등록 대기", ownerId: row.owner_id } : null;
}
const offerFields =
  "id, buyer_id AS buyerId, seller_id AS sellerId, product_id AS productId, product_title AS productTitle, image, unit, quantity, price, shipping, note, status, sample, created_at AS createdAt";
const orderFields = `o.id, o.listing_id AS "listingId", o.seller_id AS "sellerId", o.buyer_id AS "buyerId",
  COALESCE((SELECT public_alias FROM profiles WHERE user_id=o.buyer_id),'구매자') AS "buyerAlias",
  COALESCE((SELECT public_alias FROM profiles WHERE user_id=o.seller_id),'공급자') AS "sellerAlias",
  o.product_title AS "productTitle", o.image, o.unit, o.quantity, o.unit_price AS "unitPrice", o.amount,
  o.fee_rate AS "feeRate", o.fee, o.net, o.status, o.depositor, o.payment_due_at AS "paymentDueAt",
  o.reported_at AS "reportedAt", o.paid_at AS "paidAt", o.shipped_at AS "shippedAt", o.completed_at AS "completedAt",
  o.settled_at AS "settledAt", o.cancelled_at AS "cancelledAt", o.cancel_reason AS "cancelReason", o.created_at AS "createdAt",
  o.deposit_code AS "depositCode", o.paid_by AS "paidBy", o.succession_round AS "successionRound", o.parent_order_id AS "parentOrderId",
  o.bid_quantity AS "bidQuantity", o.offer_expires_at AS "offerExpiresAt", o.offer_kind AS "offerKind", o.ship_photos AS "shipPhotos",
  o.auto_complete_at AS "autoCompleteAt", o.refund_amount AS "refundAmount", o.refund_paid AS "refundPaid", o.refunded_at AS "refundedAt"`;
const revealed = new Set(["paid", "shipped", "completed", "settled"]);
type ProfileRow = { user_id: string; company: string; phone: string; business_address: string | null; public_alias: string | null; payout_bank: string | null; payout_account: string | null; payout_holder: string | null };
// `privileged` = the seller or an admin. Buyers never receive the reserve price, whether
// it has been met, or the close reason: any of them would hint at the hidden reserve.
function auctionView(a: AuctionRow, viewerId: string | null, myTop: number | null, owner: boolean, standing: AllocBid[], bidderCount = 0, privileged = owner): Auction {
  const view: Auction = {
    listingId: a.listing_id,
    quantity: a.quantity,
    unit: a.unit,
    startPrice: a.start_price,
    currentPrice: a.current_price,
    bidCount: a.bid_count,
    startsAt: a.starts_at,
    midpointAt: a.midpoint_at,
    endsAt: a.ends_at,
    status: a.status as Auction["status"],
    extendedCount: a.extended_count,
    instantPrice: a.mode === "whole" ? a.instant_price : null,
    bidderCount,
    mode: a.mode,
    minLot: a.min_lot,
    soldQuantity: a.sold_quantity,
    unsoldQuantity: a.unsold_quantity,
    successionEnabled: a.succession_enabled && successionEnabled(),
    cutoffPrice: null,
    subscribedQuantity: 0,
    filledQuantity: 0,
    remainingQuantity: a.quantity,
  };
  if (a.mode === "partial") {
    const s = partialSummary(standing, a.quantity, a.min_lot, a.reserve_price);
    if (privileged) view.reserveMet = s.reserveMet;
    view.cutoffPrice = s.cutoff;
    view.subscribedQuantity = s.subscribedQty;
    view.filledQuantity = s.filledQty;
    view.remainingQuantity = s.remainingQty;
    view.minimumBid = partialMinimumBid(a, standing.filter((b) => b.bidderId !== viewerId), a.quantity, a.min_lot);
    if (privileged) {
      view.sellableQuantity = s.sellableQty;
      view.fillPrice = s.fillPrice;
    }
    if (viewerId) {
      const mine = standing.find((b) => b.bidderId === viewerId);
      if (mine) {
        const allocated = s.allocatedBy.get(mine.id) ?? 0;
        view.myBid = { id: mine.id, unitPrice: mine.unitPrice, quantity: mine.quantity, allocated, state: allocated >= mine.quantity ? "full" : allocated > 0 ? "partial" : "out" };
      }
    }
  } else {
    view.minimumBid = minimumBid(a);
    if (privileged) view.reserveMet = a.current_price !== null && a.current_price >= a.reserve_price;
  }
  if (privileged) {
    view.reservePrice = a.reserve_price;
    view.midpointAlertedAt = a.midpoint_alerted_at;
    view.closeReason = a.close_reason;
    view.decisionStage = a.decision_stage;
    view.decisionDueAt = a.decision_due_at;
  }
  if (viewerId) {
    view.myTopBid = myTop;
    view.leading = a.current_bidder_id === viewerId;
  }
  // Only the seller, admins and the top bidder (who is asked to buy) learn that the auction
  // ended below the reserve. Everyone else sees an ordinary close with a winner.
  if (!privileged && a.status === "deciding" && a.current_bidder_id !== viewerId) {
    view.status = "won";
    view.soldQuantity = a.quantity;
    view.unsoldQuantity = 0;
  }
  return view;
}
async function attachContacts(orders: Order[], viewerId: string, isAdmin: boolean) {
  const ids = new Set<string>();
  for (const o of orders) {
    if (revealed.has(o.status)) ids.add(o.buyerId === viewerId ? o.sellerId : o.buyerId);
    if (isAdmin && ["completed", "settled"].includes(o.status)) ids.add(o.sellerId);
  }
  if (!ids.size) return orders;
  const rows = await query<ProfileRow>(
    "SELECT user_id, company, phone, business_address, public_alias, payout_bank, payout_account, payout_holder FROM profiles WHERE user_id = ANY($1::text[])",
    [[...ids]],
  );
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  return orders.map((o) => {
    const next = { ...o };
    if (revealed.has(o.status)) {
      const other = byId.get(o.buyerId === viewerId ? o.sellerId : o.buyerId);
      next.counterpart = other
        ? { alias: other.public_alias || "거래 상대", company: other.company, phone: other.phone, businessAddress: other.business_address || "" }
        : null;
    }
    if (isAdmin && ["completed", "settled"].includes(o.status)) {
      const s = byId.get(o.sellerId);
      next.payout = s?.payout_account ? { bank: s.payout_bank || "", account: s.payout_account, holder: s.payout_holder || "" } : null;
    }
    return next;
  });
}
// Orders created before deposit codes existed get one on first read.
async function backfillDepositCodes(orders: Order[]) {
  for (const o of orders) {
    if (o.depositCode || !["awaiting_payment", "payment_reported"].includes(o.status)) continue;
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = depositCode();
      try {
        const rows = await query<{ id: string }>(
          "UPDATE orders SET deposit_code=$2 WHERE id=$1 AND deposit_code IS NULL AND status IN ('awaiting_payment','payment_reported') RETURNING id",
          [o.id, code],
        );
        if (rows.length) o.depositCode = code;
        break;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }
  return orders;
}
const revenueSelect = `
  COUNT(*) FILTER (WHERE status NOT IN ('cancelled','offered'))::int AS orders,
  COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('cancelled','offered')),0)::int AS gmv,
  COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','shipped','completed','settled')),0)::int AS paid,
  COALESCE(SUM(amount - refund_paid) FILTER (WHERE status IN ('paid','shipped','completed')),0)::int AS held,
  COALESCE(SUM(fee) FILTER (WHERE status IN ('completed','settled')),0)::int AS fee,
  COALESCE(SUM(net) FILTER (WHERE status='completed'),0)::int AS payable,
  COALESCE(SUM(net) FILTER (WHERE status='settled'),0)::int AS settled,
  COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled`;
async function revenueSummary() {
  const [months, totals] = await Promise.all([
    query<RevenueRow>(
      `SELECT to_char((created_at::timestamptz) AT TIME ZONE 'Asia/Seoul','YYYY-MM') AS month, ${revenueSelect}
       FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    ),
    query<RevenueRow>(`SELECT 'total' AS month, ${revenueSelect} FROM orders`),
  ]);
  const extras = (await query<{ penaltiesCollected: number; penaltiesDue: number; refundsPending: number; refundsPaid: number }>(
    `SELECT
       (SELECT COALESCE(SUM(penalty_amount),0)::int FROM disputes WHERE penalty_status='paid') AS "penaltiesCollected",
       (SELECT COALESCE(SUM(penalty_amount),0)::int FROM disputes WHERE penalty_status='due') AS "penaltiesDue",
       (SELECT COALESCE(SUM(refund_amount - refund_paid),0)::int FROM orders WHERE refund_amount > refund_paid) AS "refundsPending",
       (SELECT COALESCE(SUM(refund_paid),0)::int FROM orders) AS "refundsPaid"`,
  ))[0];
  return { months, total: totals[0], extras };
}
type BidRow = { id: string; listing_id: string; bidder_id: string; amount: number; quantity: number | null; status: string; allocated_quantity: number; created_at: string; public_alias: string | null };
function standingFrom(rows: BidRow[], listingId: string): AllocBid[] {
  return rows
    .filter((b) => b.listing_id === listingId && b.quantity !== null && b.status === "active")
    .map((b) => ({ id: b.id, bidderId: b.bidder_id, unitPrice: b.amount, quantity: b.quantity!, createdAt: b.created_at }));
}
function safeIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
type ListingRow = { id: string; document: string; owner_id: string; created_at: string; public_alias: string | null; business_status?: string | null; status?: string };
function withPhotos(o: Order): Order {
  return { ...o, shipPhotos: safeIds(o.shipPhotos as unknown), refundAmount: o.refundAmount ?? 0, refundPaid: o.refundPaid ?? 0 };
}
// On a cancelled order the buyer's refund would reveal any penalty kept from it; the seller only needs the outcome.
function forViewer(o: Order, viewerId: string): Order {
  return o.sellerId === viewerId && o.buyerId !== viewerId && o.status === "cancelled" ? { ...o, refundAmount: 0, refundPaid: 0 } : o;
}
const disputeFields = `d.id, d.order_id, d.listing_id, d.opened_by, d.opener_role, d.kind, d.description, d.photos, d.response, d.response_photos,
  d.status, d.resolution, d.refund_amount, d.penalty_party, d.penalty_user_id, d.penalty_amount, d.penalty_status, d.admin_note, d.created_at, d.resolved_at,
  o.product_title, o.amount, o.status AS order_status, o.ship_photos, o.seller_id,
  COALESCE((SELECT public_alias FROM profiles WHERE user_id=o.buyer_id),'구매자') AS buyer_alias,
  COALESCE((SELECT public_alias FROM profiles WHERE user_id=o.seller_id),'공급자') AS seller_alias`;
type DisputeRow = {
  id: string; order_id: string; listing_id: string; opened_by: string; opener_role: Dispute["openerRole"]; kind: Dispute["kind"];
  description: string; photos: string | null; response: string | null; response_photos: string | null; status: Dispute["status"];
  resolution: Dispute["resolution"]; refund_amount: number; penalty_party: Dispute["penaltyParty"]; penalty_user_id: string | null;
  penalty_amount: number; penalty_status: Dispute["penaltyStatus"]; admin_note: string | null; created_at: string; resolved_at: string | null;
  product_title: string; amount: number; order_status: string; ship_photos: string | null; buyer_alias: string; seller_alias: string; seller_id: string;
};
function toDispute(d: DisputeRow, viewerId: string, isAdmin: boolean): Dispute {
  // A penalty is shown only to the party who owes it (and admins).
  const penaltyVisible = isAdmin || d.penalty_user_id === viewerId;
  return {
    id: d.id, orderId: d.order_id, listingId: d.listing_id, openerRole: d.opener_role, mine: d.opened_by === viewerId, kind: d.kind,
    description: d.description, photos: safeIds(d.photos), response: d.response, responsePhotos: safeIds(d.response_photos),
    status: d.status, resolution: d.resolution,
    refundAmount: !isAdmin && d.seller_id === viewerId && d.resolution === "cancel_refund" ? 0 : d.refund_amount,
    penaltyParty: penaltyVisible ? d.penalty_party : null, penaltyAmount: penaltyVisible ? d.penalty_amount : 0,
    penaltyStatus: penaltyVisible ? d.penalty_status : "none", adminNote: d.admin_note, createdAt: d.created_at, resolvedAt: d.resolved_at,
    ...(isAdmin ? { productTitle: d.product_title, amount: d.amount, buyerAlias: d.buyer_alias, sellerAlias: d.seller_alias, orderStatus: d.order_status, shipPhotos: safeIds(d.ship_photos) } : {}),
  };
}
export async function GET() {
  try {
    const user = await getUser(),
      db = database();
    try {
      await processAuctions(query, new Date(), batch);
    } catch (error) {
      console.error("Auction processing skipped", error instanceof Error ? error.message : "Unknown");
    }
    const rows = await db
      .prepare(
        "SELECT l.id, l.document, l.owner_id, l.created_at, p.public_alias, p.business_status FROM listings l LEFT JOIN profiles p ON p.user_id=l.owner_id WHERE l.status = ? ORDER BY l.created_at DESC LIMIT 200",
      )
      .bind("active")
      .all<ListingRow>();
    const activeIds = rows.results.map((r) => r.id);
    const auctionRows = activeIds.length
      ? await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id = ANY($1::text[])", [activeIds])
      : [];
    const auctions = new Map(auctionRows.map((a) => [a.listing_id, a]));
    const viewerId = user?.userId ?? null;
    const isAdmin = !!user && adminIds().includes(user.userId);
    const myTops = new Map<string, number>();
    if (viewerId) {
      const tops = await query<{ listing_id: string; top: number }>(
        "SELECT listing_id, MAX(amount)::int AS top FROM bids WHERE bidder_id=$1 AND (quantity IS NULL OR status<>'replaced') GROUP BY listing_id",
        [viewerId],
      );
      for (const t of tops) myTops.set(t.listing_id, t.top);
    }
    const ownRows = user
      ? await query<ListingRow>(
        "SELECT l.id, l.document, l.owner_id, l.created_at, l.status, p.public_alias, p.business_status FROM listings l LEFT JOIN profiles p ON p.user_id=l.owner_id WHERE l.owner_id=$1 AND l.status IN ('active','pending','sold','unsold') ORDER BY l.created_at DESC LIMIT 100",
        [user.userId],
      )
      : [];
    // Ended auctions the viewer bid on, so the result stays visible after the listing leaves the market.
    const bidListingRows = user
      ? await query<ListingRow>(
        `SELECT l.id, l.document, l.owner_id, l.created_at, l.status, p.public_alias, p.business_status
         FROM listings l LEFT JOIN profiles p ON p.user_id=l.owner_id
         WHERE l.status IN ('pending','sold','unsold') AND l.owner_id<>$1 AND EXISTS (SELECT 1 FROM bids b WHERE b.listing_id=l.id AND b.bidder_id=$1)
         ORDER BY l.created_at DESC LIMIT 50`,
        [user.userId],
      )
      : [];
    const ownIds = [...ownRows, ...bidListingRows].map((r) => r.id).filter((id) => !auctions.has(id));
    if (ownIds.length) {
      const extra = await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id = ANY($1::text[])", [ownIds]);
      for (const a of extra) auctions.set(a.listing_id, a);
    }
    const auctionIds = [...auctions.keys()];
    const bidRows = auctionIds.length
      ? await query<BidRow>(
        `SELECT b.id, b.listing_id, b.bidder_id, b.amount, b.quantity, b.status, b.allocated_quantity, b.created_at, p.public_alias
         FROM bids b LEFT JOIN profiles p ON p.user_id=b.bidder_id
         WHERE b.listing_id = ANY($1::text[]) AND (b.quantity IS NULL OR b.status<>'replaced')
         ORDER BY b.amount DESC, b.created_at ASC, b.id ASC LIMIT 1000`,
        [auctionIds],
      )
      : [];
    const bidderCounts = new Map(
      (auctionIds.length
        ? await query<{ listing_id: string; n: number }>(
          "SELECT listing_id, COUNT(DISTINCT bidder_id)::int AS n FROM bids WHERE listing_id = ANY($1::text[]) GROUP BY listing_id",
          [auctionIds],
        )
        : []).map((r) => [r.listing_id, r.n]),
    );
    const summaries = new Map<string, ReturnType<typeof partialSummary>>();
    const toProduct = (r: ListingRow): Product => {
      const doc = JSON.parse(r.document) as Product;
      const a = auctions.get(r.id);
      let view: Auction | null = null;
      const hidePending = r.status === "pending" && r.owner_id !== viewerId && !isAdmin && a?.current_bidder_id !== viewerId;
      if (a) {
        const standing = a.mode === "partial" ? standingFrom(bidRows, r.id) : [];
        if (a.mode === "partial" && !summaries.has(r.id)) summaries.set(r.id, partialSummary(standing, a.quantity, a.min_lot, a.reserve_price));
        const owner = r.owner_id === viewerId;
        view = auctionView(a, viewerId, myTops.get(r.id) ?? null, owner, standing, bidderCounts.get(r.id) ?? 0, owner || isAdmin);
      }
      return {
        ...doc,
        seller: r.public_alias || "사업자 정보 등록 대기",
        sellerVerified: r.business_status === "active",
        ownerId: r.owner_id,
        createdAt: r.created_at,
        status: hidePending ? "sold" : (r.status as Product["status"]) || "active",
        saleType: doc.saleType || "quote",
        auction: view,
      };
    };
    const products = [...rows.results.map(toProduct), ...samples];
    // The bank account is only shown to buyers who owe a payment and to admins.
    const settings = {
      penaltyRate: PENALTY_BPS / 10000,
      autoConfirmDays: AUTO_CONFIRM_DAYS,
      belowReservePolicy: belowReservePolicy(),
      successionEnabled: successionEnabled(),
      penalizeNonpayment: penalizeNonpayment(),
      feeRate: feeRateBps() / 10000,
      paymentHours: PAYMENT_HOURS,
      bankAccount: "",
      feeTable: null as null | { base: number; overrides: Record<string, number> },
      categoryFeeRates: Object.fromEntries(Object.entries(feeRateTable().overrides).map(([k, v]) => [k, v / 10000])),
      vapidPublicKey: pushConfigured() ? process.env.VAPID_PUBLIC_KEY! : "",
      depositWebhook: Boolean(process.env.DEPOSIT_WEBHOOK_SECRET),
    };
    if (!user)
      return json({
        products,
        user: null,
        favorites: [],
        offers: [],
        messages: [],
        ownListings: [],
        profile: null,
        bids: [],
        orders: [],
        notifications: [],
        unread: 0,
        isAdmin: false,
        adminOrders: [],
        deposits: [],
        bidListings: [],
        disputes: [],
        penalty: { due: 0, items: [] },
        fraud: [],
        duplicateBusiness: [],
        revenue: null,
        settings,
      });
    const [favorites, offers, messages, profile, orderRows, noteRows, unreadRows, adminRows, revenue, depositRows, disputeRows, fraud, dupRows] = await Promise.all([
      db
        .prepare("SELECT product_id AS id FROM favorites WHERE user_id = ?")
        .bind(user.userId)
        .all<{ id: string }>(),
      db
        .prepare(
          `SELECT ${offerFields},
            (SELECT public_alias FROM profiles WHERE user_id=offers.buyer_id) AS buyerAlias,
            (SELECT public_alias FROM profiles WHERE user_id=offers.seller_id) AS sellerAlias
            FROM offers WHERE buyer_id = ? OR seller_id = ? ORDER BY created_at DESC LIMIT 200`,
        )
        .bind(user.userId, user.userId)
        .all(),
      db
        .prepare(
          "SELECT m.id, m.offer_id AS offerId, m.author_id AS authorId, m.body, m.created_at AS createdAt FROM messages m JOIN offers o ON m.offer_id = o.id WHERE o.buyer_id = ? OR o.seller_id = ? ORDER BY m.created_at ASC LIMIT 1000",
        )
        .bind(user.userId, user.userId)
        .all(),
      db
        .prepare(
          "SELECT company, business_number AS businessNumber, phone, region, business_address AS businessAddress, district_key AS districtKey, public_alias AS publicAlias, payout_bank AS payoutBank, payout_account AS payoutAccount, payout_holder AS payoutHolder, business_status AS businessStatus, business_checked_at AS businessCheckedAt FROM profiles WHERE user_id = ?",
        )
        .bind(user.userId)
        .first(),
      query<Order>(`SELECT ${orderFields} FROM orders o WHERE o.buyer_id=$1 OR o.seller_id=$1 ORDER BY o.created_at DESC LIMIT 200`, [user.userId]),
      query(
        `SELECT id, kind, title, body, ref_type AS "refType", ref_id AS "refId", read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [user.userId],
      ),
      query<{ n: number }>("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [user.userId]),
      isAdmin
        ? query<Order>(`SELECT ${orderFields} FROM orders o
            ORDER BY (o.refund_amount > o.refund_paid OR o.status IN ('awaiting_payment','payment_reported','completed')) DESC, o.created_at DESC LIMIT 200`)
        : Promise.resolve([] as Order[]),
      isAdmin ? revenueSummary() : Promise.resolve(null),
      isAdmin
        ? query<Deposit>(
          `SELECT id, provider, depositor, amount, occurred_at AS "occurredAt", status, reason, candidates, note, received_at AS "receivedAt", order_id AS "orderId"
           FROM deposits WHERE status IN ('received','unmatched') ORDER BY received_at DESC LIMIT 100`,
        )
        : Promise.resolve([] as Deposit[]),
      query<DisputeRow>(
        isAdmin
          ? `SELECT ${disputeFields} FROM disputes d JOIN orders o ON o.id=d.order_id
             WHERE d.status='open' OR d.penalty_status='due' OR d.created_at >= $2 OR o.buyer_id=$1 OR o.seller_id=$1
             ORDER BY d.created_at DESC LIMIT 200`
          : `SELECT ${disputeFields} FROM disputes d JOIN orders o ON o.id=d.order_id
             WHERE (o.buyer_id=$1 OR o.seller_id=$1) AND (d.kind<>'no_payment' OR d.penalty_user_id=$1)
             ORDER BY (d.penalty_status='due' AND d.penalty_user_id=$1) DESC, d.created_at DESC LIMIT 100`,
        isAdmin ? [user.userId, new Date(Date.now() - 30 * 86400000).toISOString()] : [user.userId],
      ),
      isAdmin ? fraudSignals(query, new Date(Date.now() - 90 * 86400000).toISOString()) : Promise.resolve([]),
      isAdmin
        ? query<{ business_number: string; aliases: string[] }>(
          "SELECT business_number, array_agg(COALESCE(public_alias,'별칭 없음') ORDER BY public_alias) AS aliases FROM profiles GROUP BY business_number HAVING COUNT(*) > 1 LIMIT 50",
        )
        : Promise.resolve([]),
    ]);
    const ownListings = ownRows.map(toProduct);
    const bidListings = bidListingRows.map(toProduct);
    const disputes: Dispute[] = disputeRows.map((d) => toDispute(d, user.userId, isAdmin));
    // Both totals are uncapped; the dispute list below is not, so it cannot decide viaBusiness.
    const [dueTotal, ownDue] = await Promise.all([
      penaltyDue(query, user.userId),
      query<{ t: number }>("SELECT COALESCE(SUM(penalty_amount),0)::int AS t FROM disputes WHERE penalty_status='due' AND penalty_user_id=$1", [user.userId])
        .then((r) => r[0]?.t ?? 0),
    ]);
    const penaltyItems = disputes.filter((d) => d.penaltyStatus === "due" && disputeRows.find((r) => r.id === d.id)?.penalty_user_id === user.userId);
    const bids: Bid[] = bidRows.map((b) => {
      const s = summaries.get(b.listing_id);
      const allocated = b.quantity === null ? null : s && b.status === "active" ? (s.allocatedBy.get(b.id) ?? 0) : b.allocated_quantity;
      return {
        id: b.id,
        listingId: b.listing_id,
        amount: b.amount,
        alias: b.public_alias || "구매자",
        mine: b.bidder_id === user.userId,
        createdAt: b.created_at,
        quantity: b.quantity,
        allocated,
        status: b.status,
      };
    });
    const [orders, adminOrders] = await Promise.all([
      backfillDepositCodes(orderRows.map(withPhotos).map((o) => forViewer(o, user.userId))).then((o) => attachContacts(o, user.userId, false)),
      isAdmin ? attachContacts(adminRows.map(withPhotos), user.userId, true) : Promise.resolve([]),
    ]);
    const owesPayment = orderRows.some((o) => o.buyerId === user.userId && ["awaiting_payment", "payment_reported"].includes(o.status));
    if (isAdmin || owesPayment) settings.bankAccount = process.env.PLATFORM_BANK_ACCOUNT || "";
    if (isAdmin) settings.feeTable = feeRateTable();
    return json({
      products,
      user: { id: user.userId, name: user.displayName },
      favorites: favorites.results.map((v) => v.id),
      offers: offers.results,
      messages: messages.results,
      profile,
      ownListings,
      bids,
      orders,
      notifications: noteRows,
      unread: unreadRows[0]?.n ?? 0,
      isAdmin,
      adminOrders,
      deposits: depositRows.map((d) => ({ ...d, candidates: safeIds(d.candidates) })),
      bidListings,
      disputes,
      penalty: { due: dueTotal, items: penaltyItems, viaBusiness: dueTotal > ownDue },
      fraud,
      duplicateBusiness: dupRows.map((r) => ({ businessNumber: r.business_number, aliases: r.aliases })),
      revenue,
      settings,
    });
  } catch (error) {
    console.error(
      "Market read failed",
      error instanceof Error ? error.message : "Unknown",
    );
    return json(
      {
        error:
          "저장된 정보를 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.",
      },
      503,
    );
  }
}
const photoList = z.array(z.string().regex(/^\/api\/images\/[a-f0-9-]{36}$/)).max(5, "사진은 5장까지 올릴 수 있습니다.");
async function ownedImages(urls: string[], userId: string) {
  for (const url of urls) {
    const head = await bucket().head(url.split("/").pop()!);
    if (!head || head.customMetadata?.owner !== userId) return false;
  }
  return true;
}
async function requireAlias(userId: string) {
  const rows = await query<{ public_alias: string | null }>("SELECT public_alias FROM profiles WHERE user_id=$1", [userId]);
  return rows[0]?.public_alias || null;
}
type AuctionSpec = { days: number; startPrice: number; reservePrice: number; mode: "whole" | "partial"; minLot: number; succession: boolean; instantPrice?: number | null };
// Builds the two guarded INSERTs for a new auction listing. `guard` is an EXISTS
// clause (with $G1.. placeholders) that ties the inserts to a claim made earlier
// in the same batch.
function auctionInsertStatements(
  id: string, userId: string, alias: string, doc: Record<string, unknown>, spec: AuctionSpec, now: Date,
  guard?: { sql: string; params: unknown[] },
): Statement[] {
  const window = auctionWindow(now, spec.days);
  const stock = doc.stock as number;
  const mode = spec.mode === "partial" && spec.minLot < stock ? "partial" : "whole";
  const minLot = mode === "partial" ? spec.minLot : 1;
  const product = {
    ...doc, id, seller: alias, sample: false, saleType: "auction", price: spec.startPrice,
    moq: mode === "partial" ? minLot : stock, deadline: kstDate(window.endsAt), auctionMode: mode, minLot: mode === "partial" ? minLot : stock,
  };
  const shift = (sql: string, base: number) => sql.replace(/\$G(\d)/g, (_, n) => `$${base + Number(n)}`);
  const g = guard ? ` WHERE ${guard.sql}` : "";
  const listingParams = [id, userId, JSON.stringify(product), now.toISOString(), ...(guard?.params ?? [])];
  const auctionParams = [id, userId, stock, doc.unit, spec.startPrice, spec.reservePrice, window.startsAt, window.midpointAt, window.endsAt,
    now.toISOString(), mode, minLot, spec.succession, mode === "whole" ? spec.instantPrice ?? null : null, ...(guard?.params ?? [])];
  return [
    { sql: shift(`INSERT INTO listings(id, owner_id, document, status, created_at) SELECT $1,$2,$3,'active',$4${g}`, 4), params: listingParams },
    {
      sql: shift(`INSERT INTO auctions(listing_id, seller_id, quantity, unit, start_price, reserve_price, starts_at, midpoint_at, ends_at, status, created_at, mode, min_lot, succession_enabled, instant_price)
        SELECT $1,$2,$3::int,$4,$5::int,$6::int,$7,$8,$9,'active',$10,$11,$12::int,$13::boolean,$14::int${g}`, 14),
      params: auctionParams,
    },
  ];
}
async function insertAuctionListing(userId: string, alias: string, doc: Record<string, unknown>, spec: AuctionSpec, now: Date) {
  const id = crypto.randomUUID();
  await batch(auctionInsertStatements(id, userId, alias, doc, spec, now));
  return id;
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("x-dumping-client") !== "1" ||
      (request.headers.get("origin") &&
        request.headers.get("origin") !== new URL(request.url).origin)
    )
      return json({ error: "허용되지 않은 요청입니다." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json"))
      return json({ error: "요청 형식을 확인해 주세요." }, 415);
    const user = await getUser();
    if (!user) return json({ error: "로그인 후 이용해 주세요." }, 401);
    const raw = await request.text();
    if (raw.length > 16000)
      return json({ error: "입력 내용이 너무 깁니다." }, 413);
    const data = JSON.parse(raw),
      db = database(),
      nowDate = new Date(),
      now = nowDate.toISOString(),
      userId = user.userId,
      isAdmin = adminIds().includes(userId),
      ip = ipHashFrom(request.headers);
    const gate = async () => {
      const due = await penaltyDue(query, userId);
      return due > 0 ? json({ error: `이 계정 또는 같은 사업자등록번호 계정에 미납 위약금 ${due.toLocaleString("ko-KR")}원이 있어 입찰·재고 등록·구매 수락이 제한됩니다. 거래 관리에서 확인하거나 운영자에게 문의해 주세요.` }, 403) : null;
    };
    if (["bid", "create_listing", "relist_auction", "relist_remainder", "profile"].includes(data.action))
      await recordActivity(query, userId, ip, now).catch(() => {});
    if (data.action === "favorite") {
      const { productId, saved } = z
        .object({ productId: uid, saved: z.boolean() })
        .parse(data);
      if (saved && !(await findProduct(productId)))
        return json({ error: "판매 중인 상품을 찾을 수 없습니다." }, 404);
      if (saved)
        await db
          .prepare(
            "INSERT OR IGNORE INTO favorites(user_id, product_id) VALUES(?, ?)",
          )
          .bind(userId, productId)
          .run();
      else
        await db
          .prepare("DELETE FROM favorites WHERE user_id = ? AND product_id = ?")
          .bind(userId, productId)
          .run();
      return json({ ok: true });
    }
    if (data.action === "profile") {
      const p = profileSchema.parse(data.profile);
      const businessStatus = await ntsBusinessStatus(p.businessNumber);
      if (businessStatus === "unregistered")
        return json({ error: "국세청에 등록되지 않은 사업자등록번호입니다. 번호를 다시 확인해 주세요." }, 400);
      if (businessStatus === "closed")
        return json({ error: "국세청 조회 결과 폐업한 사업자입니다. 운영 중인 사업자로 등록해 주세요." }, 400);
      const alias = await saveBusinessProfile(userId, p);
      await query("UPDATE profiles SET business_status=$2, business_checked_at=$3 WHERE user_id=$1 AND business_number=$4", [userId, businessStatus, now, p.businessNumber]);
      return json({ ok: true, businessStatus, ...alias });
    }
    if (data.action === "create_listing") {
      const blocked = await gate();
      if (blocked) return blocked;
      const fields = listingSchema.parse(data.product);
      const alias = await requireAlias(userId);
      if (!alias)
        return json({ error: "사업자 주소를 등록하고 거래 별칭을 먼저 배정받아 주세요." }, 400);
      const object = await bucket().head(fields.image.split("/").pop()!);
      if (!object || object.customMetadata?.owner !== userId)
        return json({ error: "직접 업로드한 상품 사진을 선택해 주세요." }, 400);
      const { auctionDays, reservePrice, auctionMode: mode, minLot, successionEnabled, instantPrice, ...doc } = fields;
      if (fields.saleType === "auction") {
        const id = await insertAuctionListing(userId, alias, doc,
          { days: auctionDays!, startPrice: fields.price, reservePrice: reservePrice!, mode, minLot: minLot ?? fields.stock, succession: successionEnabled, instantPrice: instantPrice ?? null }, nowDate);
        return json({ ok: true, id }, 201);
      }
      const id = crypto.randomUUID();
      const product = { ...doc, seller: alias, id, sample: false, saleType: "quote" };
      await db
        .prepare(
          "INSERT INTO listings(id, owner_id, document, status, created_at) VALUES(?, ?, ?, ?, ?)",
        )
        .bind(id, userId, JSON.stringify(product), "active", now)
        .run();
      return json({ ok: true, id }, 201);
    }
    if (data.action === "archive_listing") {
      const id = uid.parse(data.id);
      const auction = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1 AND seller_id=$2", [id, userId]))[0];
      if (auction?.status === "active") {
        if (auction.bid_count > 0)
          return json({ error: "입찰이 있는 경매는 중단할 수 없습니다. 현재 최고가로 낙찰하거나 마감을 기다려 주세요." }, 400);
        await query(
          "UPDATE auctions SET status='cancelled', close_reason='seller_cancelled', closed_at=$2 WHERE listing_id=$1 AND status='active' AND bid_count=0",
          [id, now],
        );
      }
      const result = await db
        .prepare(
          "UPDATE listings SET status='archived' WHERE id=? AND owner_id=? AND status IN ('active','unsold')",
        )
        .bind(id, userId)
        .run();
      if (!result.meta.changes)
        return json({ error: "수정할 상품이 없습니다." }, 404);
      return json({ ok: true });
    }
    if (data.action === "bid") {
      const p = z.object({ productId: uid, amount: price.optional(), unitPrice: price.optional(), quantity: quantity.optional(), buyNow: z.boolean().optional() }).parse(data);
      if (!(await requireAlias(userId)))
        return json({ error: "사업자 주소를 등록하고 거래 별칭을 먼저 배정받아 주세요." }, 400);
      const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1", [p.productId]))[0];
      if (!a || a.status !== "active") return json({ error: "진행 중인 경매가 아닙니다." }, 404);
      if (a.seller_id === userId) return json({ error: "내가 등록한 경매에는 입찰할 수 없습니다." }, 400);
      if (a.ends_at <= now) return json({ error: "경매가 종료되었습니다." }, 400);
      const blocked = await gate();
      if (blocked) return blocked;
      // Self-dealing guard: an account registered to the seller's business number cannot bid.
      if (await sameBusiness(query, a.seller_id, userId))
        return json({ error: "판매자와 같은 사업자등록번호로 등록된 계정은 이 경매에 입찰할 수 없습니다." }, 403);
      const title = async () => {
        const doc = (await query<{ document: string }>("SELECT document FROM listings WHERE id=$1", [p.productId]))[0];
        return doc ? (JSON.parse(doc.document) as { title: string }).title : "재고";
      };
      if (a.mode === "partial") {
        const unitPrice = p.unitPrice ?? p.amount;
        if (!unitPrice || !p.quantity) return json({ error: "부분 수량 경매는 단가와 수량을 함께 입력해 주세요." }, 400);
        if (p.quantity < a.min_lot || p.quantity > a.quantity)
          return json({ error: `수량은 ${a.min_lot.toLocaleString("ko-KR")}~${a.quantity.toLocaleString("ko-KR")}${a.unit} 범위로 입력해 주세요.` }, 400);
        if (p.quantity % a.min_lot !== 0)
          return json({ error: `수량은 ${a.min_lot.toLocaleString("ko-KR")}${a.unit} 단위로 입력해 주세요.` }, 400);
        if (unitPrice < a.start_price) return json({ error: `시작가 ${a.start_price.toLocaleString("ko-KR")}원 이상으로 입력해 주세요.` }, 400);
        if (unitPrice * p.quantity > MONEY_CAP) return json({ error: "입찰 총액이 너무 큽니다." }, 400);
        const standing = await standingBids(query, p.productId);
        const mine = standing.find((b) => b.bidderId === userId);
        const others = standing.filter((b) => b.bidderId !== userId);
        const min = partialMinimumBid(a, others, a.quantity, a.min_lot);
        if (unitPrice < min) return json({ error: `최소 입찰 단가는 ${min.toLocaleString("ko-KR")}원입니다.` }, 400);
        if (mine && (unitPrice < mine.unitPrice || p.quantity < mine.quantity || (unitPrice === mine.unitPrice && p.quantity === mine.quantity)))
          return json({ error: "기존 입찰보다 단가·수량 모두 같거나 높아야 하며, 하나는 올려야 합니다. 입찰은 취소할 수 없습니다." }, 400);
        const before = partialSummary(standing, a.quantity, a.min_lot, a.reserve_price);
        const bidId = crypto.randomUUID();
        const newBid: AllocBid = { id: bidId, bidderId: userId, unitPrice, quantity: p.quantity, createdAt: now };
        const after = partialSummary([...others, newBid], a.quantity, a.min_lot, a.reserve_price);
        const newEnd = new Date(nowDate.getTime() + EXTENSION_MINUTES * 60000).toISOString();
        const results = await batch([
          lockStatement(p.productId),
          {
            sql: `UPDATE auctions SET bid_count=bid_count+1, last_bid_id=$2,
                    extended_count=extended_count + CASE WHEN ends_at < $3 THEN 1 ELSE 0 END,
                    ends_at=CASE WHEN ends_at < $3 THEN $3 ELSE ends_at END,
                    reserve_met_at=COALESCE(reserve_met_at, CASE WHEN $4::int >= reserve_price THEN $5 ELSE NULL END)
                  WHERE listing_id=$1 AND status='active' AND mode='partial' AND ends_at > $5 AND seller_id <> $6
                    AND bid_count=$7::int AND $4::int >= start_price AND $8::int BETWEEN min_lot AND quantity AND $8::int % min_lot = 0
                    AND $4::bigint * $8::bigint <= 2000000000
                  RETURNING ends_at, extended_count, (reserve_met_at = $5) AS reserve_just_met`,
            params: [p.productId, bidId, newEnd, unitPrice, now, userId, a.bid_count, p.quantity],
          },
          {
            sql: `UPDATE bids SET status='replaced', replaced_at=$3, replaced_by=$2 WHERE listing_id=$1 AND bidder_id=$4 AND status='active' AND quantity IS NOT NULL
                  AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND last_bid_id=$2)`,
            params: [p.productId, bidId, now, userId],
          },
          {
            sql: `INSERT INTO bids(id,listing_id,bidder_id,amount,quantity,status,created_at,ip_hash) SELECT $2,$1,$4,$5::int,$6::int,'active',$3,$7
                  WHERE EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND last_bid_id=$2)`,
            params: [p.productId, bidId, now, userId, unitPrice, p.quantity, ip],
          },
        ]);
        if (results[1].rowCount !== 1)
          return json({ error: "다른 입찰이 먼저 들어왔습니다. 새로고침 후 다시 입찰해 주세요." }, 409);
        const claim = results[1].rows[0] as { ends_at: string; extended_count: number; reserve_just_met: boolean | null };
        const name = await title();
        for (const b of others) {
          const wasQ = before.allocatedBy.get(b.id) ?? 0, nowQ = after.allocatedBy.get(b.id) ?? 0;
          if (nowQ < wasQ)
            await notify(query, [b.bidderId], {
              kind: "outbid", title: `더 높은 입찰 · ${name}`,
              body: nowQ === 0
                ? `다른 입찰로 낙찰권 밖으로 밀렸습니다 (${wasQ.toLocaleString("ko-KR")}${a.unit} → 0). 단가를 올리면 다시 낙찰권을 가질 수 있어요.`
                : `다른 입찰로 내 낙찰 예정 수량이 ${wasQ.toLocaleString("ko-KR")}→${nowQ.toLocaleString("ko-KR")}${a.unit}로 줄었습니다. 단가를 올리면 다시 낙찰권을 가질 수 있어요.`,
              refType: "listing", refId: p.productId,
            }, now);
        }
        if (claim.reserve_just_met)
          await notify(query, [a.seller_id], {
            kind: "reserve_met", title: `최저 매각가 도달 · ${name}`,
            body: `${unitPrice.toLocaleString("ko-KR")}원 × ${p.quantity.toLocaleString("ko-KR")}${a.unit} 입찰로 최저 매각가에 도달했습니다. 마감 시 최저가 이상 입찰분은 자동 낙찰됩니다.`,
            refType: "listing", refId: p.productId,
          }, now);
        return json({ ok: true, extended: claim.extended_count > a.extended_count, endsAt: claim.ends_at, allocated: after.allocatedBy.get(bidId) ?? 0, cutoff: after.cutoff }, 201);
      }
      if (p.quantity !== undefined) return json({ error: "전량 경매는 단가만 입력합니다." }, 400);
      const amount = p.buyNow ? a.instant_price ?? undefined : p.amount ?? p.unitPrice;
      if (p.buyNow && !a.instant_price) return json({ error: "즉시구매가가 없는 경매입니다." }, 400);
      if (p.buyNow && p.amount === undefined) return json({ error: "확인한 즉시구매가를 함께 보내 주세요." }, 400);
      if (p.buyNow && p.amount !== a.instant_price)
        return json({ error: "즉시구매가가 방금 바뀌었습니다. 새 가격을 확인한 뒤 다시 눌러 주세요." }, 409);
      if (!amount) return json({ error: "입찰 단가를 입력해 주세요." }, 400);
      const hitsInstant = a.instant_price !== null && amount >= a.instant_price;
      const effective = hitsInstant ? a.instant_price! : amount;
      if (effective * a.quantity > MONEY_CAP) return json({ error: "입찰 총액이 너무 큽니다." }, 400);
      if (!hitsInstant) {
        if (a.current_bidder_id === userId) return json({ error: "이미 최고 입찰자입니다. 다른 입찰이 들어오면 알려드릴게요." }, 400);
        const min = minimumBid({ ...a, instant_price: null });
        if (amount < min)
          return json({ error: `최소 입찰가는 ${min.toLocaleString("ko-KR")}원입니다.` }, 400);
      }
      const placed = await placeWholeBid(query, batch, a, userId, amount, now, {
        buyNow: p.buyNow === true, ipHash: ip, extensionMinutes: EXTENSION_MINUTES,
      });
      if (!placed.ok)
        return json({ error: "다른 입찰이나 가격 변경이 먼저 반영되었습니다. 새로고침 후 다시 입찰해 주세요." }, 409);
      return json({ ok: true, instant: placed.instant, price: placed.price, extended: placed.extended, endsAt: placed.endsAt, orderId: placed.orderId }, 201);
    }
    if (data.action === "set_instant_price") {
      // Raising is always allowed; lowering must stay above the current top bid
      // (otherwise that bid would win instantly) and never below the hidden reserve.
      const p = z.object({ productId: uid, instantPrice: price.nullable() }).parse(data);
      const a = (await query<AuctionRow & { document: string }>(
        "SELECT a.*, l.document FROM auctions a JOIN listings l ON l.id=a.listing_id WHERE a.listing_id=$1 AND a.seller_id=$2", [p.productId, userId],
      ))[0];
      if (!a || a.status !== "active" || a.ends_at <= now) return json({ error: "진행 중인 내 경매가 아닙니다." }, 404);
      if (a.mode !== "whole") return json({ error: "즉시체결가는 전량 경매에서만 쓸 수 있습니다." }, 400);
      if (p.instantPrice !== null) {
        const original = (JSON.parse(a.document) as { originalPrice: number }).originalPrice;
        if (p.instantPrice < a.reserve_price) return json({ error: `즉시체결가는 최저 매각가(${a.reserve_price.toLocaleString("ko-KR")}원) 이상이어야 합니다.` }, 400);
        if (p.instantPrice > original) return json({ error: "즉시체결가는 정상가 이하로 입력해 주세요." }, 400);
        if (p.instantPrice * a.quantity > MONEY_CAP) return json({ error: "즉시체결가 × 수량이 너무 큽니다." }, 400);
        if (a.current_price !== null && p.instantPrice <= a.current_price)
          return json({ error: `즉시체결가는 현재 최고 입찰가(${a.current_price.toLocaleString("ko-KR")}원)보다 높아야 합니다.` }, 400);
      }
      const updated = await query<{ instant_price: number | null }>(
        `UPDATE auctions SET instant_price=$2::int WHERE listing_id=$1 AND seller_id=$3 AND status='active' AND mode='whole' AND ends_at > $4
           AND ($2::int IS NULL OR ($2::int >= reserve_price AND (current_price IS NULL OR $2::int > current_price)))
         RETURNING instant_price`,
        [p.productId, p.instantPrice, userId, now],
      );
      if (!updated.length) return json({ error: "그 사이 입찰가가 올라 적용하지 못했습니다. 새로고침 후 다시 정해 주세요." }, 409);
      if (p.instantPrice !== null && (a.instant_price === null || p.instantPrice < a.instant_price)) {
        const bidders = await query<{ bidder_id: string }>("SELECT DISTINCT bidder_id FROM bids WHERE listing_id=$1", [p.productId]);
        const title = (JSON.parse(a.document) as { title: string }).title;
        await notify(query, bidders.map((b) => b.bidder_id), {
          kind: "instant_price_changed", title: `즉시구매가 변경 · ${title}`,
          body: `즉시구매가가 ${p.instantPrice.toLocaleString("ko-KR")}원으로 바뀌었습니다. 이 가격에 입찰하면 바로 낙찰됩니다.`,
          refType: "listing", refId: p.productId,
        }, now);
      }
      return json({ ok: true, instantPrice: updated[0].instant_price });
    }
    if (data.action === "decide_below_reserve") {
      const p = z.object({ productId: uid, accept: z.boolean() }).parse(data);
      const r = await resolveBelowReserve(query, batch, p.productId, now, { accept: p.accept, sellerId: userId });
      if (!r.ok) return json({ error: r.error }, 409);
      return json({ ok: true, orderId: r.orderId });
    }
    if (data.action === "lower_reserve") {
      const p = z.object({ productId: uid, reservePrice: price }).parse(data);
      const updated = await query<{ current_price: number | null; reserve_price: number; mode: string; quantity: number; min_lot: number }>(
        "UPDATE auctions SET reserve_price=$2 WHERE listing_id=$1 AND seller_id=$3 AND status='active' AND reserve_price>$2 RETURNING current_price, reserve_price, mode, quantity, min_lot",
        [p.productId, p.reservePrice, userId],
      );
      if (!updated.length)
        return json({ error: "진행 중인 내 경매에서 현재 최저 매각가보다 낮은 금액만 입력할 수 있습니다." }, 400);
      const u = updated[0];
      if (u.mode === "partial") {
        const s = partialSummary(await standingBids(query, p.productId), u.quantity, u.min_lot, p.reservePrice);
        return json({ ok: true, reserveMet: s.reserveMet, sellableQty: s.sellableQty });
      }
      return json({ ok: true, reserveMet: u.current_price !== null && u.current_price >= p.reservePrice });
    }
    if (data.action === "preview_close") {
      const p = z.object({ productId: uid, floor: z.number().int().min(0).max(100000000).default(0) }).parse(data);
      const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1 AND seller_id=$2", [p.productId, userId]))[0];
      if (!a || a.status !== "active") return json({ error: "진행 중인 내 경매가 아닙니다." }, 404);
      if (a.mode !== "partial") return json({ error: "부분 수량 경매에서만 미리 볼 수 있습니다." }, 400);
      const standing = await standingBids(query, p.productId);
      const aliases = new Map((await query<{ user_id: string; public_alias: string | null }>(
        "SELECT user_id, public_alias FROM profiles WHERE user_id = ANY($1::text[])", [[...new Set(standing.map((b) => b.bidderId))]],
      )).map((r) => [r.user_id, r.public_alias || "구매자"]));
      const { fills, remaining } = allocate(standing, a.quantity, a.min_lot, p.floor);
      return json({
        ok: true,
        fills: fills.map((f) => ({ alias: aliases.get(f.bid.bidderId) || "구매자", unitPrice: f.bid.unitPrice, qty: f.qty, amount: f.qty * f.bid.unitPrice })),
        total: fills.reduce((s, f) => s + f.qty * f.bid.unitPrice, 0),
        remaining,
      });
    }
    if (data.action === "accept_bid") {
      const p = z.object({ productId: uid, floor: z.number().int().min(0).max(100000000).default(0) }).parse(data);
      const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1 AND seller_id=$2", [p.productId, userId]))[0];
      if (!a || a.status !== "active") return json({ error: "진행 중인 내 경매가 아닙니다." }, 404);
      if (a.mode === "partial") {
        const standing = await standingBids(query, p.productId);
        if (!allocate(standing, a.quantity, a.min_lot, p.floor).fills.length) return json({ error: "아직 입찰이 없습니다." }, 400);
      } else if (a.current_price === null) return json({ error: "아직 입찰이 없습니다." }, 400);
      const closed = await closeAuction(query, a, now, "accept", batch, p.floor);
      if (!closed) return json({ error: "입찰이 방금 들어왔습니다. 새로고침 후 다시 확인해 주세요." }, 409);
      return json({ ok: true, orderId: closed.orderId, orderIds: closed.orderIds });
    }
    if (data.action === "relist_auction" || data.action === "relist_remainder") {
      const p = z.object({
        productId: uid, auctionDays: z.number().int(), price, reservePrice: price, auctionMode, minLot: z.number().int().optional(),
        successionEnabled: z.boolean().default(true), expected: z.number().int().optional(), instantPrice: price.optional().nullable(),
      }).parse(data);
      const blocked = await gate();
      if (blocked) return blocked;
      if (!(AUCTION_DAYS as readonly number[]).includes(p.auctionDays)) return json({ error: "경매 기간을 선택해 주세요." }, 400);
      if (p.reservePrice < p.price) return json({ error: "최저 매각가는 시작가 이상으로 입력해 주세요." }, 400);
      const alias = await requireAlias(userId);
      if (!alias) return json({ error: "사업자 정보를 먼저 등록해 주세요." }, 400);
      const remainder = data.action === "relist_remainder";
      const old = (await query<{ document: string; status: string }>("SELECT document, status FROM listings WHERE id=$1 AND owner_id=$2", [p.productId, userId]))[0];
      if (!old) return json({ error: "내 재고를 찾을 수 없습니다." }, 404);
      const doc = JSON.parse(old.document) as Record<string, unknown>;
      let stock = doc.stock as number;
      let expected = 0;
      // An unsold auction lot is relisted for what is still unsold (part may already have been
      // relisted as a remainder), and the auction row is claimed too so the same units cannot
      // be relisted twice.
      let origin: { observed: number; stock: number } | null = null;
      if (remainder) {
        const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1 AND seller_id=$2", [p.productId, userId]))[0];
        if (!a || !["won", "unsold"].includes(a.status) || a.unsold_quantity <= 0) return json({ error: "다시 경매할 미낙찰 수량이 없습니다." }, 404);
        if (p.expected !== undefined && p.expected !== a.unsold_quantity) return json({ error: "미낙찰 수량이 바뀌었습니다. 새로고침해 주세요." }, 409);
        stock = expected = a.unsold_quantity;
      } else if (old.status !== "unsold") return json({ error: "유찰된 내 재고만 다시 등록할 수 있습니다." }, 404);
      else {
        const a = (await query<AuctionRow>("SELECT * FROM auctions WHERE listing_id=$1 AND seller_id=$2", [p.productId, userId]))[0];
        if (a) {
          // Rows from before unsold_quantity was tracked have all three counters at 0.
          const legacy = a.unsold_quantity === 0 && a.sold_quantity === 0 && a.relisted_quantity === 0;
          const left = legacy ? a.quantity : a.unsold_quantity;
          if (left <= 0) return json({ error: "다시 경매할 수량이 없습니다." }, 404);
          origin = { observed: a.unsold_quantity, stock: left };
          stock = left;
        }
      }
      if (p.reservePrice > (doc.originalPrice as number)) return json({ error: "최저 매각가는 정상가 이하로 입력해 주세요." }, 400);
      if (p.price * stock > MONEY_CAP) return json({ error: "시작가 × 수량이 너무 큽니다." }, 400);
      if (p.instantPrice && (p.auctionMode === "partial" || p.instantPrice < p.reservePrice || p.instantPrice > (doc.originalPrice as number) || p.instantPrice * stock > MONEY_CAP))
        return json({ error: "즉시체결가는 전량 경매에서 최저 매각가 이상, 정상가 이하로 입력해 주세요." }, 400);
      const minLot = p.auctionMode === "partial" ? (p.minLot ?? 0) : stock;
      if (p.auctionMode === "partial" && (minLot < 1 || minLot > stock || stock % minLot !== 0))
        return json({ error: "전량 수량은 최소 입찰 단위의 배수여야 합니다." }, 400);
      const newId = crypto.randomUUID();
      const claim: Statement = remainder
        ? {
          sql: `UPDATE auctions SET unsold_quantity=0, relisted_quantity=relisted_quantity+unsold_quantity, relisted_to=$2 WHERE listing_id=$1 AND seller_id=$3 AND status IN ('won','unsold')
                AND unsold_quantity=$4::int AND unsold_quantity > 0 AND NOT EXISTS (SELECT 1 FROM orders WHERE listing_id=$1 AND status='offered') RETURNING listing_id`,
          params: [p.productId, newId, userId, expected],
        }
        : {
          sql: `UPDATE listings SET status='archived', relisted_to=$2 WHERE id=$1 AND owner_id=$3 AND status='unsold'
                AND NOT EXISTS (SELECT 1 FROM orders WHERE listing_id=$1 AND status='offered')
                AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND unsold_quantity=$4::int)) RETURNING id`,
          params: [p.productId, newId, userId, origin ? origin.observed : null],
        };
      const originClaim: Statement[] = origin
        ? [{
          sql: `UPDATE auctions SET unsold_quantity=0, relisted_quantity=relisted_quantity+$3::int, relisted_to=$2
                WHERE listing_id=$1 AND EXISTS (SELECT 1 FROM listings WHERE id=$1 AND relisted_to=$2)`,
          params: [p.productId, newId, origin.stock],
        }]
        : [];
      const guard = remainder
        ? { sql: "EXISTS (SELECT 1 FROM auctions WHERE listing_id=$G1 AND relisted_to=$G2)", params: [p.productId, newId] }
        : { sql: "EXISTS (SELECT 1 FROM listings WHERE id=$G1 AND relisted_to=$G2)", params: [p.productId, newId] };
      const results = await batch([
        lockStatement(p.productId),
        claim,
        ...originClaim,
        ...auctionInsertStatements(newId, userId, alias, { ...doc, stock }, { days: p.auctionDays, startPrice: p.price, reservePrice: p.reservePrice, mode: p.auctionMode, minLot, succession: p.successionEnabled, instantPrice: p.instantPrice ?? null }, nowDate, guard),
      ]);
      if (results[1].rowCount !== 1) return json({ error: "이미 다시 등록되었거나 차순위 제안이 진행 중입니다." }, 409);
      return json({ ok: true, id: newId }, 201);
    }
    if (data.action === "accept_offer") {
      const p = z.object({ orderId: uid }).parse(data);
      const blocked = await gate();
      if (blocked) return blocked;
      const due = new Date(nowDate.getTime() + PAYMENT_HOURS * 3600000).toISOString();
      const results = await batch([
        {
          sql: `UPDATE orders SET status='awaiting_payment', accepted_at=$2, payment_due_at=$3 WHERE id=$1 AND buyer_id=$4 AND status='offered' AND offer_expires_at > $2
                RETURNING seller_id, product_title, bid_id, quantity, listing_id, offer_kind`,
          params: [p.orderId, now, due, userId],
        },
        {
          sql: `UPDATE bids SET allocated_quantity=bids.allocated_quantity+o.quantity, status=CASE WHEN bids.allocated_quantity+o.quantity >= bids.quantity THEN 'won' ELSE 'partial' END
                FROM orders o WHERE o.id=$1 AND o.status='awaiting_payment' AND o.accepted_at=$2 AND o.buyer_id=$3 AND bids.id=o.bid_id AND bids.quantity IS NOT NULL`,
          params: [p.orderId, now, userId],
        },
      ]);
      if (results[0].rowCount !== 1) return json({ error: "제안이 만료되었거나 이미 처리되었습니다." }, 409);
      const row = results[0].rows[0] as { seller_id: string; product_title: string; offer_kind: string | null };
      const below = row.offer_kind === "below_reserve";
      await notify(query, [row.seller_id], {
        kind: below ? "below_reserve_accepted" : "succession_accepted",
        title: `${below ? "구매 확정" : "차순위 낙찰 확정"} · ${row.product_title}`,
        body: `${below ? "최고 입찰자가 제시한 가격으로 구매하기로 했습니다." : "차순위 입찰자가 제안을 수락했습니다."} ${PAYMENT_HOURS}시간 안에 입금하면 연락처가 공개됩니다.`,
        refType: "order", refId: p.orderId,
      }, now);
      return json({ ok: true });
    }
    if (data.action === "decline_offer") {
      const p = z.object({ orderId: uid }).parse(data);
      const o = await cancelOrder(query, p.orderId, now, "offer_declined", ["offered"], { buyerId: userId });
      if (!o) return json({ error: "거절할 수 있는 제안이 아닙니다." }, 404);
      await afterCancel(query, batch, o, now, "offer_declined");
      return json({ ok: true });
    }
    if (data.action === "report_payment") {
      const p = z.object({ orderId: uid, depositor: z.string().trim().min(1).max(40) }).parse(data);
      const rows = await query<{ seller_id: string; product_title: string; amount: number }>(
        "UPDATE orders SET status='payment_reported', reported_at=$3, depositor=$4 WHERE id=$1 AND buyer_id=$2 AND status='awaiting_payment' RETURNING seller_id, product_title, amount",
        [p.orderId, userId, now, p.depositor],
      );
      if (!rows.length) return json({ error: "입금 대기 중인 내 주문이 아닙니다." }, 404);
      const matched = await rematchDeposits(query, batch, now, rows[0].amount).catch(() => 0);
      if (!matched) {
        await notify(query, [rows[0].seller_id], {
          kind: "payment_reported", title: `입금 신고 · ${rows[0].product_title}`,
          body: "구매자가 입금을 완료했다고 알렸습니다. 운영자가 확인하면 연락처가 공개됩니다.", refType: "order", refId: p.orderId,
        }, now);
        await notify(query, adminIds(), {
          kind: "admin_payment", title: `입금 확인 요청 · ${rows[0].product_title}`,
          body: `입금자명 ${p.depositor} · ${rows[0].amount.toLocaleString("ko-KR")}원. 관리 탭에서 확인해 주세요.`, refType: "order", refId: p.orderId,
        }, now);
      }
      return json({ ok: true, autoConfirmed: matched > 0 });
    }
    if (data.action === "confirm_payment") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ orderId: uid }).parse(data);
      const paid = await markPaid(batch, p.orderId, now, "admin");
      if (!paid) return json({ error: "입금 확인할 주문이 아닙니다." }, 404);
      await notifyPaid(query, paid, p.orderId, now);
      return json({ ok: true });
    }
    if (data.action === "match_deposit") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ depositId: uid, orderId: uid, force: z.boolean().default(false), note: z.string().trim().max(200).default("") }).parse(data);
      const d = (await query<{ id: string; amount: number; depositor: string; depositor_key: string; status: string }>(
        "SELECT id, amount, depositor, depositor_key, status FROM deposits WHERE id=$1", [p.depositId],
      ))[0];
      if (!d || !["received", "unmatched"].includes(d.status)) return json({ error: "처리할 입금 내역이 아닙니다." }, 404);
      const o = (await query<{ id: string; amount: number }>("SELECT id, amount FROM orders WHERE id=$1 AND status IN ('awaiting_payment','payment_reported')", [p.orderId]))[0];
      if (!o) return json({ error: "입금 대기 중인 주문이 아닙니다." }, 404);
      if (o.amount !== d.amount && !(p.force && p.note)) return json({ error: "입금액과 주문 금액이 다릅니다. 강제 연결하려면 사유를 입력해 주세요." }, 400);
      const paid = await markPaid(batch, p.orderId, now, "admin", d.id, d.depositor);
      if (!paid) {
        await query("UPDATE deposits SET status='unmatched', reason='stale' WHERE id=$1 AND status IN ('received','unmatched')", [d.id]);
        return json({ error: "이미 처리된 주문입니다." }, 404);
      }
      if (p.note) await query("UPDATE deposits SET note=$2 WHERE id=$1", [d.id, p.note]);
      await notifyPaid(query, paid, p.orderId, now);
      return json({ ok: true });
    }
    if (data.action === "dismiss_deposit") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ depositId: uid, note: z.string().trim().min(1).max(200) }).parse(data);
      const rows = await query("UPDATE deposits SET status='dismissed', note=$2, resolved_at=$3, resolved_by=$4 WHERE id=$1 AND status IN ('received','unmatched') RETURNING id", [p.depositId, p.note, now, "admin"]);
      if (!rows.length) return json({ error: "처리할 입금 내역이 아닙니다." }, 404);
      return json({ ok: true });
    }
    if (data.action === "record_deposit") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ depositor: z.string().trim().min(1).max(80), amount: z.number().int().positive().max(MONEY_CAP), occurredAt: z.string().max(40).optional(), memo: z.string().max(200).optional() }).parse(data);
      const result = await recordDeposit(query, batch, { provider: "manual", eventId: crypto.randomUUID(), ...p }, now);
      return json({ ok: true, ...result });
    }
    if (data.action === "retry_deposit") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ depositId: uid }).parse(data);
      const d = (await query<{ id: string; amount: number; depositor: string; depositor_key: string }>(
        "UPDATE deposits SET status='received' WHERE id=$1 AND status IN ('received','unmatched') RETURNING id, amount, depositor, depositor_key", [p.depositId],
      ))[0];
      if (!d) return json({ error: "처리할 입금 내역이 아닙니다." }, 404);
      const result = await matchDeposit(query, batch, { id: d.id, amount: d.amount, key: d.depositor_key, depositor: d.depositor }, now);
      return json({ ok: true, ...result });
    }
    if (data.action === "mark_shipped") {
      // Shipment photos (quantity and condition at pickup) are the evidence for later disputes.
      const p = z.object({ orderId: uid, photos: photoList.min(1, "출고할 재고의 수량과 상태가 보이는 사진을 1장 이상 올려 주세요.") }).parse(data);
      if (!(await query("SELECT 1 FROM orders WHERE id=$1 AND seller_id=$2 AND status='paid'", [p.orderId, userId])).length)
        return json({ error: "출고 처리할 내 주문이 아닙니다." }, 404);
      if (!(await ownedImages(p.photos, userId))) return json({ error: "직접 올린 사진만 첨부할 수 있습니다." }, 400);
      const rows = await query<{ buyer_id: string; product_title: string }>(
        "UPDATE orders SET status='shipped', shipped_at=$3, ship_photos=$4, auto_complete_at=$5 WHERE id=$1 AND seller_id=$2 AND status='paid' RETURNING buyer_id, product_title",
        [p.orderId, userId, now, JSON.stringify(p.photos), new Date(nowDate.getTime() + AUTO_CONFIRM_DAYS * 86400000).toISOString()],
      );
      if (!rows.length) return json({ error: "출고 처리할 내 주문이 아닙니다." }, 404);
      await notify(query, [rows[0].buyer_id], {
        kind: "shipped", title: `출고 완료 · ${rows[0].product_title}`,
        body: `공급자가 출고 사진과 함께 출고를 완료했습니다. 재고를 받으면 상태를 확인하고 수령 확인을 눌러 주세요. 문제가 있으면 수령 확인 전에 신고해 주세요. ${AUTO_CONFIRM_DAYS}일 동안 응답이 없으면 자동으로 수령 확인됩니다.`,
        refType: "order", refId: p.orderId,
      }, now);
      return json({ ok: true });
    }
    if (data.action === "open_dispute") {
      const p = z.object({
        orderId: uid,
        kind: z.enum(["buyer_cancel", "misrepresentation", "not_shipped", "other"]),
        description: z.string().trim().min(5, "신고 내용을 5자 이상 적어 주세요.").max(2000),
        photos: photoList.default([]),
      }).parse(data);
      if (!(await ownedImages(p.photos, userId))) return json({ error: "직접 올린 사진만 첨부할 수 있습니다." }, 400);
      const r = await openDispute(query, { ...p, userId }, now);
      if (!r.ok) return json({ error: r.error }, r.status);
      return json({ ok: true, id: r.id }, 201);
    }
    if (data.action === "respond_dispute") {
      const p = z.object({ disputeId: uid, text: z.string().trim().min(2).max(2000), photos: photoList.default([]) }).parse(data);
      if (!(await ownedImages(p.photos, userId))) return json({ error: "직접 올린 사진만 첨부할 수 있습니다." }, 400);
      if (!(await respondDispute(query, { ...p, userId }, now))) return json({ error: "소명을 남길 수 있는 신고가 아닙니다." }, 404);
      return json({ ok: true });
    }
    if (data.action === "resolve_dispute") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({
        disputeId: uid,
        resolution: z.enum(["release", "cancel_refund", "partial_refund"]),
        refundAmount: z.number().int().optional(),
        penaltyParty: z.enum(["buyer", "seller"]).nullable().default(null),
        note: z.string().trim().max(500).optional(),
      }).parse(data);
      const r = await resolveDispute(query, batch, { ...p, adminId: userId }, now);
      if (!r.ok) return json({ error: r.error }, r.status);
      return json({ ok: true, refund: r.refund, penalty: r.penalty });
    }
    if (data.action === "settle_penalty") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ disputeId: uid, status: z.enum(["paid", "waived"]) }).parse(data);
      if (!(await settlePenalty(query, p.disputeId, p.status, now))) return json({ error: "미납 위약금이 아닙니다." }, 404);
      return json({ ok: true });
    }
    if (data.action === "mark_refunded") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      // refund_amount is the running total owed; refund_paid what has already been sent.
      // The admin names the amount they saw and sent; a ruling in between makes it a 409.
      const p = z.object({ orderId: uid, amount: z.number().int().positive() }).parse(data);
      const rows = await query<{ buyer_id: string; product_title: string; sent: number }>(
        `UPDATE orders SET refund_paid=refund_paid + $3::int, refunded_at=$2
         WHERE id=$1 AND refund_amount - refund_paid = $3::int
         RETURNING buyer_id, product_title, $3::int AS sent`,
        [p.orderId, now, p.amount],
      );
      if (!rows.length) {
        const pending = await query("SELECT 1 FROM orders WHERE id=$1 AND refund_amount > refund_paid", [p.orderId]);
        if (pending.length) return json({ error: "환불할 금액이 방금 바뀌었습니다. 새로고침 후 다시 확인해 주세요." }, 409);
        return json({ error: "환불 대기 주문이 아닙니다." }, 404);
      }
      await notify(query, [rows[0].buyer_id], {
        kind: "refunded", title: `환불 완료 · ${rows[0].product_title}`,
        body: `${rows[0].sent.toLocaleString("ko-KR")}원을 환불했습니다.`, refType: "order", refId: p.orderId,
      }, now);
      return json({ ok: true });
    }
    if (data.action === "admin_cancel_auction") {
      // For suspected self-dealing or a bad listing: stops the auction without creating an order.
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ productId: uid, reason: z.string().trim().min(2).max(200) }).parse(data);
      const results = await batch([
        lockStatement(p.productId),
        {
          sql: "UPDATE auctions SET status='cancelled', close_reason='admin_cancelled', closed_at=$2, decision_stage=NULL WHERE listing_id=$1 AND status IN ('active','deciding') RETURNING seller_id",
          params: [p.productId, now],
        },
        {
          sql: "UPDATE listings SET status='archived' WHERE id=$1 AND status IN ('active','pending') AND EXISTS (SELECT 1 FROM auctions WHERE listing_id=$1 AND close_reason='admin_cancelled' AND closed_at=$2)",
          params: [p.productId, now],
        },
      ]);
      if (results[1].rowCount !== 1) return json({ error: "중단할 수 있는 경매가 아닙니다." }, 404);
      const sellerId = (results[1].rows[0] as { seller_id: string }).seller_id;
      const bidders = await query<{ bidder_id: string }>("SELECT DISTINCT bidder_id FROM bids WHERE listing_id=$1", [p.productId]);
      const title = ((await query<{ document: string }>("SELECT document FROM listings WHERE id=$1", [p.productId]))[0]?.document ?? "{}");
      const name = (JSON.parse(title) as { title?: string }).title ?? "재고";
      await notify(query, [sellerId, ...bidders.map((b) => b.bidder_id)], {
        kind: "auction_cancelled", title: `경매 중단 · ${name}`,
        body: `운영자가 경매를 중단했습니다. 사유: ${p.reason}`, refType: "listing", refId: p.productId,
      }, now);
      return json({ ok: true });
    }
    if (data.action === "confirm_received") {
      const p = z.object({ orderId: uid }).parse(data);
      const rows = await query<{ seller_id: string; product_title: string; net: number }>(
        "UPDATE orders SET status='completed', completed_at=$3 WHERE id=$1 AND buyer_id=$2 AND status IN ('paid','shipped') AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id=orders.id AND d.status='open') RETURNING seller_id, product_title, net",
        [p.orderId, userId, now],
      );
      if (!rows.length) return json({ error: "인수 완료할 수 없는 주문입니다. 처리 중인 신고가 있으면 운영자 결정을 기다려 주세요." }, 404);
      await notify(query, [rows[0].seller_id], {
        kind: "completed", title: `거래 완료 · ${rows[0].product_title}`,
        body: `구매자가 인수를 확인했습니다. 수수료를 제외한 ${rows[0].net.toLocaleString("ko-KR")}원이 정산 계좌로 지급됩니다.`, refType: "order", refId: p.orderId,
      }, now);
      await notify(query, adminIds(), {
        kind: "admin_settle", title: `정산 대기 · ${rows[0].product_title}`,
        body: `공급자 정산액 ${rows[0].net.toLocaleString("ko-KR")}원. 관리 탭에서 정산을 완료해 주세요.`, refType: "order", refId: p.orderId,
      }, now);
      return json({ ok: true });
    }
    if (data.action === "settle_order") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ orderId: uid }).parse(data);
      const rows = await query<{ seller_id: string; product_title: string; net: number }>(
        `UPDATE orders SET status='settled', settled_at=$2 WHERE id=$1 AND status='completed'
           AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id=orders.id AND d.status='open') RETURNING seller_id, product_title, net`,
        [p.orderId, now],
      );
      if (!rows.length) return json({ error: "정산할 주문이 아닙니다." }, 404);
      await notify(query, [rows[0].seller_id], {
        kind: "settled", title: `정산 완료 · ${rows[0].product_title}`,
        body: `${rows[0].net.toLocaleString("ko-KR")}원을 정산 계좌로 지급했습니다.`, refType: "order", refId: p.orderId,
      }, now);
      return json({ ok: true });
    }
    if (data.action === "cancel_order") {
      if (!isAdmin) return json({ error: "운영자만 처리할 수 있습니다." }, 403);
      const p = z.object({ orderId: uid, reason: z.string().trim().min(1).max(200) }).parse(data);
      const o = await cancelOrder(query, p.orderId, now, p.reason, ["awaiting_payment", "payment_reported", "offered"], { noOpenDispute: true });
      if (!o) {
        const open = await query("SELECT 1 FROM disputes WHERE order_id=$1 AND status='open'", [p.orderId]);
        if (open.length) return json({ error: "처리 중인 분쟁이 있습니다. 분쟁·위약금에서 취소·환불로 처리해 주세요." }, 409);
        return json({ error: "취소할 수 있는 주문이 아닙니다." }, 404);
      }
      await afterCancel(query, batch, o, now, "admin", p.reason);
      return json({ ok: true });
    }
    if (data.action === "push_subscribe") {
      const p = z.object({
        endpoint: z.string().url().max(2000).refine(validPushEndpoint, "허용되지 않은 푸시 엔드포인트입니다."),
        keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(5).max(100) }),
        userAgent: z.string().max(300).optional(),
      }).parse(data.subscription);
      await query(
        `INSERT INTO push_subscriptions(endpoint, user_id, p256dh, auth, user_agent, created_at, last_used_at)
         VALUES($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, last_used_at=excluded.last_used_at, fail_count=0`,
        [p.endpoint, userId, p.keys.p256dh, p.keys.auth, p.userAgent ?? null, now],
      );
      return json({ ok: true });
    }
    if (data.action === "push_unsubscribe") {
      const p = z.object({ endpoint: z.string().max(2000) }).parse(data);
      await query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2", [p.endpoint, userId]);
      return json({ ok: true });
    }
    if (data.action === "read_notifications") {
      await query("UPDATE notifications SET read_at=$2 WHERE user_id=$1 AND read_at IS NULL", [userId, now]);
      return json({ ok: true });
    }
    if (data.action === "create_offer") {
      const profile = await db.prepare("SELECT public_alias FROM profiles WHERE user_id=?")
        .bind(userId).first<{ public_alias: string | null }>();
      if (!profile?.public_alias)
        return json({ error: "사업자 주소를 등록하고 거래 별칭을 먼저 배정받아 주세요." }, 400);
      const p = z
        .object({
          id: z.string().uuid(),
          productId: uid,
          quantity,
          price,
          shipping: z.enum(["직접 픽업", "택배", "화물 배송", "배송 협의"]),
          note: z.string().trim().max(2000),
        })
        .parse(data);
      const product = await findProduct(p.productId);
      if (!product)
        return json({ error: "현재 거래 가능한 상품이 아닙니다." }, 404);
      if (product.saleType === "auction")
        return json({ error: "경매 상품은 입찰로 참여해 주세요." }, 400);
      if (product.ownerId === userId)
        return json(
          { error: "내가 등록한 재고에는 견적을 요청할 수 없습니다." },
          400,
        );
      if (daysLeft(product.deadline) < 0)
        return json({ error: "마감된 재고입니다." }, 400);
      if (p.quantity < product.moq || p.quantity > product.stock)
        return json(
          {
            error: `수량은 ${product.moq}~${product.stock}${product.unit} 범위로 입력해 주세요.`,
          },
          400,
        );
      const previous = await db
        .prepare("SELECT buyer_id FROM offers WHERE id=?")
        .bind(p.id)
        .first<{ buyer_id: string }>();
      if (previous)
        return previous.buyer_id === userId
          ? json({ ok: true, id: p.id })
          : json({ error: "요청을 다시 시작해 주세요." }, 409);
      await db
        .prepare(
          "INSERT INTO offers(id,buyer_id,seller_id,product_id,product_title,image,unit,quantity,price,shipping,note,status,sample,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          p.id,
          userId,
          product.ownerId || "sample-seller",
          product.id,
          product.title,
          product.image,
          product.unit,
          p.quantity,
          p.price,
          p.shipping,
          p.note,
          "pending",
          product.sample ? 1 : 0,
          now,
        )
        .run();
      return json({ ok: true, id: p.id }, 201);
    }
    if (data.action === "message") {
      const p = z
        .object({ offerId: uid, body: z.string().trim().min(1).max(2000) })
        .parse(data);
      const offer = await db
        .prepare(
          "SELECT id FROM offers WHERE id=? AND (buyer_id=? OR seller_id=?)",
        )
        .bind(p.offerId, userId, userId)
        .first();
      if (!offer) return json({ error: "접근할 수 없는 거래입니다." }, 404);
      await db
        .prepare(
          "INSERT INTO messages(id,offer_id,author_id,body,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(crypto.randomUUID(), p.offerId, userId, p.body, now)
        .run();
      return json({ ok: true });
    }
    if (data.action === "respond") {
      const p = z
        .object({
          id: uid,
          response: z.enum([
            "accept",
            "reject",
            "counter",
            "accept_counter",
            "cancel",
          ]),
          price: price.optional(),
        })
        .parse(data);
      const offer = await db
        .prepare(
          "SELECT buyer_id,seller_id,status,sample FROM offers WHERE id=? AND (buyer_id=? OR seller_id=?)",
        )
        .bind(p.id, userId, userId)
        .first<{
          buyer_id: string;
          seller_id: string;
          status: string;
          sample: number;
        }>();
      if (!offer) return json({ error: "거래를 찾을 수 없습니다." }, 404);
      if (!["pending", "countered"].includes(offer.status))
        return json({ error: "이미 처리된 제안입니다." }, 409);
      const isSeller = offer.seller_id === userId;
      if (
        ["accept", "reject", "counter"].includes(p.response) &&
        (!isSeller || offer.sample)
      )
        return json({ error: "공급자만 처리할 수 있습니다." }, 403);
      if (
        ["cancel", "accept_counter"].includes(p.response) &&
        offer.buyer_id !== userId
      )
        return json({ error: "구매자만 처리할 수 있습니다." }, 403);
      if (p.response === "accept_counter" && offer.status !== "countered")
        return json({ error: "재제안된 가격이 없습니다." }, 400);
      if (p.response === "accept" && offer.status !== "pending")
        return json({ error: "구매자의 응답을 기다려 주세요." }, 400);
      if (p.response === "counter" && !p.price)
        return json({ error: "재제안 단가를 입력해 주세요." }, 400);
      const next = {
        accept: "accepted",
        reject: "rejected",
        counter: "countered",
        accept_counter: "accepted",
        cancel: "cancelled",
      }[p.response];
      const sql =
        p.response === "counter"
          ? "UPDATE offers SET status=?,price=? WHERE id=? AND status=?"
          : "UPDATE offers SET status=? WHERE id=? AND status=?";
      const result = await (
        p.response === "counter"
          ? db.prepare(sql).bind(next, p.price, p.id, offer.status)
          : db.prepare(sql).bind(next, p.id, offer.status)
      ).run();
      if (!result.meta.changes)
        return json(
          { error: "제안 상태가 바뀌었습니다. 새로고침해 주세요." },
          409,
        );
      return json({ ok: true });
    }
    return json({ error: "지원하지 않는 요청입니다." }, 400);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues[0]?.message || "입력 내용을 확인해 주세요." },
        400,
      );
    if (error instanceof SyntaxError)
      return json({ error: "입력 형식을 확인해 주세요." }, 400);
    console.error(
      "Market write failed",
      error instanceof Error ? error.message : "Unknown",
    );
    return json(
      {
        error:
          "저장하지 못했습니다. 입력 내용은 유지되니 잠시 후 다시 시도해 주세요.",
      },
      503,
    );
  }
}
