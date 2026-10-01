import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { encode } from "next-auth/jwt";
import { businessRegion, aliasAdjectives } from "../lib/business-region.ts";
import { neon } from "@neondatabase/serverless";
const origin = process.env.TEST_BASE_URL || "http://localhost:3000";
if (!process.env.NEON_AUTH_COOKIE_SECRET || !process.env.DATABASE_URL) throw new Error("Test environment is required");
// Synthetic, short-lived sessions exercise the SDK's signature validation and
// application authorization without sending email or touching real accounts.
const cookies = new Map();
const run = crypto.randomUUID().slice(0, 8);
const seller = `qa-seller-${run}`,
  buyer = `qa-buyer-${run}`,
  outsider = `qa-outsider-${run}`;
const qaUsers = [seller, buyer, outsider];
const qaDistrict = "시험" + [...run].map(c => "가나다라마바사아자차카타파하거너"[parseInt(c,16)]).join("") + "구";
const qaAddress = `서울특별시 ${qaDistrict} 시험로 1`;
function headers(user) {
  if (!user) return {};
  if (!cookies.has(user)) {
    const now = new Date(), expiresAt = new Date(Date.now() + 1800000);
    const payload = {
      session: { id: crypto.randomUUID(), token: crypto.randomUUID(), userId: user, createdAt: now, updatedAt: now, expiresAt },
      user: { id: user, name: "QA", email: `${user}@example.invalid`, emailVerified: true, createdAt: now, updatedAt: now },
      iat: Math.floor(Date.now()/1000), exp: Math.floor(expiresAt.getTime()/1000), sub: user,
    };
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signed = `${head}.${body}`;
    const sig = createHmac("sha256", process.env.NEON_AUTH_COOKIE_SECRET).update(signed).digest("base64url");
    cookies.set(user, `__Secure-neon-auth.session_token=qa-${user}; __Secure-neon-auth.local.session_data=${signed}.${sig}`);
  }
  return { Cookie: cookies.get(user) };
}
let checks = 0;
async function get(user) {
  const r = await fetch(`${origin}/api/market`, { headers: headers(user) });
  assert.equal(r.status, 200);
  return r.json();
}
async function post(user, body, status = 200) {
  const r = await fetch(`${origin}/api/market`, {
    method: "POST",
    headers: {
      ...headers(user),
      "Content-Type": "application/json",
      "X-Dumping-Client": "1",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  assert.equal(r.status, status, `${body.action}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}
try {
const forged = await fetch(`${origin}/api/market`, { headers: { "oai-authenticated-user-id": seller, "oai-authenticated-user-email": "qa@example.invalid" } });
assert.equal((await forged.json()).user, null);
checks++;
const invalid = await fetch(`${origin}/api/market`, { headers: { Cookie: headers(seller).Cookie + "invalid" } });
assert.equal((await invalid.json()).user, null);
checks++;
const anonymous = await get();
assert.equal(anonymous.user, null);
assert.deepEqual(anonymous.offers, []);
assert.ok(anonymous.products.length >= 8);
checks++;
await post(
  null,
  { action: "favorite", productId: "sample-water", saved: true },
  401,
);
const blocked = await fetch(`${origin}/api/market`, {
  method: "POST",
  headers: {
    ...headers(buyer),
    "Content-Type": "application/json",
    "X-Dumping-Client": "1",
    Origin: "https://other.example",
  },
  body: "{}",
});
assert.equal(blocked.status, 403);
checks++;
await post(seller, {
  action: "profile",
  profile: {
    company: "QA 테스트 사업장",
    businessNumber: "0000000000",
    phone: "01000000000",
    businessAddress: qaAddress,
    publicAlias: "임의 위조 별칭",
  },
});
const profileBody = { company: "QA 구매자", businessNumber: "0000000000", phone: "01000000000", businessAddress: qaAddress };
await post(buyer, { action: "profile", profile: profileBody });
// Alias allocation, collision handling, persistence, privacy, and social sessions.
assert.equal(aliasAdjectives.length, 20);
assert.equal(new Set(aliasAdjectives).size, 20);
assert.deepEqual(businessRegion("부산광역시 중구 중앙대로 1"), { districtKey: "부산 중구", region: "경상" });
assert.equal(businessRegion("경기도 수원시 팔달구 효원로 1").districtKey, "경기 수원시 팔달구");
assert.equal(businessRegion("세종특별자치시 한누리대로 1").districtKey, "세종");
assert.equal(businessRegion("주소 없음"), null);
checks++;
await post(outsider, { action: "profile", profile: { ...profileBody, businessAddress: "서울" } }, 400);
const firstProfile = (await get(seller)).profile;
assert.equal(firstProfile.publicAlias, `성실한 서울 ${qaDistrict}`);
assert.notEqual(firstProfile.publicAlias, "임의 위조 별칭");
checks++;
const concurrent = Array.from({length: 20}, (_, i) => `qa-alias-${run}-${i}`);
qaUsers.push(...concurrent);
await Promise.all(concurrent.map(user => post(user, { action: "profile", profile: profileBody })));
const allocated = await Promise.all([seller,buyer,...concurrent].map(async user => (await get(user)).profile.publicAlias));
assert.equal(new Set(allocated).size, 22);
assert.equal(allocated.filter(name => / \d+$/.test(name)).length, 2);
checks++;
await Promise.all(Array.from({length: 5}, () => post(seller, { action: "profile", profile: { ...profileBody, businessAddress: qaAddress + " 201호" } })));
assert.equal((await get(seller)).profile.publicAlias, firstProfile.publicAlias);
checks++;
const socialId = `qa-social-${run}`;
qaUsers.push(socialId);
const secure = origin.startsWith("https:");
const cookieName = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
const socialSecret = process.env.AUTH_SECRET || createHmac("sha256",process.env.NEON_AUTH_COOKIE_SECRET).update("dumpmall-social-auth-v1").digest("hex");
const socialToken = await encode({ secret: socialSecret, salt: cookieName, token: {sub:socialId, name:"소셜 QA"}, maxAge:600 });
const socialResponse = await fetch(`${origin}/api/market`, {headers:{Cookie:`${cookieName}=${socialToken}`}});
assert.equal((await socialResponse.json()).user.id, socialId);
const providersResponse = await fetch(`${origin}/api/social-auth/providers`);
assert.equal(providersResponse.status, 200);
checks++;
const form = new FormData();
form.append(
  "file",
  new File([await fs.readFile("public/images/water.jpg")], "qa-water.jpg", {
    type: "image/jpeg",
  }),
);
const uploaded = await fetch(`${origin}/api/uploads`, {
  method: "POST",
  headers: { ...headers(seller), "X-Dumping-Client": "1", Origin: origin },
  body: form,
});
assert.equal(uploaded.status, 200);
const { url: image } = await uploaded.json();
checks++;
const imageResponse = await fetch(`${origin}${image}`);
assert.equal(imageResponse.status, 200);
assert.equal(imageResponse.headers.get("content-type"), "image/jpeg");
checks++;
const deadline = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const product = {
  title: `QA 재고 ${run}`,
  category: "식품·음료",
  price: 1000,
  originalPrice: 2000,
  stock: 100,
  moq: 10,
  unit: "박스",
  region: "경기",
  condition: "새상품",
  deadline,
  image,
  seller: "QA 테스트 사업장",
  description: "로컬 개발 환경에서만 생성하는 기능 검증용 상품입니다.",
};
await post(buyer, { action: "create_listing", product }, 400);
const { id: productId } = await post(
  seller,
  { action: "create_listing", product },
  201,
);
assert.ok((await get(seller)).ownListings.some((p) => p.id === productId));
const publicData = await get();
assert.equal(publicData.products.find(p => p.id === productId).seller, firstProfile.publicAlias);
assert.equal(publicData.profile, null);
assert.ok(!JSON.stringify(publicData).includes("QA 테스트 사업장"));
assert.ok(!JSON.stringify(publicData).includes("시험로 1"));
const moved = await post(seller, { action: "profile", profile: { ...profileBody, businessAddress: qaAddress.replace("서울특별시", "부산광역시") } });
assert.ok(moved.publicAlias.includes("부산"));
assert.equal((await get()).products.find(p => p.id === productId).seller, moved.publicAlias);
checks++;
await post(buyer, { action: "favorite", productId, saved: true });
assert.ok((await get(buyer)).favorites.includes(productId));
assert.ok(!(await get(seller)).favorites.includes(productId));
checks++;
const offer = {
  action: "create_offer",
  id: crypto.randomUUID(),
  productId,
  quantity: 20,
  price: 900,
  shipping: "직접 픽업",
  note: "QA 인수 조건 확인",
};
await post(buyer, { ...offer, quantity: 1 }, 400);
await post(seller, offer, 400);
await post(buyer, offer, 201);
await post(buyer, offer, 200);
assert.equal(
  (await get(buyer)).offers.filter((o) => o.id === offer.id).length,
  1,
);
checks++;
await post(
  outsider,
  { action: "message", offerId: offer.id, body: "접근 시도" },
  404,
);
await post(
  outsider,
  { action: "respond", id: offer.id, response: "cancel" },
  404,
);
await post(
  buyer,
  { action: "respond", id: offer.id, response: "counter", price: 1100 },
  403,
);
await post(seller, {
  action: "respond",
  id: offer.id,
  response: "counter",
  price: 1100,
});
const countered = (await get(buyer)).offers.find((o) => o.id === offer.id);
assert.equal(countered.price, 1100);
assert.equal(countered.status, "countered");
checks++;
await post(buyer, {
  action: "respond",
  id: offer.id,
  response: "accept_counter",
});
assert.equal(
  (await get(seller)).offers.find((o) => o.id === offer.id).status,
  "accepted",
);
checks++;
await post(buyer, { action: "respond", id: offer.id, response: "cancel" }, 409);
await post(buyer, {
  action: "message",
  offerId: offer.id,
  body: "상품 인수 일정 확인 부탁드립니다.",
});
assert.ok((await get(seller)).messages.some((m) => m.offerId === offer.id));
assert.deepEqual((await get(outsider)).messages, []);
checks++;
const sample = {
  ...offer,
  id: crypto.randomUUID(),
  productId: "sample-water",
  quantity: 30,
};
await post(buyer, sample, 201);
await post(
  buyer,
  { action: "respond", id: sample.id, response: "accept" },
  403,
);
await post(buyer, { action: "respond", id: sample.id, response: "cancel" });
await post(outsider, { action: "archive_listing", id: productId }, 404);
await post(seller, { action: "archive_listing", id: productId });
assert.ok(!(await get()).products.some((p) => p.id === productId));
assert.ok((await get(buyer)).offers.some((o) => o.id === offer.id));
checks++;
console.log(
  JSON.stringify(
    {
      result: "PASS",
      checks,
      coverage: [
        "anonymous auth",
        "verified social JWT session",
        "22 concurrent unique district aliases and number overflow",
        "concurrent same-user alias stability",
        "address change and public identity masking",
        "origin check",
        "account isolation",
        "image upload and ownership",
        "persistent inventory",
        "MOQ validation",
        "idempotent quotes",
        "counteroffer and acceptance",
        "illegal transitions",
        "message authorization",
        "sample isolation",
        "archive retention",
      ],
    },
    null,
    2,
  ),
);

} finally {
  const sql = neon(process.env.DATABASE_URL);
  for (const user of qaUsers) {
    await sql`DELETE FROM messages WHERE author_id=${user}`;
    await sql`DELETE FROM offers WHERE buyer_id=${user} OR seller_id=${user}`;
    await sql`DELETE FROM favorites WHERE user_id=${user}`;
    await sql`DELETE FROM listings WHERE owner_id=${user}`;
    await sql`DELETE FROM uploads WHERE owner_id=${user}`;
    await sql`DELETE FROM profiles WHERE user_id=${user}`;
    await sql`DELETE FROM activity_ips WHERE user_id=${user}`;
  }
  await sql`DELETE FROM alias_counters WHERE district_key=${"서울 " + qaDistrict} OR district_key=${"부산 " + qaDistrict}`;
  console.log("Temporary QA data removed");
}
