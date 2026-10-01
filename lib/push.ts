import "server-only";
import { after } from "next/server";
import webpush from "web-push";
import { query } from "@/db";
import { setNotifyHook, type NotifyNote } from "./auction-core";

// Web Push over VAPID. Activates only when both keys exist; otherwise every
// call is a no-op so the in-app notification feed keeps working alone.
export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
let configured = false;
function ensure() {
  if (configured || !pushConfigured()) return configured;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "https://dumpmall.com",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  configured = true;
  return true;
}
type SubscriptionRow = { endpoint: string; p256dh: string; auth: string; user_id: string };
export function noteUrl(note: NotifyNote) {
  if (note.refType === "order" && note.refId) return `/?view=trades&tab=orders&order=${note.refId}`;
  if (note.refType === "listing" && note.refId) return `/?product=${note.refId}`;
  return "/?view=trades&tab=alerts";
}
export async function sendPush(userIds: string[], note: NotifyNote) {
  if (!ensure()) return { sent: 0, removed: 0 };
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return { sent: 0, removed: 0 };
  const rows = await query<SubscriptionRow>(
    "SELECT endpoint, p256dh, auth, user_id FROM push_subscriptions WHERE user_id = ANY($1::text[])",
    [ids],
  );
  const topic = `${note.kind}:${(note.refId ?? "").slice(0, 8)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const payload = JSON.stringify({ title: note.title, body: note.body, url: noteUrl(note), kind: note.kind, tag: topic || "dumpmall" });
  const urgent = ["outbid", "auction_won", "auction_partial_won", "succession_offer", "contact_revealed", "admin_deposit_unmatched", "admin_payment"].includes(note.kind);
  const now = new Date().toISOString();
  let sent = 0, removed = 0;
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        payload,
        { TTL: 60 * 60 * 24, urgency: urgent ? "high" : "normal", topic: topic || undefined },
      );
      sent++;
      await query("UPDATE push_subscriptions SET last_used_at=$2, fail_count=0 WHERE endpoint=$1", [r.endpoint, now]);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await query("DELETE FROM push_subscriptions WHERE endpoint=$1", [r.endpoint]);
        removed++;
      } else {
        await query("UPDATE push_subscriptions SET fail_count=fail_count+1, last_failed_at=$2 WHERE endpoint=$1", [r.endpoint, now]);
        console.error("Push failed", status ?? (error instanceof Error ? error.message : "Unknown"));
      }
    }
  }));
  return { sent, removed };
}
// Cron only: drop endpoints that keep failing or have not been used for 90 days.
export async function prunePushSubscriptions() {
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = await query<{ endpoint: string }>(
    "DELETE FROM push_subscriptions WHERE fail_count >= 8 OR COALESCE(last_used_at, created_at) < $1 RETURNING endpoint",
    [cutoff],
  );
  return rows.length;
}
// Endpoints must be public https push services, never internal hosts.
export function validPushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return false;
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return false;
  return true;
}
// Register once per server instance so every notify() also pushes.
let installed = false;
export function installPushHook() {
  if (installed) return;
  installed = true;
  // Delivery never blocks the response: schedule it after the response is sent
  // (next/server after); outside a request scope fall back to awaiting.
  setNotifyHook((userIds, note) => {
    const send = () => sendPush(userIds, note).catch((error) =>
      console.error("Push hook failed", error instanceof Error ? error.message : "Unknown"));
    try {
      after(send);
      return Promise.resolve();
    } catch {
      return send().then(() => undefined);
    }
  });
}
