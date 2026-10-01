"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  Heart,
  ChevronRight,
  Clock3,
  SlidersHorizontal,
  MapPin,
  Plus,
  Grid2X2,
  Leaf,
  Armchair,
  Shirt,
  Sparkles,
  Monitor,
  Wrench,
  Truck,
  Download,
  RotateCcw,
  ShoppingBag,
  X,
  LoaderCircle,
  WifiOff,
  LogIn,
  Bell,
  Gavel,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  categories,
  samples,
  won,
  discount,
  daysLeft,
  type Product,
} from "@/lib/catalog";
import { api, type MarketData, type Notification, type Offer, type Order } from "@/lib/models";
import {
  Modal,
  ProductDetail,
  ListingForm,
  Logistics,
  ProfileForm,
  Dashboard,
  Conversation,
} from "./flows";
import { Countdown, OrderView, RelistForm } from "./auction";
import { unsubscribePush } from "./push";
import { usePwa, InstallInstructions } from "./pwa";
const categoryIcons = [
  Grid2X2,
  Leaf,
  Armchair,
  Shirt,
  Sparkles,
  Monitor,
  Wrench,
];
const initial: MarketData = {
  products: samples,
  user: null,
  favorites: [],
  profile: null,
  offers: [],
  messages: [],
  ownListings: [],
  bids: [],
  orders: [],
  notifications: [],
  unread: 0,
  isAdmin: false,
  adminOrders: [],
  deposits: [],
  revenue: null,
  bidListings: [],
  disputes: [],
  penalty: { due: 0, items: [] },
  fraud: [],
  duplicateBusiness: [],
  settings: { feeRate: 0.03, penaltyRate: 0.1, autoConfirmDays: 7, belowReservePolicy: "seller_decides", successionEnabled: false, penalizeNonpayment: false, paymentHours: 24, bankAccount: "", feeTable: null, categoryFeeRates: {}, vapidPublicKey: "", depositWebhook: false },
};
type View = "market" | "closing" | "bulk" | "saved" | "trades" | "auctions";
const views: View[] = ["market", "closing", "bulk", "saved", "trades", "auctions"];
export default function Marketplace({ signInUrl }: { signInUrl: string }) {
  const [data, setData] = useState<MarketData>(initial),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("전체"),
    [region, setRegion] = useState("전체 지역"),
    [sort, setSort] = useState("추천순"),
    [view, setView] = useState<View>("market"),
    [conditions, setConditions] = useState<string[]>([]),
    [small, setSmall] = useState(false),
    [half, setHalf] = useState(false);
  const [modal, setModal] = useState(""),
    [productId, setProductId] = useState<string | null>(null),
    [offer, setOffer] = useState<Offer | null>(null),
    [order, setOrder] = useState<Order | null>(null),
    [relist, setRelist] = useState<{ product: Product; remainder?: number } | null>(null),
    [dashboardTab, setDashboardTab] = useState("auction"),
    [pendingOrderId, setPendingOrderId] = useState<string | null>(null),
    [pendingFavorite, setPendingFavorite] = useState<string | null>(null);
  const pwa = usePwa();
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/market", { cache: "no-store" }),
        body = (await r.json()) as MarketData & { error?: string };
      if (!r.ok) throw new Error(body.error);
      setData(body);
      setLoadError("");
      try {
        if (body.unread > 0) void navigator.setAppBadge?.(body.unread);
        else void navigator.clearAppBadge?.();
      } catch {}
    } catch (e) {
      setLoadError(
        e instanceof Error
          ? e.message
          : "연결이 불안정합니다. 다시 시도해 주세요.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // Synchronize initial URL and server state after hydration; later updates
    // arrive from navigation events and the asynchronous network response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const readUrl = () => {
      const q = new URLSearchParams(location.search);
      const v = q.get("view");
      setView(v && views.includes(v as View) ? (v as View) : "market");
      setProductId(q.get("product"));
      const tab = q.get("tab");
      if (tab) setDashboardTab(tab);
      setPendingOrderId(q.get("order"));
    };
    readUrl();
    window.addEventListener("popstate", readUrl);
    return () => window.removeEventListener("popstate", readUrl);
  }, [refresh]);
  useEffect(() => {
    // A push notification deep link (?order=…) opens the order once data arrives.
    if (!pendingOrderId || loading) return;
    const found = data.orders.find((o) => o.id === pendingOrderId) || data.adminOrders.find((o) => o.id === pendingOrderId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingOrderId(null);
    if (found) setOrder(found);
    else if (data.user) setNotice("주문을 찾을 수 없습니다.");
    const url = new URL(location.href);
    url.searchParams.delete("order");
    history.replaceState(null, "", url.pathname + url.search);
  }, [pendingOrderId, loading, data.orders, data.adminOrders, data.user]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    if (!data.user && !productId) return;
    // Live auctions and pending orders poll while the tab is visible.
    // An open auction polls its own light endpoint every 3 s; the full snapshot can be slower.
    const live = productId ? data.products.find((p) => p.id === productId)?.auction?.status === "active" : false;
    const period = live ? 30000 : view === "trades" || view === "auctions" ? 30000 : 60000;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void refresh();
    }, period);
    return () => clearInterval(id);
  }, [view, data.user, refresh, productId, data.products]);
  function navigate(v: View, tab?: string) {
    setView(v);
    setProductId(null);
    setOffer(null);
    setOrder(null);
    if (tab) setDashboardTab(tab);
    const url = new URL(location.href);
    url.searchParams.delete("product");
    url.searchParams.delete("tab");
    if (v === "market") url.searchParams.delete("view");
    else url.searchParams.set("view", v);
    if (tab) url.searchParams.set("tab", tab);
    history.pushState(null, "", url.pathname + url.search);
    if (v === "trades") window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function openNotification(n: Notification) {
    if (n.refType === "order" && n.refId) {
      const found = data.orders.find((o) => o.id === n.refId) || data.adminOrders.find((o) => o.id === n.refId);
      if (found) {
        setOrder(found);
        return;
      }
      setNotice("주문을 찾을 수 없습니다.");
      return;
    }
    if (n.refType === "listing" && n.refId) {
      const inMarket = data.products.some((p) => p.id === n.refId) || data.bidListings.some((p) => p.id === n.refId);
      const own = data.ownListings.find((p) => p.id === n.refId);
      if (inMarket || own?.status === "pending") showProduct(n.refId);
      else if (own?.status === "unsold") setRelist({ product: own });
      else if (own && own.auction && own.auction.unsoldQuantity > 0) setRelist({ product: own, remainder: own.auction.unsoldQuantity });
      else if (own) setDashboardTab("stock");
      else setNotice("종료된 상품입니다.");
      return;
    }
    if (n.refType === "deposit") navigate("trades", "admin");
  }
  function showProduct(id: string | null) {
    setProductId(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set("product", id);
    else url.searchParams.delete("product");
    history.pushState(null, "", url.pathname + url.search);
  }
  function requireUser(next: string) {
    if (!data.user) {
      setModal("login");
      return;
    }
    if (next === "register" && !data.profile?.publicAlias) {
      setNotice("사업자 주소를 저장하면 거래 별칭이 배정됩니다. 등록 후 재고를 올려 주세요.");
      setModal("profile");
      return;
    }
    setModal(next);
  }
  async function action(payload: Record<string, unknown>) {
    if (!data.user) {
      setModal("login");
      throw new Error("로그인 후 이용해 주세요.");
    }
    if (!navigator.onLine)
      throw new Error(
        "오프라인 상태입니다. 인터넷에 연결한 뒤 다시 시도해 주세요.",
      );
    if (["create_offer", "bid"].includes(String(payload.action)) && !data.profile?.publicAlias) {
      showProduct(null);
      setModal("profile");
      throw new Error("사업자 주소를 먼저 등록해 주세요.");
    }
    await api(payload);
    await refresh();
  }
  async function favorite(p: Product) {
    if (pendingFavorite) return;
    if (!data.user) {
      setModal("login");
      return;
    }
    setPendingFavorite(p.id);
    try {
      const saved = !data.favorites.includes(p.id);
      await action({ action: "favorite", productId: p.id, saved });
      setNotice(
        saved ? "관심상품에 저장했습니다." : "관심상품에서 해제했습니다.",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setPendingFavorite(null);
    }
  }
  function reset() {
    setRegion("전체 지역");
    setCategory("전체");
    setQuery("");
    setConditions([]);
    setSmall(false);
    setHalf(false);
  }
  function toggleCondition(value: string) {
    setConditions((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }
  const products = data.products
    .filter(
      (p) =>
        (category === "전체" || p.category === category) &&
        (region === "전체 지역" || p.region === region) &&
        `${p.title} ${p.seller} ${p.category}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()) &&
        (!conditions.length || conditions.includes(p.condition)) &&
        (!small || p.moq <= 30) &&
        (!half || discount(p) >= 50) &&
        (view !== "closing" ||
          (daysLeft(p.deadline) >= 0 && daysLeft(p.deadline) <= 7)) &&
        (view !== "bulk" || p.stock >= 500) &&
        (view !== "auctions" || p.saleType === "auction") &&
        (view !== "saved" || data.favorites.includes(p.id)),
    )
    .sort((a, b) =>
      sort === "할인율 높은순"
        ? discount(b) - discount(a)
        : sort === "낮은 가격순"
          ? a.price - b.price
          : sort === "마감 임박순"
            ? a.deadline.localeCompare(b.deadline)
            : sort === "최신 등록순"
              ? (b.createdAt || "").localeCompare(a.createdAt || "")
              : 0,
    );
  const selected = data.products.find((p) => p.id === productId) || data.ownListings.find((p) => p.id === productId) || data.bidListings.find((p) => p.id === productId);
  const filtered =
    category !== "전체" ||
    region !== "전체 지역" ||
    !!query ||
    conditions.length > 0 ||
    small ||
    half;
  // WebMCP is an optional browser enhancement; all actions share the visible UI state.
  useEffect(() => {
    type Registry = {
      registerTool: (
        tool: {
          name: string;
          description: string;
          inputSchema: object;
          annotations: object;
          execute: (input: unknown) => unknown;
        },
        opts: { signal: AbortSignal },
      ) => void | Promise<void>;
    };
    const context = (document as Document & { modelContext?: Registry })
      .modelContext;
    if (!context?.registerTool) return;
    const life = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: "search_inventory",
            description:
              "Search inventory and update the visible marketplace results. Does not place an order.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                category: { type: "string", enum: categories },
              },
              required: ["query"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            execute(input) {
              const x = input as { query?: unknown; category?: unknown };
              if (
                typeof x?.query !== "string" ||
                x.query.length > 100 ||
                (x.category !== undefined &&
                  !categories.includes(String(x.category)))
              )
                throw new Error("Invalid search");
              const nextCategory =
                typeof x.category === "string" ? x.category : "전체";
              reset();
              setQuery(x.query);
              setCategory(nextCategory);
              setView("market");
              const u = new URL(location.href);
              u.searchParams.delete("view");
              u.searchParams.delete("product");
              history.replaceState(null, "", u.pathname + u.search);
              return {
                query: x.query,
                category: nextCategory,
                results: data.products
                  .filter(
                    (p) =>
                      (nextCategory === "전체" ||
                        p.category === nextCategory) &&
                      `${p.title} ${p.seller} ${p.category}`
                        .toLowerCase()
                        .includes((x.query as string).toLowerCase().trim()),
                  )
                  .map((p) => ({
                    id: p.id,
                    title: p.title,
                    price: p.price,
                    minimum: p.moq,
                  })),
              };
            },
          },
          { signal: life.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => life.abort();
  }, [data.products]);
  const filterControls = (
    <>
      <div className="filter-heading">
        <b>
          <SlidersHorizontal size={16} />
          상세 필터
        </b>
        <button aria-label="필터 초기화" onClick={reset}>
          <RotateCcw size={15} />
        </button>
      </div>
      <label className="filter-label">보관 지역</label>
      <div className="select-wrap">
        <MapPin size={16} />
        <select
          aria-label="보관 지역"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          {[
            "전체 지역",
            "서울",
            "경기",
            "인천",
            "충청",
            "경상",
            "전라",
            "강원",
            "제주",
          ].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </div>
      <div className="filter-block">
        <b>상품 상태</b>
        {[
          "새상품",
          "재고정리",
          "시즌오프",
          "소비기한 임박",
          "박스훼손",
          "패키지 변경",
        ].map((t) => (
          <label className="check-row" key={t}>
            <input
              type="checkbox"
              checked={conditions.includes(t)}
              onChange={() => toggleCondition(t)}
            />
            {t}
          </label>
        ))}
      </div>
      <div className="filter-block">
        <b>매입 조건</b>
        <label className="check-row">
          <input
            type="checkbox"
            checked={small}
            onChange={(e) => setSmall(e.target.checked)}
          />
          최소 수량 30 이하
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={half}
            onChange={(e) => setHalf(e.target.checked)}
          />
          50% 이상 할인
        </label>
      </div>
    </>
  );
  return (
    <>
      <a href="#catalog" className="skip-link">
        상품 목록으로 바로가기
      </a>
      <div className="utility">
        <div className="wrap">
          <span>사업자의 새로운 매입 루트, 덤핑몰</span>
          <span>
            <button onClick={() => setModal("guide")}>
              이용 안내 <ChevronRight size={12} />
            </button>
            <i />
            {data.user ? (
              <>
                <button onClick={() => requireUser("profile")}>
                  내 사업자 정보
                </button>
                <form
                  action="/api/logout"
                  method="post"
                  style={{ display: "inline" }}
                  onSubmit={(e) => {
                    // Drop this device's push subscription before the session ends.
                    e.preventDefault();
                    const form = e.currentTarget;
                    void unsubscribePush(action).finally(() => form.submit());
                  }}
                >
                  <button type="submit">로그아웃</button>
                </form>
              </>
            ) : (
              <button onClick={() => setModal("login")}>로그인</button>
            )}
          </span>
        </div>
      </div>
      <header>
        <div className="wrap header-main">
          <Link href="/" className="brand" onClick={() => navigate("market")}>
            <img src="/favicon.svg" alt="" />
            <b>
              덤핑몰<span>dumping mall</span>
            </b>
          </Link>
          <form
            className="search-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (view === "trades") navigate("market");
              document
                .getElementById("catalog")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <Search size={20} />
            <input
              aria-label="상품 검색"
              placeholder="상품명이나 거래 별칭을 검색하세요"
              value={query}
              maxLength={100}
              onChange={(e) => {
                setQuery(e.target.value);
                if (view === "trades") navigate("market");
              }}
            />
            {query ? (
              <button
                type="button"
                aria-label="검색어 지우기"
                onClick={() => setQuery("")}
              >
                <X size={16} />
              </button>
            ) : (
              <span>재고 통합검색</span>
            )}
          </form>
          <div className="header-actions">
            <button className="icon-label" onClick={() => navigate("saved")}>
              <Heart size={22} />
              <span>관심상품</span>
            </button>
            <button className="icon-label bell" onClick={() => (data.user ? navigate("trades", "alerts") : setModal("login"))} aria-label={`알림 ${data.unread}건`}>
              <Bell size={22} />
              {data.unread > 0 && <i>{data.unread > 9 ? "9+" : data.unread}</i>}
              <span>알림</span>
            </button>
            <button className="icon-label" onClick={() => navigate("trades")}>
              <ShoppingBag size={22} />
              <span>내 거래</span>
            </button>
            <Button
              className="primary register"
              onClick={() => requireUser("register")}
            >
              <Plus size={17} />
              재고 등록
            </Button>
          </div>
        </div>
        <nav className="wrap main-nav" aria-label="주요 메뉴">
          <div>
            {(
              [
                { id: "market", label: "재고 마켓", icon: true },
                { id: "auctions", label: "전량 경매" },
                { id: "closing", label: "마감 임박" },
                { id: "bulk", label: "대량 매입" },
                { id: "trades", label: "거래 관리" },
              ] as const
            ).map((n) => (
              <button
                className={view === n.id ? "active" : ""}
                key={n.id}
                onClick={() => navigate(n.id)}
              >
                {n.id === "market" && <Grid2X2 size={18} />}
                {n.id === "auctions" && <Gavel size={16} />} {n.label}
                {n.id === "closing" && <span className="nav-dot" />}
              </button>
            ))}
          </div>
          <button className="app-link" onClick={() => setModal("install")}>
            <Download size={15} />
            앱으로 더 편하게
          </button>
        </nav>
      </header>
      {pwa.offline && (
        <div className="connection-banner">
          <WifiOff size={16} />
          오프라인입니다. 저장과 거래 요청은 연결 후 이용해 주세요.
        </div>
      )}
      <main className="wrap">
        {loadError && (
          <div className="load-error" role="alert">
            <span>{loadError}</span>
            <button onClick={() => void refresh()}>
              다시 불러오기 <RotateCcw size={14} />
            </button>
          </div>
        )}
        {view === "trades" ? (
          data.user ? (
            <Dashboard
              key={dashboardTab}
              initialTab={dashboardTab}
              data={data}
              onAction={action}
              onSelectOffer={setOffer}
              onSelectOrder={setOrder}
              onOpenProduct={showProduct}
              onRelist={(p, remainder) => setRelist({ product: p, remainder })}
              onNotification={openNotification}
              onNotice={setNotice}
              onRegister={() => requireUser("register")}
              onProfile={() => requireUser("profile")}
            />
          ) : (
            <section className="login-gate">
              <ShoppingBag size={44} />
              <h1>내 거래를 한곳에서 관리하세요</h1>
              <p>로그인하면 견적과 관심상품을 계정에 저장할 수 있습니다.</p>
              <Button className="primary" onClick={() => setModal("login")}>
                로그인하고 시작하기 <ArrowRight />
              </Button>
            </section>
          )
        ) : (
          <>
            {view === "market" && (
              <section className="wholesale-intro" aria-label="덤핑몰 재고 마켓 안내">
                <div className="intro-copy">
                  <span className="intro-tag">사장님을 위한 재고 특가</span>
                  <h1>필요한 재고, <em>부담 없는 매입.</em></h1>
                  <p>필요한 수량과 가격을 직접 제안하세요.</p>
                  <button onClick={() => navigate("closing")}>마감 임박 재고 보기 <ArrowRight size={16} /></button>
                </div>
                <div className="intro-products" aria-hidden="true">
                  <img src="/images/coffee.jpg" alt="" />
                  <img src="/images/towels.jpg" alt="" />
                  <span>재고의 새로운 기회</span>
                </div>
              </section>
            )}
            <section className="market-section" id="catalog">
              <div className="section-heading">
                <div>
                  <h2>
                    {view === "closing"
                      ? "마감 임박 재고"
                      : view === "saved"
                        ? "내 관심상품"
                        : view === "bulk"
                          ? "대량 매입 재고"
                          : view === "auctions"
                            ? "전량 경매"
                            : "오늘의 재고 마켓"}
                    <span className="count-badge">{products.length}</span>
                  </h2>
                </div>
                <span className="market-caption">
                  {view === "bulk"
                    ? "500개 이상 재고를 보유한 상품"
                    : view === "closing"
                      ? "7일 이내 마감되는 상품"
                      : view === "auctions"
                        ? "입찰로 전량을 매입하는 재고"
                        : "필요한 만큼, 합리적인 가격으로"}
                </span>
              </div>
              <div className="category-tabs" aria-label="상품 카테고리">
                {categories.map((c, i) => {
                  const Icon = categoryIcons[i];
                  return (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      aria-pressed={category === c}
                      className={category === c ? "selected" : ""}
                    >
                      <Icon size={21} />
                      {c}
                    </button>
                  );
                })}
              </div>
              <div className="quick-filters" aria-label="빠른 상품 필터">
                <label><MapPin size={15} /><span className="sr-only">보관 지역</span>
                  <select value={region} onChange={e => setRegion(e.target.value)}>
                    {["전체 지역", "서울", "경기", "인천", "충청", "경상", "전라", "강원", "제주"].map(r => <option key={r}>{r}</option>)}
                  </select>
                </label>
                <button aria-pressed={small} onClick={() => setSmall(!small)}>소량 매입</button>
                <button aria-pressed={half} onClick={() => setHalf(!half)}>50% 이상 할인</button>
                <button onClick={() => setModal("filters")}><SlidersHorizontal size={15} />상세 필터</button>
                <button className="logistics-shortcut" onClick={() => setModal("logistics")}><Truck size={16} />물류비 계산</button>
              </div>
              <div className="catalog-layout">
                <div className="catalog-results">
                  <div className="results-toolbar">
                    <p>
                      {view === "saved" ? "관심상품" : "전체"}{" "}
                      <b>{products.length}개</b>의 재고{" "}
                      {loading && (
                        <LoaderCircle size={13} className="spinner" />
                      )}
                    </p>
                    <div>
                      <button
                        className="mobile-filter"
                        onClick={() => setModal("filters")}
                      >
                        <SlidersHorizontal size={15} />
                        필터{filtered && <span />}
                      </button>
                      <select
                        aria-label="상품 정렬"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        {[
                          "추천순",
                          "마감 임박순",
                          "할인율 높은순",
                          "낮은 가격순",
                          "최신 등록순",
                        ].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {filtered && (
                    <div className="active-filters">
                      <span>
                        {[
                          query && `“${query}”`,
                          category !== "전체" && category,
                          region !== "전체 지역" && region,
                          ...conditions,
                          small && "최소 수량 30 이하",
                          half && "50% 이상 할인",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <button onClick={reset}>
                        초기화 <X size={13} />
                      </button>
                    </div>
                  )}
                  <div className="product-grid">
                    {products.map((p) => (
                      <ProductCard
                        key={p.id}
                        product={p}
                        onOpen={() => showProduct(p.id)}
                        onFavorite={() => void favorite(p)}
                        saved={data.favorites.includes(p.id)}
                        disabled={pendingFavorite === p.id}
                      />
                    ))}
                  </div>
                  {products.length === 0 && (
                    <div className="empty">
                      {view === "saved" ? (
                        <Heart size={36} />
                      ) : (
                        <Search size={36} />
                      )}
                      <h3>
                        {view === "saved"
                          ? "눈여겨본 재고를 저장해 보세요"
                          : "조건에 맞는 재고가 없어요"}
                      </h3>
                      <p>
                        {view === "saved"
                          ? "상품의 하트를 눌러 한곳에서 비교할 수 있어요."
                          : "검색어나 필터를 조금 바꿔보세요."}
                      </p>
                      <Button
                        className="primary"
                        onClick={() => {
                          reset();
                          navigate("market");
                        }}
                      >
                        전체 재고 보기
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </section>
            <div className="bottom-banner">
              <div>
                <span>남은 재고에 새로운 가치를.</span>
                <h2>사장님의 다음 거래가 시작되는 곳, 덤핑몰</h2>
              </div>
              <button onClick={() => requireUser("register")}>
                재고 등록하기 <ArrowUpRight size={19} />
              </button>
            </div>
          </>
        )}
      </main>
      <footer>
        <div className="wrap">
          <div>
            <Link className="brand" href="/" onClick={() => navigate("market")}>
              <img src="/favicon.svg" alt="" />
              <b>덤핑몰</b>
            </Link>
            <p>재고의 끝에서, 새로운 거래의 시작으로.</p>
          </div>
          <div>
            <b>사업자를 위한 재고 거래 플랫폼</b>
            <p>전량 경매 · 입금 확인 후 연락처 공개 · 인수 완료 후 정산</p>
            <div className="footer-links">
              <button onClick={() => setModal("guide")}>이용 안내</button>
              <button onClick={() => setModal("logistics")}>
                물류비 계산기
              </button>
              <button onClick={() => setModal("install")}>앱 설치</button>
            </div>
            <small>© 2026 DUMPING MALL. All rights reserved.</small>
          </div>
        </div>
      </footer>
      <nav className="mobile-nav" aria-label="모바일 메뉴">
        <button
          className={view === "market" ? "selected" : ""}
          onClick={() => navigate("market")}
        >
          <Grid2X2 />
          재고 마켓
        </button>
        <button
          className={view === "closing" ? "selected" : ""}
          onClick={() => navigate("closing")}
        >
          <Clock3 />
          마감 임박
        </button>
        <button onClick={() => requireUser("register")}>
          <Plus />
          재고 등록
        </button>
        <button
          className={view === "saved" ? "selected" : ""}
          onClick={() => navigate("saved")}
        >
          <Heart />
          관심상품
        </button>
        <button
          className={view === "trades" ? "selected" : ""}
          onClick={() => navigate("trades")}
        >
          <ShoppingBag />내 거래
        </button>
      </nav>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button aria-label="알림 닫기" onClick={() => setNotice("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {selected && (
        <ProductDetail
          key={selected.id}
          product={selected}
          onClose={() => showProduct(null)}
          onAction={action}
          onSuccess={() => {
            navigate("trades");
            setNotice("견적을 저장했습니다. 내 거래에서 확인해 주세요.");
          }}
          favorite={data.favorites.includes(selected.id)}
          onFavorite={() => void favorite(selected)}
          userId={data.user?.id}
          data={data}
          onNotice={setNotice}
          onRefresh={() => void refresh()}
        />
      )}
      {productId && !selected && !loading && !loadError && (
        <Modal
          open
          title="상품을 찾을 수 없어요"
          onClose={() => showProduct(null)}
          description="판매가 종료되었거나 삭제된 상품입니다."
        >
          <Button className="primary" onClick={() => showProduct(null)}>
            마켓으로 돌아가기
          </Button>
        </Modal>
      )}
      <Modal
        open={modal === "register"}
        onClose={() => setModal("")}
        title="재고 등록하기"
        description="잠들어 있는 재고에 새로운 구매자를 연결하세요."
        wide
      >
        {modal === "register" && (
          <ListingForm
            policy={data.settings.belowReservePolicy}
            succession={data.settings.successionEnabled}
            profile={data.profile}
            onAction={action}
            onDone={() => {
              setModal("");
              reset();
              navigate("market");
              setSort("최신 등록순");
              setNotice("재고가 등록되었습니다. 마켓에서 확인해 주세요.");
            }}
          />
        )}
      </Modal>
      <Modal
        open={modal === "logistics"}
        onClose={() => setModal("")}
        title="물류비 간편 계산"
        description="매입 전에 운송비의 대략적인 범위를 확인하세요."
      >
        {modal === "logistics" && <Logistics />}
      </Modal>
      <Modal
        open={modal === "profile"}
        onClose={() => setModal("")}
        title="내 사업자 정보"
        description="견적과 재고 등록에 사용할 사업자 정보를 저장하세요."
      >
        {modal === "profile" && (
          <ProfileForm
            profile={data.profile}
            userId={data.user?.id}
            onAction={action}
            onDone={() => {
              setModal("");
              setNotice("사업자 정보를 저장했습니다.");
            }}
          />
        )}
      </Modal>
      <Modal
        open={modal === "install"}
        onClose={() => setModal("")}
        title="덤핑몰을 앱으로 만나보세요"
      >
        <InstallInstructions pwa={pwa} />
      </Modal>
      <Modal
        open={modal === "filters"}
        onClose={() => setModal("")}
        title="원하는 조건으로 찾아보세요"
      >
        {filterControls}
        <Button className="primary full-button" onClick={() => setModal("")}>
          {products.length}개 재고 보기
        </Button>
      </Modal>
      <Modal
        open={modal === "login"}
        onClose={() => setModal("")}
        title="사장님의 다음 거래를 시작하세요"
        description="견적, 관심상품, 재고 정보를 계정에 안전하게 저장합니다."
      >
        <div className="login-content">
          <LogIn size={35} />
          <p>
            이메일 인증으로 간편하게 로그인합니다.
            <br />
            사업자 정보는 로그인 후 별도로 등록할 수 있어요.
          </p>
          <Button className="primary full-button" asChild>
            <a href={signInUrl} target="_top">
              이메일로 시작하기 <ArrowRight size={16} />
            </a>
          </Button>
        </div>
      </Modal>
      <Modal
        open={modal === "guide"}
        onClose={() => setModal("")}
        title="덤핑몰 이용 안내"
        description="재고의 다음 기회를 만드는 거래 흐름"
      >
        <div className="guide">
          <h3>01. 필요한 재고를 찾으세요</h3>
          <p>카테고리·지역·상태로 검색하고 최소 수량과 단가를 비교합니다.</p>
          <h3>02. 전량 경매에 입찰하세요 (즉시구매가 있으면 바로 낙찰)</h3>
          <p>
            공급자가 비딩 기간, 공개 즉시구매가, 비공개 최저 매각가를 정해 재고를 경매에 올립니다.
            현재 최고가보다 높게만 입찰할 수 있고, 즉시구매가 이상 입찰하면 그 자리에서 낙찰됩니다.
            마감 때 최고 입찰가가 최저 매각가 이상이면 자동 낙찰되고, 못 미치면 판매자가 24시간 안에 최고 입찰가로
            판매할지 정합니다. 판매하기로 하면 그대로 낙찰됩니다. 입찰은 구매 약속이라 취소할 수 없고, 최저 매각가는 구매자에게 공개되지 않습니다.
          </p>
          <h3>03. 입금 후 연락처가 공개됩니다</h3>
          <p>
            낙찰자가 {data.settings.paymentHours}시간 안에 덤핑몰 계좌로 입금하고 운영자가 확인하면 두 사업자의
            상호와 연락처가 서로 공개됩니다. 공급자는 출고 사진을 올려 출고하고, 구매자가 수령을 확인하면(또는
            {data.settings.autoConfirmDays}일 뒤 자동 확인) 수수료 {Math.round(data.settings.feeRate * 1000) / 10}%(판매자 부담)를 제외한 금액을 정산합니다.
            {data.settings.penalizeNonpayment
              ? `낙찰 후 입금하지 않거나 단순 변심으로 취소하면 낙찰가의 ${Math.round(data.settings.penaltyRate * 100)}% 위약금이 부과됩니다.`
              : `낙찰 후 ${data.settings.paymentHours}시간 안에 입금하지 않으면 거래가 자동 취소됩니다. 입금 후 단순 변심으로 취소하면 낙찰가의 ${Math.round(data.settings.penaltyRate * 100)}% 위약금이 부과될 수 있습니다.`}
          </p>
          <h3>04. 견적 협의도 가능합니다</h3>
          <p>
            경매가 아닌 상품은 수량과 가격을 제안해 협의합니다. 견적 합의는 주문 확정이 아닙니다.
          </p>
          <div className="inline-notice">
            샘플 상품은 실제 판매되지 않습니다. 입금은 계좌이체로 진행되며 사업자 진위확인·알림톡은 아직 연결되지 않았습니다.
          </div>
          <p className="privacy-note">
            로그인한 계정에 관심상품·견적·대화·사업자 정보가 저장됩니다. 등록
            상품과 사진은 마켓에 표시됩니다. 사업자등록증이나 개인 신분증은 상품
            사진으로 올리지 마세요.
          </p>
        </div>
      </Modal>
      <Modal
        open={!!order}
        onClose={() => setOrder(null)}
        title="낙찰 주문"
        description="입금 → 연락처 공개 → 인수 → 정산 순서로 진행됩니다."
        wide
      >
        {order && <OrderView order={order} data={data} onAction={action} onNotice={setNotice} />}
      </Modal>
      <Modal
        open={!!relist}
        onClose={() => setRelist(null)}
        title={relist?.remainder ? "미낙찰 잔여 수량 다시 경매" : "유찰 재고 다시 경매"}
        description="기간과 최저 매각가를 조정해 같은 재고를 다시 올립니다."
      >
        {relist && (
          <RelistForm
            succession={data.settings.successionEnabled}
            product={relist.product}
            remainder={relist.remainder}
            onAction={action}
            onDone={() => {
              setRelist(null);
              setNotice("경매를 다시 시작했습니다.");
            }}
          />
        )}
      </Modal>
      <Modal
        open={!!offer}
        onClose={() => setOffer(null)}
        title="견적 협의"
        description="조건을 확인하고 거래별 대화를 이어가세요."
        wide
      >
        {offer && <Conversation offer={offer} data={data} onAction={action} />}
      </Modal>
    </>
  );
}
function ProductCard({
  product: p,
  onOpen,
  onFavorite,
  saved,
  disabled,
}: {
  product: Product;
  onOpen: () => void;
  onFavorite: () => void;
  saved: boolean;
  disabled: boolean;
}) {
  return (
    <article className="product-card">
      <div className="product-image">
        <button
          className="product-open"
          onClick={onOpen}
          aria-label={`${p.title} 상세 보기`}
        >
          <img
            className={`photo-${p.id.replace("sample-", "")}`}
            src={p.image}
            alt={p.title}
            loading="lazy"
          />
        </button>
        <span
          className={`stock-badge ${p.auction ? "auction" : daysLeft(p.deadline) <= 7 ? "urgent" : ""}`}
        >
          {p.auction ? (
            <>
              <Gavel size={12} />
              {p.auction.mode === "partial" ? "부분 경매" : "경매중"} · 입찰 {p.auction.bidCount}
            </>
          ) : daysLeft(p.deadline) < 0 ? (
            "마감"
          ) : daysLeft(p.deadline) <= 7 ? (
            <>
              <Clock3 size={12} />
              마감 D-{daysLeft(p.deadline)}
            </>
          ) : (
            p.condition
          )}
        </span>
        <button
          className={`heart-button ${saved ? "saved" : ""}`}
          disabled={disabled}
          onClick={onFavorite}
          aria-pressed={saved}
          aria-label={`${p.title} 관심상품 ${saved ? "해제" : "저장"}`}
        >
          <Heart size={19} />
        </button>
      </div>
      <div className="product-meta">
        <span>{p.seller}</span>
        <span>
          <MapPin size={12} />
          {p.region}
        </span>
      </div>
      <h3>
        <button onClick={onOpen}>{p.title}</button>
      </h3>
      <div className="price-original">
        정상가 <s>{won(p.originalPrice)}원</s>
        {p.sample && <span>샘플</span>}
      </div>
      {p.auction ? (
        <>
          <div className="product-price">
            <strong>{Math.max(0, Math.round((1 - (p.auction.mode === "partial" ? (p.auction.cutoffPrice ?? p.auction.startPrice) : (p.auction.currentPrice ?? p.auction.startPrice)) / p.originalPrice) * 100))}%</strong>
            <b>
              {won(p.auction.mode === "partial" ? (p.auction.cutoffPrice ?? p.auction.startPrice) : (p.auction.currentPrice ?? p.auction.startPrice))}
              <small>원</small>
            </b>
            <span>/ {p.unit} {p.auction.mode === "partial" ? (p.auction.cutoffPrice === null ? "시작가" : "낙찰 하한가") : p.auction.currentPrice === null ? "시작가" : "현재가"}</span>
          </div>
          <div className="product-terms">
            <span>
              {p.auction.mode === "partial" ? (
                <>
                  최소 <b>{won(p.auction.minLot)}{p.unit}</b> · 잔여 <b>{won(p.auction.remainingQuantity)}</b>
                </>
              ) : p.auction.instantPrice !== null ? (
                <>
                  즉시구매 <b>{won(p.auction.instantPrice)}원</b>
                </>
              ) : (
                <>
                  전량{" "}
                  <b>
                    {won(p.auction.quantity)}
                    {p.unit}
                  </b>
                </>
              )}
            </span>
            <i />
            <Countdown endsAt={p.auction.endsAt} />
          </div>
        </>
      ) : (
        <>
          <div className="product-price">
            <strong>{discount(p)}%</strong>
            <b>
              {won(p.price)}
              <small>원</small>
            </b>
            <span>/ {p.unit}</span>
          </div>
          <div className="product-terms">
            <span>
              최소{" "}
              <b>
                {won(p.moq)}
                {p.unit}
              </b>
            </span>
            <i />
            <span>
              잔여{" "}
              <b>
                {won(p.stock)}
                {p.unit}
              </b>
            </span>
          </div>
        </>
      )}
    </article>
  );
}
