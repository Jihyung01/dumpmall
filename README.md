# 덤핑몰

사업자 재고 거래 웹앱 및 PWA. 공개 카탈로그, 이메일·소셜 로그인, 재고/사진 등록, **전량·부분 수량 경매(입찰·비공개 최저 매각가·즉시체결가·실시간 갱신·자동 낙찰·최저가 미달 판매 결정·차순위 승계(기본 꺼짐))**, 계좌이체 입금 확인 후 연락처 공개, 출고 사진·자동 수령 확인, 분쟁·위약금, 수수료 정산, 견적 협상, 거래별 메시지, 앱 내 알림, 물류비 계산기를 제공합니다. 경매 흐름은 `docs/AUCTION.md` 참고.

## 운영

- 도메인: https://dumpmall.com
- 런타임: Next.js App Router / Node.js 22
- 데이터와 로그인: Neon Postgres / Neon Auth (Vercel Marketplace)
- 사진: 현재 전용 Postgres에 저장, 업로드당 최대 3MB. 계정의 Blob 사용 한도가 해소되면 별도 오브젝트 저장소로 전환 권장.
- 샘플 상품은 샘플로 표시합니다. 결제는 계좌이체 + 운영자 수동 확인이며 PG·사업자 진위확인·알림톡은 아직 연결하지 않았습니다.
- 운영 환경 변수: `ADMIN_USER_IDS`, `PLATFORM_BANK_ACCOUNT`, `PLATFORM_FEE_RATE`(기본 0.03), `PLATFORM_FEE_RATES`(카테고리별), `CRON_SECRET`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`(웹 푸시), `DEPOSIT_WEBHOOK_SECRET`(입금 자동 확인), `BELOW_RESERVE_POLICY`, `PENALIZE_NONPAYMENT`, `AUCTION_SUCCESSION`, `NTS_SERVICE_KEY`, `IP_HASH_SECRET`. 상세: `docs/AUCTION.md`, `docs/WHOLE-AUCTION-2026-09-26.md`.

## 로컬 실행

`.env.local`에 환경 변수를 준비하세요. 필수 키는 `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`입니다. 비밀값을 출력하거나 커밋하지 마세요.

```sh
npm ci
npm run db:migrate
npm run dev
npm run build
npm run lint
```

## PWA

`public/manifest.webmanifest`와 `public/sw.js`로 앱 설치 및 오프라인 안내 화면을 제공합니다. 인증, 사용자 데이터, API 응답은 서비스 워커에 저장하지 않습니다.
