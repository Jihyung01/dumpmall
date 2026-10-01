import { createHash } from "node:crypto";
import { getUser } from "@/lib/auth/server";
import { batch, query } from "@/db";
import { adminIds, minimumBid, processAuctions, type AuctionRow } from "@/lib/auction-core";
import { installPushHook } from "@/lib/push";
export const dynamic = "force-dynamic";
installPushHook();
// Lightweight live state for one auction, polled every few seconds by the
// detail screen. One query decides whether anything changed (ETag → 304); the
// full payload never contains the reserve price for buyers.
type Row = Pick<AuctionRow,
  "listing_id" | "seller_id" | "status" | "mode" | "current_price" | "current_bidder_id" | "instant_price" | "bid_count" |
  "ends_at" | "extended_count" | "start_price" | "reserve_price" | "decision_stage" | "decision_due_at" | "quantity" | "unit" | "close_reason">;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const user = await getUser();
    const now = new Date();
    let a = (await query<Row>(
      `SELECT listing_id, seller_id, status, mode, current_price, current_bidder_id, instant_price, bid_count, ends_at, extended_count,
              start_price, reserve_price, decision_stage, decision_due_at, quantity, unit, close_reason FROM auctions WHERE listing_id=$1`,
      [id],
    ))[0];
    if (!a) return Response.json({ error: "Not found" }, { status: 404, headers });
    // Close lazily the moment the deadline passes, for this listing only.
    if ((a.status === "active" && a.ends_at <= now.toISOString()) || (a.status === "deciding" && a.decision_due_at && a.decision_due_at <= now.toISOString())) {
      await processAuctions(query, now, batch, { listingIds: [id] });
      a = (await query<Row>(
        `SELECT listing_id, seller_id, status, mode, current_price, current_bidder_id, instant_price, bid_count, ends_at, extended_count,
                start_price, reserve_price, decision_stage, decision_due_at, quantity, unit, close_reason FROM auctions WHERE listing_id=$1`,
        [id],
      ))[0];
    }
    const viewer = user?.userId ?? "";
    const privileged = !!user && (user.userId === a.seller_id || adminIds().includes(user.userId));
    // Below-reserve deciding is visible only to the seller, admins and the top bidder.
    const status = !privileged && a.status === "deciding" && a.current_bidder_id !== viewer ? "won" : a.status;
    const version = createHash("sha256")
      // Hash only what this viewer may see: the version must not tell a hidden deciding state apart.
      .update([status, a.current_price, a.instant_price, a.bid_count, a.ends_at, privileged || a.current_bidder_id === viewer ? a.decision_stage : "",
        a.current_bidder_id === viewer, privileged ? a.reserve_price : ""].join("|"))
      .digest("base64url").slice(0, 16);
    const etag = `W/"${version}"`;
    const serverTime = now.toISOString();
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers: { ...headers, ETag: etag, "X-Server-Time": serverTime } });
    const [bids, counts, mine] = await Promise.all([
      query<{ id: string; amount: number; quantity: number | null; created_at: string; alias: string | null; mine: boolean; status: string }>(
        `SELECT b.id, b.amount, b.quantity, b.created_at, p.public_alias AS alias, (b.bidder_id=$2) AS mine, b.status
         FROM bids b LEFT JOIN profiles p ON p.user_id=b.bidder_id
         WHERE b.listing_id=$1 AND (b.quantity IS NULL OR b.status<>'replaced') ORDER BY b.created_at DESC LIMIT 20`,
        [id, viewer],
      ),
      query<{ bidders: number }>("SELECT COUNT(DISTINCT bidder_id)::int AS bidders FROM bids WHERE listing_id=$1", [id]),
      viewer
        ? query<{ top: number | null }>("SELECT MAX(amount)::int AS top FROM bids WHERE listing_id=$1 AND bidder_id=$2", [id, viewer])
        : Promise.resolve([{ top: null }]),
    ]);
    const body = {
      listingId: a.listing_id,
      version,
      serverTime,
      status,
      mode: a.mode,
      currentPrice: a.current_price,
      instantPrice: a.mode === "whole" ? a.instant_price : null,
      startPrice: a.start_price,
      bidCount: a.bid_count,
      bidderCount: counts[0]?.bidders ?? 0,
      endsAt: a.ends_at,
      extendedCount: a.extended_count,
      quantity: a.quantity,
      unit: a.unit,
      minimumBid: a.mode === "whole" ? minimumBid(a) : null,
      leading: !!viewer && a.current_bidder_id === viewer,
      myTopBid: mine[0]?.top ?? null,
      bids: bids.map((b) => ({ id: b.id, amount: b.amount, quantity: b.quantity, createdAt: b.created_at, alias: b.mine ? "나" : b.alias || "구매자", mine: b.mine })),
      ...(privileged
        ? {
          reservePrice: a.reserve_price,
          reserveMet: a.current_price !== null && a.current_price >= a.reserve_price,
          decisionStage: a.decision_stage,
          decisionDueAt: a.decision_due_at,
          closeReason: a.close_reason,
        }
        : {}),
    };
    return Response.json(body, { headers: { ...headers, ETag: etag } });
  } catch (error) {
    console.error("Live auction read failed", error instanceof Error ? error.message : "Unknown");
    return Response.json({ error: "Unavailable" }, { status: 503, headers });
  }
}
