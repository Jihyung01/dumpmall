import { batch, query } from "@/db";
import { processAuctions } from "@/lib/auction-core";
import { rematchDeposits } from "@/lib/deposits";
import { installPushHook, prunePushSubscriptions } from "@/lib/push";
export const dynamic = "force-dynamic";
installPushHook();
// Vercel Cron (or any scheduler) can call this with the CRON_SECRET bearer
// token. Market reads also run the same transitions lazily, so the schedule
// only guarantees timely notifications while the site is idle.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await processAuctions(query, new Date(), batch);
    const prunedPush = await prunePushSubscriptions();
    const rematched = await rematchDeposits(query, batch, new Date().toISOString());
    return Response.json({ ok: true, ...result, prunedPush, rematched }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Auction cron failed", error instanceof Error ? error.message : "Unknown");
    return Response.json({ error: "Auction processing failed" }, { status: 503 });
  }
}
