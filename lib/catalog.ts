export type Product = {
  id: string;
  title: string;
  category: string;
  price: number;
  originalPrice: number;
  stock: number;
  moq: number;
  unit: string;
  region: string;
  condition: string;
  deadline: string;
  image: string;
  seller: string;
  description: string;
  ownerId?: string;
  sample?: boolean;
  createdAt?: string;
  saleType?: "quote" | "auction";
  status?: "active" | "pending" | "sold" | "unsold" | "archived";
  /** Seller's business number was confirmed active by the NTS status API. */
  sellerVerified?: boolean;
  auction?: import("./models").Auction | null;
};
export const categories = [
  "전체",
  "식품·음료",
  "생활·주방",
  "패션·잡화",
  "뷰티",
  "디지털·가전",
  "산업·기타",
];
export const samples: Product[] = [
  {
    id: "sample-water",
    title: "무라벨 생수 500ml · 20개입",
    category: "식품·음료",
    price: 2400,
    originalPrice: 8000,
    stock: 1200,
    moq: 30,
    unit: "박스",
    region: "경기",
    condition: "새상품",
    deadline: "2026-10-02",
    image: "/images/water.jpg",
    seller: "성실한 경기 이천시",
    description:
      "패키지 리뉴얼로 남은 무라벨 생수 재고입니다. 상온 보관 상품으로, 1박스당 500ml 20병이 들어 있습니다. 창고 직접 픽업과 팔레트 화물 운송이 가능합니다. 소비기한은 협의 시 별도로 확인해 주세요.",
    sample: true,
  },
  {
    id: "sample-towels",
    title: "호텔 코튼 타월 200g · 화이트",
    category: "생활·주방",
    price: 1800,
    originalPrice: 6500,
    stock: 2400,
    moq: 100,
    unit: "장",
    region: "인천",
    condition: "새상품",
    deadline: "2026-10-06",
    image: "/images/towels.jpg",
    seller: "든든한 인천 남동구",
    description:
      "숙박업소·피트니스 센터에 적합한 화이트 면 타월입니다. 납품 취소로 인한 미사용 재고이며 개별 포장되어 있습니다. 대량 매입 시 수량별 견적을 요청해 주세요.",
    sample: true,
  },
  {
    id: "sample-coffee",
    title: "데일리 블렌드 원두 1kg",
    category: "식품·음료",
    price: 7900,
    originalPrice: 24000,
    stock: 360,
    moq: 20,
    unit: "봉",
    region: "서울",
    condition: "재고정리",
    deadline: "2026-09-27",
    image: "/images/coffee.jpg",
    seller: "정직한 서울 성동구",
    description:
      "고소한 풍미의 미디엄 다크 로스팅 블렌드 원두입니다. 카페·오피스 납품용 재고로 1kg 단위 포장입니다. 로스팅일과 소비기한은 실제 거래 전 확인이 필요합니다.",
    sample: true,
  },
  {
    id: "sample-shirts",
    title: "에센셜 코튼 반팔 티셔츠",
    category: "패션·잡화",
    price: 2900,
    originalPrice: 19000,
    stock: 1800,
    moq: 50,
    unit: "장",
    region: "경기",
    condition: "시즌오프",
    deadline: "2026-10-12",
    image: "/images/shirts.jpg",
    seller: "친절한 경기 양주시",
    description:
      "사계절 활용 가능한 기본 면 티셔츠입니다. S부터 XL까지 혼합 구성으로 시즌 마감 재고를 판매합니다. 색상·사이즈 구성은 견적 요청 시 협의할 수 있습니다.",
    sample: true,
  },
  {
    id: "sample-juice",
    title: "오렌지 착즙 주스 250ml",
    category: "식품·음료",
    price: 650,
    originalPrice: 2800,
    stock: 3600,
    moq: 120,
    unit: "병",
    region: "충청",
    condition: "소비기한 임박",
    deadline: "2026-09-25",
    image: "/images/juice.jpg",
    seller: "따뜻한 충남 천안시 서북구",
    description:
      "카페·베이커리 납품용 오렌지 주스 재고입니다. 냉장 보관 상품입니다. 소비기한과 냉장 배송 조건을 공급자에게 반드시 확인한 뒤 매입해 주세요.",
    sample: true,
  },
  {
    id: "sample-cookware",
    title: "스테인리스 키친웨어 세트",
    category: "생활·주방",
    price: 12900,
    originalPrice: 49000,
    stock: 280,
    moq: 10,
    unit: "세트",
    region: "경상",
    condition: "박스훼손",
    deadline: "2026-10-10",
    image: "/images/cookware.jpg",
    seller: "밝은 경기 김포시",
    description:
      "외부 포장에 경미한 흠집이 있는 미사용 키친웨어 재고입니다. 구성품과 상품 상태는 공급자의 실제 검수 사진을 통해 확인해 주세요.",
    sample: true,
  },
  {
    id: "sample-skincare",
    title: "데일리 모이스처 케어 세트",
    category: "뷰티",
    price: 5900,
    originalPrice: 32000,
    stock: 600,
    moq: 30,
    unit: "세트",
    region: "서울",
    condition: "패키지 변경",
    deadline: "2026-10-08",
    image: "/images/skincare.jpg",
    seller: "활기찬 서울 금천구",
    description:
      "패키지 변경에 따른 기존 디자인 재고입니다. 미개봉 상품으로 구성되며 사용기한, 성분 및 판매에 필요한 표시사항은 거래 전 확인해 주세요.",
    sample: true,
  },
  {
    id: "sample-detergent",
    title: "데일리 액체 세탁세제 2L",
    category: "생활·주방",
    price: 2200,
    originalPrice: 9900,
    stock: 960,
    moq: 24,
    unit: "개",
    region: "전라",
    condition: "재고정리",
    deadline: "2026-10-15",
    image: "/images/detergent.jpg",
    seller: "꼼꼼한 인천 서구",
    description:
      "생활용품 유통 채널 변경으로 출고하는 액체 세탁세제입니다. 2L 단위 미개봉 상품입니다. 상세 성분과 사용 안내는 상품 라벨 확인이 필요합니다.",
    sample: true,
  },
];
export const won = (n: number) => new Intl.NumberFormat("ko-KR").format(n);
export const discount = (p: Product) =>
  Math.round((1 - p.price / p.originalPrice) * 100);
export const daysLeft = (date: string, now = new Date()) => {
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  return Math.round(
    (Date.parse(date + "T00:00:00+09:00") -
      Date.parse(today + "T00:00:00+09:00")) /
      86400000,
  );
};
