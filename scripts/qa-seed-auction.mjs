import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
// Seeds one live auction with a bid for manual browser checks, or removes it.
//   node --env-file=.env.local scripts/qa-seed-auction.mjs        → prints cookies + ids
//   node --env-file=.env.local scripts/qa-seed-auction.mjs clean  → deletes the QA data
const origin = process.env.TEST_BASE_URL || "http://localhost:3000";
const sql = neon(process.env.DATABASE_URL);
const query = async (text, params = []) => (await sql.query(text, params, { fullResults: true })).rows;
const seller = "qa-ui-seller", buyer = "qa-ui-buyer", admin = "qa-admin-static";
const users = [seller, buyer, admin, "qa-ui-buyer2"];
const district = "서울 브라우저검증구";
function cookie(user) {
  const now = new Date(), expiresAt = new Date(Date.now() + 6 * 3600000);
  const payload = {
    session: { id: crypto.randomUUID(), token: crypto.randomUUID(), userId: user, createdAt: now, updatedAt: now, expiresAt },
    user: { id: user, name: "QA", email: `${user}@example.invalid`, emailVerified: true, createdAt: now, updatedAt: now },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(expiresAt.getTime() / 1000), sub: user,
  };
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `${head}.${body}`;
  const sig = createHmac("sha256", process.env.NEON_AUTH_COOKIE_SECRET).update(signed).digest("base64url");
  return { session_token: `qa-${user}`, session_data: `${signed}.${sig}` };
}
async function clean() {
  for (const user of users) {
    for (const l of await query("SELECT id FROM listings WHERE owner_id=$1", [user])) {
      await query("DELETE FROM disputes WHERE listing_id=$1", [l.id]);
      for (const o of await query("SELECT id FROM orders WHERE listing_id=$1", [l.id])) await query("DELETE FROM deposits WHERE order_id=$1", [o.id]);
      await query("DELETE FROM bids WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM auctions WHERE listing_id=$1", [l.id]);
      await query("DELETE FROM orders WHERE listing_id=$1", [l.id]);
    }
    await query("DELETE FROM notifications WHERE user_id=$1", [user]);
    await query("DELETE FROM disputes WHERE opened_by=$1 OR penalty_user_id=$1", [user]);
    await query("DELETE FROM activity_ips WHERE user_id=$1", [user]);
    await query("DELETE FROM listings WHERE owner_id=$1", [user]);
    await query("DELETE FROM uploads WHERE owner_id=$1", [user]);
    await query("DELETE FROM profiles WHERE user_id=$1", [user]);
  }
  await query("DELETE FROM alias_counters WHERE district_key=$1", [district]);
  console.log("QA UI data removed");
}
if (process.argv[2] === "clean") {
  await clean();
  process.exit(0);
}
await clean();
const cookies = Object.fromEntries(users.map(u => [u, cookie(u)]));
const headers = (u) => ({ Cookie: `__Secure-neon-auth.session_token=${cookies[u].session_token}; __Secure-neon-auth.local.session_data=${cookies[u].session_data}`, "Content-Type": "application/json", "X-Dumping-Client": "1", Origin: origin });
const post = async (u, body) => { const r = await fetch(`${origin}/api/market`, { method: "POST", headers: headers(u), body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; };
const profile = { company: "QA 브라우저 사업장", businessNumber: "0000000000", phone: "01000000000", businessAddress: "서울특별시 브라우저검증구 검증로 1" };
const bizNo = (seed) => { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; const d = String(100000000 + (h % 900000000)).split("").map(Number); const w = [1,3,7,1,3,7,1,3,5]; let s = 0; for (let i = 0; i < 9; i++) s += d[i] * w[i]; s += Math.floor((d[8] * 5) / 10); return d.join("") + ((10 - (s % 10)) % 10); };
await post(seller, { action: "profile", profile: { ...profile, payoutBank: "테스트은행", payoutAccount: "110-000-000000", payoutHolder: "QA" } });
await post(buyer, { action: "profile", profile: { ...profile, company: "QA 브라우저 구매자", businessNumber: bizNo(buyer) } });
await post(admin, { action: "profile", profile: { ...profile, company: "QA 운영자" } });
const form = new FormData();
form.append("file", new File([await fs.readFile("public/images/coffee.jpg")], "qa.jpg", { type: "image/jpeg" }));
const up = await fetch(`${origin}/api/uploads`, { method: "POST", headers: { Cookie: headers(seller).Cookie, "X-Dumping-Client": "1", Origin: origin }, body: form });
const { url: image } = await up.json();
const { id } = await post(seller, { action: "create_listing", product: {
  title: "카페 납품용 원두 1kg · 브라우저 검증", category: "식품·음료", price: 5000, originalPrice: 24000, stock: 360, moq: 1,
  unit: "봉", region: "서울", condition: "재고정리", image, description: "브라우저 화면 검증용 임시 경매 상품입니다. 실제 판매 재고가 아닙니다.",
  saleType: "auction", auctionDays: 7, reservePrice: 7000, instantPrice: 12000,
} });
await post(buyer, { action: "bid", productId: id, amount: 5500 });
// Simulate the midpoint having passed so the seller alert renders.
await query("UPDATE auctions SET midpoint_at=$2 WHERE listing_id=$1", [id, new Date(Date.now() - 60000).toISOString()]);
// A partial-quantity auction: 600 lot, 100 minimum, two bids so the cutoff and allocation render.
const buyer2 = "qa-ui-buyer2";
users.push(buyer2);
cookies[buyer2] = cookie(buyer2);
await post(buyer2, { action: "profile", profile: { ...profile, company: "QA 브라우저 구매자2", phone: "01022223333", businessNumber: bizNo(buyer2) } });
const partial = await post(seller, { action: "create_listing", product: {
  title: "호텔 코튼 타월 200g · 부분 수량 검증", category: "생활·주방", price: 1000, originalPrice: 6500, stock: 600, moq: 1,
  unit: "장", region: "서울", condition: "새상품", image, description: "부분 수량 경매 화면 검증용 임시 상품입니다. 실제 판매 재고가 아닙니다.",
  saleType: "auction", auctionDays: 5, reservePrice: 1500, auctionMode: "partial", minLot: 100,
} });
await post(buyer, { action: "bid", productId: partial.id, unitPrice: 1600, quantity: 400 });
await post(buyer2, { action: "bid", productId: partial.id, unitPrice: 1400, quantity: 300 });
// Ended below reserve → waiting for the seller's decision (closed lazily by the live endpoint).
const auction = (title, extra) => post(seller, { action: "create_listing", product: {
  title, category: "생활·주방", price: 3000, originalPrice: 15000, stock: 50, moq: 1, unit: "박스", region: "서울", condition: "새상품", image,
  description: "브라우저 화면 검증용 임시 상품입니다. 실제 판매 재고가 아닙니다.", saleType: "auction", auctionDays: 3, reservePrice: 9000, ...extra,
} });
const low = await auction("주방세제 대용량 · 판매 결정 검증", {});
await post(buyer, { action: "bid", productId: low.id, amount: 4000 });
await query("UPDATE auctions SET ends_at=$2 WHERE listing_id=$1", [low.id, new Date(Date.now() - 1000).toISOString()]);
await fetch(`${origin}/api/auctions/${low.id}/live`);
// Paid order waiting for shipment photos.
const ship = await auction("생수 2L 묶음 · 출고 검증", { instantPrice: 10000 });
const shipOrder = await post(buyer, { action: "bid", productId: ship.id, buyNow: true, amount: 10000 });
await post(buyer, { action: "report_payment", orderId: shipOrder.orderId, depositor: "QA 구매자" });
await post(admin, { action: "confirm_payment", orderId: shipOrder.orderId });
// Shipped order with an open dispute from the buyer.
const disputed = await auction("행주 100매 · 분쟁 검증", { instantPrice: 11000 });
const dOrder = await post(buyer2, { action: "bid", productId: disputed.id, buyNow: true, amount: 11000 });
await post(buyer2, { action: "report_payment", orderId: dOrder.orderId, depositor: "QA 구매자2" });
await post(admin, { action: "confirm_payment", orderId: dOrder.orderId });
await post(seller, { action: "mark_shipped", orderId: dOrder.orderId, photos: [image] });
await post(buyer2, { action: "open_dispute", orderId: dOrder.orderId, kind: "misrepresentation", description: "10박스 중 2박스가 젖어 있었습니다." });
console.log(JSON.stringify({ id, partialId: partial.id, lowId: low.id, shipOrder: shipOrder.orderId, disputeOrder: dOrder.orderId, cookies }, null, 2));
