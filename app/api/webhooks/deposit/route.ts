import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { batch, query } from "@/db";
import { recordDeposit } from "@/lib/deposits";
import { installPushHook } from "@/lib/push";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
installPushHook();
// Bank-notification / PG deposit webhook. Auth: HMAC (preferred) or a static
// secret header (weaker, for fixed-header SMS forwarders). Never echoes the
// depositor name. Responds 200 for processed, duplicate and unmatched events.
const bodySchema = z.object({
  provider: z.enum(["bank", "manual", "sms"]).default("bank"),
  eventId: z.string().min(1).max(120).optional(),
  amount: z.number().int().positive().max(2_000_000_000).optional(),
  depositor: z.string().trim().min(1).max(80).optional(),
  occurredAt: z.string().max(40).optional(),
  memo: z.string().max(200).optional(),
  text: z.string().max(1000).optional(),
});
const sha = (v: string) => createHash("sha256").update(v).digest();
function authorized(request: Request, raw: string, secret: string) {
  const signature = request.headers.get("x-deposit-signature");
  if (signature) {
    const parts = Object.fromEntries(signature.split(",").map((p) => p.trim().split("=") as [string, string]));
    const t = Number(parts.t), v1 = parts.v1 || "";
    if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
    const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    return timingSafeEqual(sha(expected), sha(v1));
  }
  const given = request.headers.get("x-deposit-secret");
  if (!given || secret.length < 32) return false;
  return timingSafeEqual(sha(given), sha(secret));
}
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 8192) return Response.json({ error: "Payload too large" }, { status: 413 });
  if (!request.headers.get("content-type")?.includes("application/json"))
    return Response.json({ error: "JSON only" }, { status: 415 });
  const secret = process.env.DEPOSIT_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "Deposit webhook is not configured" }, { status: 503 });
  if (!authorized(request, raw, secret)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let parsed;
  try {
    parsed = bodySchema.parse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  try {
    const result = await recordDeposit(query, batch, parsed, new Date().toISOString());
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Deposit webhook failed", error instanceof Error ? error.message : "Unknown");
    return Response.json({ error: "Deposit processing failed" }, { status: 503 });
  }
}
export function GET() {
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
}
