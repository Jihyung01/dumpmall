import assert from "node:assert/strict";
import fs from "node:fs/promises";
const origin = "http://127.0.0.1:8787";
const run = crypto.randomUUID().slice(0, 8);
const seller = `qa-seller-${run}`,
  buyer = `qa-buyer-${run}`,
  outsider = `qa-outsider-${run}`;
const headers = (user) =>
  user
    ? {
        "oai-authenticated-user-id": user,
        "oai-authenticated-user-email": `${user}@example.test`,
      }
    : {};
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
    region: "경기",
  },
});
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
