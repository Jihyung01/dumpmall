import type { Product } from "./catalog";
export type Profile = {
  company: string;
  businessNumber: string;
  phone: string;
  region: string;
  businessAddress?: string | null;
  districtKey?: string | null;
  publicAlias?: string | null;
  payoutBank?: string | null;
  payoutAccount?: string | null;
  payoutHolder?: string | null;
  businessStatus?: string | null;
  businessCheckedAt?: string | null;
};
export type Offer = {
  id: string;
  buyerId: string;
  sellerId: string;
  buyerAlias?: string | null;
  sellerAlias?: string | null;
  productId: string;
  productTitle: string;
  image: string;
  unit: string;
  quantity: number;
  price: number;
  shipping: string;
  note: string;
  status: "pending" | "countered" | "accepted" | "rejected" | "cancelled";
  sample: number;
  createdAt: string;
};
export type Message = {
  id: string;
  offerId: string;
  authorId: string;
  body: string;
  createdAt: string;
};
export type AuctionStatus = "active" | "deciding" | "won" | "unsold" | "cancelled";
export type Auction = {
  listingId: string;
  quantity: number;
  unit: string;
  startPrice: number;
  currentPrice: number | null;
  bidCount: number;
  startsAt: string;
  midpointAt: string;
  endsAt: string;
  status: AuctionStatus;
  /** Seller/admin only: never sent to buyers (it would hint at the hidden reserve). */
  closeReason?: string | null;
  /** Seller/admin only. */
  reserveMet?: boolean;
  extendedCount: number;
  /** Public "buy it now" price; a bid at or above it wins immediately. */
  instantPrice: number | null;
  bidderCount: number;
  /** Set while a whole-lot auction that ended below reserve waits for the seller. */
  decisionStage?: "seller" | null;
  decisionDueAt?: string | null;
  mode: "whole" | "partial";
  minLot: number;
  soldQuantity: number;
  unsoldQuantity: number;
  successionEnabled: boolean;
  /** Partial mode: lowest winning unit price once fully subscribed. */
  cutoffPrice: number | null;
  subscribedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  minimumBid?: number;
  /** Only present for the seller. */
  reservePrice?: number;
  midpointAlertedAt?: string | null;
  sellableQuantity?: number;
  fillPrice?: number | null;
  /** Only present for the signed-in viewer. */
  myTopBid?: number | null;
  leading?: boolean;
  myBid?: { id: string; unitPrice: number; quantity: number; allocated: number; state: "full" | "partial" | "out" };
};
export type Bid = {
  id: string;
  listingId: string;
  amount: number;
  alias: string;
  mine: boolean;
  createdAt: string;
  quantity: number | null;
  allocated: number | null;
  status: string;
};
export type DisputeKind = "buyer_cancel" | "misrepresentation" | "not_shipped" | "other" | "no_payment";
export type Dispute = {
  id: string;
  orderId: string;
  listingId: string;
  openerRole: "buyer" | "seller" | "system";
  mine: boolean;
  kind: DisputeKind;
  description: string;
  photos: string[];
  response: string | null;
  responsePhotos: string[];
  status: "open" | "resolved";
  resolution: "release" | "cancel_refund" | "partial_refund" | "cancel" | null;
  refundAmount: number;
  penaltyParty: "buyer" | "seller" | null;
  penaltyAmount: number;
  penaltyStatus: "none" | "due" | "paid" | "waived";
  adminNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** Admin view only. */
  productTitle?: string;
  amount?: number;
  buyerAlias?: string;
  sellerAlias?: string;
  orderStatus?: string;
  shipPhotos?: string[];
};
export type FraudSignal = {
  listingId: string; title: string; sellerAlias: string; bidderAlias: string;
  sharedIps: number; sameBusiness: boolean; bids: number; status: string; lastBidAt: string;
};
export type Deposit = {
  id: string;
  provider: string;
  depositor: string;
  amount: number;
  occurredAt: string | null;
  status: string;
  reason: string | null;
  candidates: string[];
  note: string | null;
  receivedAt: string;
  orderId: string | null;
};
export type OrderStatus =
  | "offered"
  | "awaiting_payment"
  | "payment_reported"
  | "paid"
  | "shipped"
  | "completed"
  | "settled"
  | "cancelled";
export type Contact = {
  alias: string;
  company: string;
  phone: string;
  businessAddress: string;
};
export type Order = {
  id: string;
  listingId: string;
  sellerId: string;
  buyerId: string;
  buyerAlias: string;
  sellerAlias: string;
  productTitle: string;
  image: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  feeRate: number;
  fee: number;
  net: number;
  status: OrderStatus;
  depositor: string | null;
  paymentDueAt: string;
  reportedAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  depositCode: string | null;
  paidBy: string | null;
  successionRound: number;
  parentOrderId: string | null;
  bidQuantity: number | null;
  offerExpiresAt: string | null;
  offerKind: "succession" | "below_reserve" | null;
  shipPhotos: string[];
  autoCompleteAt: string | null;
  refundAmount: number;
  /** Part of refundAmount already sent to the buyer. */
  refundPaid: number;
  refundedAt: string | null;
  /** Revealed to both parties once payment is confirmed. */
  counterpart?: Contact | null;
  /** Admin only: seller payout account for settlement. */
  payout?: { bank: string; account: string; holder: string } | null;
};
export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  refType: string | null;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
};
export type RevenueExtras = { penaltiesCollected: number; penaltiesDue: number; refundsPending: number; refundsPaid: number };
export type RevenueRow = {
  month: string;
  orders: number;
  gmv: number;
  paid: number;
  held: number;
  fee: number;
  payable: number;
  settled: number;
  cancelled: number;
};
export type MarketData = {
  products: Product[];
  user: { id: string; name: string } | null;
  favorites: string[];
  profile: Profile | null;
  offers: Offer[];
  messages: Message[];
  ownListings: Product[];
  bids: Bid[];
  orders: Order[];
  notifications: Notification[];
  unread: number;
  isAdmin: boolean;
  adminOrders: Order[];
  deposits: Deposit[];
  /** Auctions the viewer bid on that have ended (pending decision, sold, unsold). */
  bidListings: Product[];
  disputes: Dispute[];
  /** due includes penalties reaching this account through its business number (viaBusiness). */
  penalty: { due: number; items: Dispute[]; viaBusiness?: boolean };
  /** Admin only. */
  fraud: FraudSignal[];
  duplicateBusiness: { businessNumber: string; aliases: string[] }[];
  revenue: { months: RevenueRow[]; total: RevenueRow; extras: RevenueExtras } | null;
  settings: {
    penaltyRate: number;
    autoConfirmDays: number;
    belowReservePolicy: "seller_decides" | "buyer_only";
    /** Runner-up offers after a cancellation (AUCTION_SUCCESSION=on). Off by default. */
    successionEnabled: boolean;
    /** Unpaid orders carry an automatic penalty (PENALIZE_NONPAYMENT). Off in production. */
    penalizeNonpayment: boolean;
    feeRate: number;
    paymentHours: number;
    bankAccount: string;
    feeTable: { base: number; overrides: Record<string, number> } | null;
    /** Per-category fee rates (fractions) that differ from feeRate. Public, like feeRate. */
    categoryFeeRates: Record<string, number>;
    vapidPublicKey: string;
    depositWebhook: boolean;
  };
};
export async function api(action: Record<string, unknown>) {
  const response = await fetch("/api/market", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dumping-Client": "1" },
    body: JSON.stringify(action),
  });
  const data = (await response.json()) as {
    error?: string;
    ok?: boolean;
    id?: string;
  };
  if (!response.ok)
    throw new Error(
      data.error || "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
  return data;
}
export const statusLabels: Record<Offer["status"], string> = {
  pending: "응답 대기",
  countered: "가격 재제안",
  accepted: "조건 합의",
  rejected: "제안 거절",
  cancelled: "요청 취소",
};
export const orderStatusLabels: Record<OrderStatus, string> = {
  offered: "차순위 제안",
  awaiting_payment: "입금 대기",
  payment_reported: "입금 확인 중",
  paid: "연락처 공개",
  shipped: "출고 완료",
  completed: "거래 완료",
  settled: "정산 완료",
  cancelled: "취소",
};
export function feeRateFor(settings: { feeRate: number; categoryFeeRates?: Record<string, number> }, category?: string) {
  const rate = category ? settings.categoryFeeRates?.[category] : undefined;
  return rate ?? settings.feeRate;
}
// A below-reserve "buy at your bid?" offer is not a runner-up offer.
export function orderStatusLabel(o: { status: OrderStatus; offerKind?: Order["offerKind"] }) {
  return o.status === "offered" && o.offerKind === "below_reserve" ? "구매 의사 확인" : orderStatusLabels[o.status];
}
export const auctionStatusLabels: Record<AuctionStatus, string> = {
  active: "경매 진행 중",
  deciding: "판매 결정 대기",
  won: "낙찰",
  unsold: "유찰",
  cancelled: "경매 취소",
};
