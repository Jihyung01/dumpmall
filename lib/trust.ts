// Trust & anti-abuse helpers: business-number checks, NTS status lookup,
// hashed IP signals and unpaid-penalty gates. Framework-free (injected query)
// so scripts can use it; `ipHashFrom` uses node:crypto only.
import { createHmac } from "node:crypto";
import type { Query } from "./auction-core";

// Korean business registration number checksum (10 digits).
export function businessNumberValid(value: string) {
  if (!/^\d{10}$/.test(value)) return false;
  const d = [...value].map(Number);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * w[i];
  sum += Math.floor((d[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}

export type BusinessStatus = "active" | "suspended" | "closed" | "unregistered" | "unchecked";
// The status API says whether the number is operating, not who owns it; labels say only that.
export const businessStatusLabels: Record<BusinessStatus, string> = {
  active: "국세청 조회 · 계속사업자 번호",
  suspended: "국세청 조회 · 휴업 번호",
  closed: "국세청 조회 · 폐업 번호",
  unregistered: "국세청 미등록 번호",
  unchecked: "국세청 조회 전",
};
// 공공데이터포털 "국세청_사업자등록정보 진위확인 및 상태조회 서비스" (status).
// Enabled only when NTS_SERVICE_KEY (the *decoding* key) is set.
export async function ntsBusinessStatus(businessNumber: string, fetcher: typeof fetch = fetch): Promise<BusinessStatus> {
  const key = process.env.NTS_SERVICE_KEY;
  if (!key) return "unchecked";
  try {
    const response = await fetcher(
      `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ b_no: [businessNumber] }),
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return "unchecked";
    const body = (await response.json()) as { data?: { b_stt_cd?: string; tax_type?: string }[] };
    const row = body.data?.[0];
    if (!row) return "unchecked";
    if (row.b_stt_cd === "01") return "active";
    if (row.b_stt_cd === "02") return "suspended";
    if (row.b_stt_cd === "03") return "closed";
    if (row.tax_type && row.tax_type.includes("등록되지 않은")) return "unregistered";
    return "unchecked";
  } catch {
    return "unchecked";
  }
}

// Only a keyed hash of the client IP is ever stored.
export function ipHashFrom(headers: Headers) {
  const raw = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
  const secret = process.env.IP_HASH_SECRET || process.env.NEON_AUTH_COOKIE_SECRET || "dumpmall-ip";
  return createHmac("sha256", `${secret}:ip-v1`).update(raw).digest("hex").slice(0, 32);
}
export async function recordActivity(query: Query, userId: string, ipHash: string, now: string) {
  await query(
    `INSERT INTO activity_ips(user_id, ip_hash, first_seen, last_seen, hits) VALUES($1,$2,$3,$3,1)
     ON CONFLICT (user_id, ip_hash) DO UPDATE SET last_seen=excluded.last_seen, hits=activity_ips.hits+1`,
    [userId, ipHash, now],
  );
}
// penaltyDue lives in auction-core (no Node imports there, the client bundle uses it too).
export { penaltyDue } from "./auction-core";
export async function sameBusiness(query: Query, a: string, b: string) {
  const rows = await query<{ same: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM profiles x JOIN profiles y ON y.business_number = x.business_number
       WHERE x.user_id=$1 AND y.user_id=$2) AS same`,
    [a, b],
  );
  return rows[0]?.same === true;
}
// Admin review list: bidders who share a hashed IP or business number with the seller.
export type FraudSignal = {
  listingId: string; title: string; sellerAlias: string; bidderAlias: string;
  sharedIps: number; sameBusiness: boolean; bids: number; status: string; lastBidAt: string;
};
export async function fraudSignals(query: Query, sinceIso: string): Promise<FraudSignal[]> {
  return query<FraudSignal>(
    `SELECT * FROM (
       SELECT p.listing_id AS "listingId",
         COALESCE((SELECT document::json->>'title' FROM listings WHERE id=p.listing_id),'재고') AS title,
         COALESCE((SELECT public_alias FROM profiles WHERE user_id=p.seller_id),'공급자') AS "sellerAlias",
         COALESCE((SELECT public_alias FROM profiles WHERE user_id=p.bidder_id),'구매자') AS "bidderAlias",
         (SELECT COUNT(*)::int FROM activity_ips s JOIN activity_ips t ON t.ip_hash=s.ip_hash AND t.user_id=p.bidder_id WHERE s.user_id=p.seller_id) AS "sharedIps",
         EXISTS (SELECT 1 FROM profiles s JOIN profiles t ON t.business_number=s.business_number WHERE s.user_id=p.seller_id AND t.user_id=p.bidder_id) AS "sameBusiness",
         p.bids, p.status, p.last_bid AS "lastBidAt"
       FROM (
         SELECT b.listing_id, a.seller_id, b.bidder_id, a.status, COUNT(*)::int AS bids, MAX(b.created_at) AS last_bid
         FROM bids b JOIN auctions a ON a.listing_id=b.listing_id
         WHERE a.created_at >= $1
         GROUP BY b.listing_id, a.seller_id, b.bidder_id, a.status
       ) p
     ) x WHERE x."sharedIps" > 0 OR x."sameBusiness"
     ORDER BY x."lastBidAt" DESC LIMIT 100`,
    [sinceIso],
  );
}
