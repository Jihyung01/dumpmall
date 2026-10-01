# 전량 경매 · 입금 · 정산 흐름 (2026-09-21, 2026-09-26 갱신)

사용자가 정의한 사업 프로세스를 그대로 구현했습니다. 2026-09-26에 "전량경매 시스템 설계 문서"(즉시체결가, 최저가 완전 비공개, 실시간 갱신, 최저가 미달 처리, 출고 사진, 자동 수령 확인, 분쟁·위약금, 자전거래 방지)를 더했습니다. 항목별 결과와 정책 결정은 `docs/WHOLE-AUCTION-2026-09-26.md`.

| 단계 | 사용자 정의 | 구현 |
|---|---|---|
| 1 | 공급자가 상품만 올림 | 재고 등록에서 **전량 경매** 선택. 사진·품명·정상가·시작가·전량 수량·단위·지역·상태·설명 |
| 2 | 기한 설정 | 경매 기간 3/5/7/10/14일 중 선택. 마감 시각은 등록 시각 + 기간 |
| 3 | 최저 매각가 제시 | `reserve_price` 단가(원/단위). 공급자·운영자에게만 표시. 구매자에게는 금액도 도달 여부도 보이지 않음 (2026-09-26) |
| 4 | 구매자 입찰 | 상세 화면의 입찰 폼. 시작가부터, 가격대별 호가 단위(10/100/500/1,000/10,000원). 마감 5분 전 입찰은 5분 연장 |
| 5 | 기간 절반에 미달 시 알림 | `midpoint_at` 경과 시 최고 입찰가 < 최저 매각가(또는 입찰 없음)이면 공급자에게 `reserve_alert` 알림 1회. 상세 화면에도 배너 |
| 6 | 기간 내 최저가 이상 입찰이면 돈 받음 | 마감 시 최고가 ≥ 최저 매각가면 자동 낙찰 → 주문 생성 → 24시간 입금 기한(2026-09-29 변경, 이전 48시간). 미달이면 공급자가 24시간 안에 판매 여부 결정 → 판매하면 최고 입찰가로 바로 낙찰(구매자 재확인 없음). 즉시체결가 이상 입찰은 그 자리에서 낙찰. 공급자는 언제든 **현재 최고가로 지금 낙찰** 가능 |
| 7 | 입금 후 개인정보 교환 | 구매자 입금 신고 → 운영자 입금 확인 → 양쪽에 상대 상호·연락처·사업장 주소 공개. 인수·배송은 직접 진행 |
| 8 | 거래 완료 후 수수료 떼고 정산 | 공급자 출고(사진 1~5장 필수) → 구매자 인수 완료 또는 7일 뒤 자동 완료 → 수수료(기본 3%) 차감 → 운영자 정산 완료 처리 → 공급자 알림 |

## 경매 방식 (2026-09-21 추가: 부분 수량 경매)

| | 전량 경매 (`auctions.mode='whole'`) | 부분 수량 경매 (`mode='partial'`) |
|---|---|---|
| 입찰 | 단가만. 최고가 1명이 전량 낙찰 | 단가 × 수량(최소 입찰 단위 `min_lot`의 배수) |
| 최소 입찰 | 현재가 + 호가 단위 | 시작가, 전량이 채워진 뒤엔 낙찰 하한가 + 호가 단위 |
| 입찰 수정 | 더 높은 단가로 새 입찰 | 단가·수량 모두 같거나 높게(하나는 올려야) 교체. 시간 순위는 새로 매겨짐 |
| 마감 배분 | 최고가 ≥ 최저 매각가면 낙찰 | 단가 높은 순(동가는 먼저 입찰한 순)으로 배정, 최저 매각가 미만 제외. 마지막 낙찰자는 일부만 배정될 수 있음 |
| 주문 | 1건 | 낙찰자마다 1건(각자 단가·수량·입금 코드·수수료) |
| 잔여 | — | `unsold_quantity` → 경매 탭 "잔여 n 다시 경매" (`relist_remainder`) |
| 즉시 낙찰 | 현재 최고가로 | 최저 단가(`floor`)를 정해 미리보기(`preview_close`) 후 낙찰 |

배분은 `lib/auction-core.ts`의 `allocate()` 한 함수가 실시간 화면·중간 알림·마감·즉시 낙찰·차순위 승계에 모두 쓰입니다.

## 즉시체결가 · 최저가 미달 · 분쟁 (2026-09-26 추가)

- **즉시체결가** (`auctions.instant_price`, 전량 경매만): 공개 가격. 입찰가 ≥ 즉시체결가면 `placeWholeBid()`의 한 UPDATE가 경매를 닫고 즉시체결가로 주문을 만듭니다. `buyNow` 요청은 확인한 가격을 함께 보내야 하며 달라졌으면 409. 공급자는 `set_instant_price`로 올리기·없애기 자유, 내리기는 현재 최고가 초과·최저가 이상일 때만.
- **최저가 미달 마감** (2026-09-29 확정): 경매 `deciding`·상품 `pending` → 공급자 `decide_below_reserve`(24시간, 무응답 시 `decision_expired` 유찰) → 판매하면 최고 입찰가로 바로 `awaiting_payment` 주문(`close_reason='seller_accepted_below_reserve'`). 입찰이 곧 구매 의사라 구매자에게 다시 묻지 않습니다. 코드에 남은 `BELOW_RESERVE_POLICY=buyer_only`(구매자에게 `offered`로 묻기)는 사용하지 않습니다. 판매자·운영자·최고 입찰자가 아닌 사람에게는 `deciding`이 일반 낙찰(`won`)처럼 보이고 패찰 알림 문구도 같습니다.
- **실시간**: `GET /api/auctions/[id]/live`(3초 폴링, 약한 ETag로 304). 마감 시각이 지났으면 그 경매만 지연 마감합니다.
- **출고·자동 완료**: `mark_shipped`에 본인 업로드 사진 1~5장 필수, `auto_complete_at = 출고 + 7일`.
- **분쟁·위약금**: `disputes` 테이블, `open_dispute`/`respond_dispute`/`resolve_dispute`/`settle_penalty`/`mark_refunded`. 열린 분쟁은 입금 기한 취소·자동 완료·정산·운영자 주문 취소를 막습니다. 위약금 10%(`PENALTY_BPS`)가 미납이면 입찰·등록·재등록·구매 수락이 403이며, 위약금이 생긴 뒤 같은 사업자번호를 등록한 계정에도 적용됩니다(`profiles.business_number_since`). 미입금 자동 취소 시 위약금은 취소와 같은 트랜잭션에서 생성됩니다.
- **환불**: `orders.refund_amount`(돌려줄 누적액) − `orders.refund_paid`(송금 완료액)가 송금 대기액입니다. `mark_refunded`는 운영자가 본 송금액(`amount`)이 대기액과 같을 때만 기록합니다.
- **자전거래**: 같은 사업자번호 입찰 403, IP 해시(`activity_ips`, `bids.ip_hash`), 운영 탭 부정거래 목록, `admin_cancel_auction`.

## 차순위 승계 (2026-09-21 추가, 2026-09-29부터 기본 꺼짐)

**현재 운영 정책은 승계 없음입니다.** `AUCTION_SUCCESSION=on`일 때만 아래가 동작하고, 꺼져 있으면 취소된 주문은 그대로 유찰로 끝나며 판매자에게 다시 경매하라는 안내가 갑니다. 등록 화면의 승계 체크박스도 꺼져 있을 때는 숨깁니다.

낙찰 주문이 취소되면(입금 기한 초과, 제안 만료·거절, 운영자 취소) `succeed()`가 한 번만 실행됩니다.
- 후보: 최저 매각가 이상 입찰자, 공급자 본인·이미 취소/제안 이력이 있는 구매자 제외, 부분 경매는 남은 용량(입찰 수량 − 기존 주문 수량)만큼.
- 제안 주문 `orders.status='offered'`, `offer_expires_at = 24시간`, `succession_round` 1→2, `parent_order_id`로 연결.
- 수락(`accept_offer`) → `awaiting_payment`, 입금 기한 24시간 새로 시작. 거절(`decline_offer`)·만료 → 다음 후보 또는 미판매.
- 한도: 최대 2회, 마감 후 7일(`succession_until`), 등록 시 `succession_enabled`로 끌 수 있음.
- 승계 중에는 상품이 `sold`로 유지되고, 후보가 없으면 `unsold_quantity`에 더해져 잔여 재경매 대상이 됩니다.

## 입금 확인 (2026-09-21 추가: 입금 코드 + 웹훅)

- 모든 주문에 4자리 `deposit_code`(대기 주문 간 유일)가 생기고 구매자에게 "입금자명에 코드+상호 앞 2자"로 안내됩니다.
- `POST /api/webhooks/deposit`(`lib/deposits.ts`)가 입금 이벤트를 원장(`deposits`)에 기록하고 규칙대로 주문을 확인합니다. 인증 방식과 매칭 규칙은 `lib/deposits.ts`와 `app/api/webhooks/deposit/route.ts` 참고.
- 운영자 `confirm_payment`, 운영자 `match_deposit`, 웹훅 모두 같은 `markPaid()`(조건부 UPDATE 1회)를 지나므로 이중 확인이 없습니다.
- 운영 탭 → 입금 관리: 미확인 입금 목록(후보 주문 선택·연결·재시도·무시), 입금 수동 입력. `report_payment`(구매자 입금 신고) 시 대기 중인 입금을 다시 매칭합니다.

## 웹 푸시 (2026-09-21 추가)

- `lib/push.ts`: VAPID 키가 있을 때만 활성. `notify()` 뒤에 `after()`로 발송해 응답을 막지 않음. 404/410 구독은 삭제, 그 외 실패는 `fail_count`(크론에서 8회 이상·90일 미사용 정리).
- `public/sw.js`: `push`(태그로 중복 합침) · `notificationclick`(주문/상품 딥링크) · `pushsubscriptionchange`(재구독).
- UI: 알림 탭·입금 대기 주문 화면의 토글(`components/market/push.tsx`), 로그아웃 시 구독 해제, 앱 아이콘 배지(`navigator.setAppBadge`).
- iOS는 16.4+에서 홈 화면에 추가한 PWA에서만 동작하며 권한 요청은 사용자 탭이 필요합니다.

## 상태 흐름

- 경매 `auctions.status`: `active` → `won` / `unsold` / `cancelled`, 또는 `active` → `deciding`(최저가 미달, 공급자 결정 대기) → `won` / `unsold`
- 상품 `listings.status`: `active` → `sold`(낙찰) / `pending`(판매 결정 대기, 마켓 비노출) / `unsold`(유찰·전 주문 취소) / `archived`(중단·재등록 후, `relisted_to`로 새 경매 연결)
- 주문 `orders.status`: (`offered` →) `awaiting_payment` → `payment_reported` → `paid` → `shipped`(선택) → `completed` → `settled`, 또는 `cancelled`
- 유찰 재고는 **다시 경매**(`relist_auction`), 낙찰 후 미낙찰 잔여는 **잔여 다시 경매**(`relist_remainder`). 둘 다 claim-first 배치라 중복 등록이 불가능

## 시간 처리

- 모든 전환은 `lib/auction-core.ts`의 `processAuctions(query, now, batch)`가 수행하며 **모든 `/api/market` 읽기에서 지연 실행**됩니다. 사이트에 트래픽이 있으면 즉시 반영됩니다. 단계: 중간 알림 → 마감 → 입금 기한 초과 → 제안 만료 → 승계 재구동.
- 여러 문장을 쓰는 변경(부분 입찰, 부분 마감, 승계, 입금 확인, 재등록)은 `db/index.ts`의 `batch()` 한 트랜잭션으로 실행합니다. 첫 문장은 `auction:<listing_id>` 자문 잠금, 둘째는 무작위 토큰을 찍는 조건부 UPDATE(claim), 나머지는 그 토큰을 `EXISTS`로 확인합니다. 성공 여부는 claim의 rowCount로만 판단합니다.
- 보조로 `/api/cron/auctions`(Bearer `CRON_SECRET`)를 `vercel.json`에서 매일 KST 00:00에 호출합니다. Hobby 플랜 제한 때문에 하루 1회이며, 필요하면 외부 스케줄러로 더 자주 호출해도 됩니다.
- 전환은 조건부 UPDATE로 처리되어 동시 호출에도 중복 낙찰·중복 알림이 나지 않습니다.

## 환경 변수

| 변수 | 용도 | 미설정 시 |
|---|---|---|
| `ADMIN_USER_IDS` | 운영자 계정 ID(쉼표 구분). 입금 확인·정산·주문 취소 권한 | 운영자 기능 사용 불가 → 입금 확인이 안 되어 연락처가 공개되지 않음 |
| `PLATFORM_BANK_ACCOUNT` | 구매자에게 안내할 입금 계좌 문자열 | "입금 계좌는 운영자 안내를 기다려 주세요" 표시 |
| `PLATFORM_FEE_RATE` | 수수료율(0~0.5). 운영 값 `0.03` | 3% |
| `CRON_SECRET` | 크론 호출 인증 | 크론 401, 지연 실행만 동작 |
| `PLATFORM_FEE_RATES` | 카테고리별 수수료율 JSON | 기본 요율만 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | 웹 푸시 | 푸시 비활성(앱 내 알림만) |
| `DEPOSIT_WEBHOOK_SECRET` | 입금 웹훅 인증(32자 이상) | 웹훅 503, 운영자 수동 입력만 |
| `DEPOSIT_MATCH_AMOUNT_ONLY` | 금액만 일치해도 자동 확인 | off |
| `BELOW_RESERVE_POLICY` | 최저가 미달 마감 처리. `buyer_only`면 구매자에게 묻기(사용 안 함) | `seller_decides`(판매자 결정, 수락 시 즉시 성사) |
| `AUCTION_SUCCESSION` | `on`이면 취소 시 차순위 입찰자에게 제안 | 꺼짐(운영 정책) |
| `PENALIZE_NONPAYMENT` | `false`면 미입금 자동 위약금 끔. 운영 값 `false` | 켜짐 |
| `NTS_SERVICE_KEY` | 국세청 사업자 상태 조회 키(Secret) | 체크섬만 검사 |
| `IP_HASH_SECRET` | IP 해시 비밀값(Secret) | `NEON_AUTH_COOKIE_SECRET` 사용 |

내 계정 ID는 로그인 후 **내 사업자 정보** 모달 하단에 표시됩니다.

## 알림 종류

`outbid`, `reserve_met`, `reserve_alert`, `auction_won`, `auction_partial_won`, `auction_sold`, `auction_lost`, `auction_unsold`, `succession_offer`, `succession_offered`, `succession_accepted`, `succession_exhausted`, `payment_reported`, `admin_payment`, `admin_auto_paid`, `admin_deposit_unmatched`, `contact_revealed`, `shipped`, `completed`, `admin_settle`, `settled`, `order_cancelled`, 그리고 2026-09-26 추가분 `instant_price_changed`, `below_reserve_decision`, `auction_pending`, `below_reserve_offer`, `below_reserve_offered`, `below_reserve_accepted`, `auction_cancelled`, `dispute_opened`, `admin_dispute`, `dispute_resolved`, `penalty_due`, `penalty_settled`, `refunded`. 앱 내 알림(헤더 종 아이콘, 거래 관리 → 알림)과 웹 푸시(VAPID 설정 시). 알림톡·이메일은 미연결입니다.

## 검증

```sh
ADMIN_USER_IDS=qa-admin-static PLATFORM_FEE_RATES='{"생활·주방":0.04}' DEPOSIT_WEBHOOK_SECRET=qa-deposit-secret-0123456789abcdef0123456789abcdef npm run start -- --port 3000
TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-auction.mjs
TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-instant.mjs
TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-disputes.mjs
TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-partial.mjs
TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-succession.mjs
DEPOSIT_WEBHOOK_SECRET=qa-deposit-secret-0123456789abcdef0123456789abcdef TEST_BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/verify-deposit.mjs
```

모든 스크립트가 실제 DB에 QA 데이터를 쓰고 `finally`에서 지웁니다(공용 헬퍼 `scripts/qa-lib.mjs`). 운영 DB를 공유하므로 동시에 두 개를 돌리지 마세요. 시간을 앞당겨 호출하는 `processAuctions(query, now, batch, { ownerIds: [QA 공급자] })`는 반드시 범위를 지정해야 합니다. 범위 없이 미래 시각으로 호출하면 실제 사용자의 진행 중 경매까지 마감됩니다(2026-09-21에 한 번 발생해 복구했음). 2026-09-29 기준 auction 68 + instant 68 + disputes 130 + partial 50 + succession 48 + deposit 57 + vercel-api 67 = 488개 검사 통과. `verify-succession.mjs`와 `verify-partial.mjs`는 승계를 다루므로 서버를 `AUCTION_SUCCESSION=on`으로 띄워 실행합니다. `verify-disputes.mjs`는 `{ listingIds: [...] }` 범위로 한 상품씩만 시간을 앞당깁니다.

`verify-auction.mjs` 59개 검사: 경매 등록 검증, 최저가 비공개, 호가 단위, 최고 입찰자 중복 입찰 차단, 재입찰 알림, 중간 알림 1회, 최저가 인하, 마감 낙찰·주문 생성, 패찰 알림, 입금 신고·확인, 입금 후 연락처 공개, 출고·인수, 정산 계좌 노출(운영자), 유찰·재등록, 조기 낙찰, 입금 기한 초과 취소, 입찰 없는 경매 중단, 알림 읽음, 크론 인증. QA 데이터는 finally에서 삭제됩니다.

브라우저 수동 확인용 시드: `node --env-file=.env.local scripts/qa-seed-auction.mjs` (정리: `... clean`).

## 알려진 한계

- 입금 자동 확인은 은행 알림(문자 전달 앱)이나 PG 콜백을 웹훅에 연결해야 동작. 연결 전에는 운영자 수동 입력·확인.
- PG 가상계좌 발급은 미연결(계약 필요). 웹훅은 범용 JSON이라 어댑터만 추가하면 됨.
- 세금계산서는 두 사업자가 직접 처리. 플랫폼 명의 발행은 직매입/위수탁 구조 결정 후.
- 카카오 알림톡·문자·이메일은 미연결(외부 계약 필요). 웹 푸시는 VAPID 키 등록 후 동작.
- 부분 경매의 수수료는 주문별 반올림이라 묶음 계산과 주문 수만큼(원 단위) 차이가 날 수 있음.
