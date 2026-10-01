"use client";
import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BellRing,
  Camera,
  CheckCircle2,
  Clock3,
  Copy,
  Gavel,
  ImagePlus,
  Landmark,
  PhoneCall,
  RotateCcw,
  ShieldCheck,
  TrendingDown,
  Truck,
  Users,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { won, type Product } from "@/lib/catalog";
import {
  AUCTION_DAYS,
  DECISION_HOURS,
  OFFER_HOURS,
  PAYMENT_HOURS,
  SUCCESSION_MAX_ROUNDS,
  SUCCESSION_WINDOW_DAYS,
  bidStep,
  remainingLabel,
} from "@/lib/auction-core";
import {
  api,
  auctionStatusLabels,
  orderStatusLabel,
  orderStatusLabels,
  feeRateFor,
  type Auction,
  type Bid,
  type Dispute,
  type MarketData,
  type Notification,
  type Order,
} from "@/lib/models";
import type { Action } from "./flows";
import { PushToggle } from "./push";
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;
}
// `offsetMs` shifts the local clock to the server clock (auction deadlines are server time).
export function useNow(active = true, everyMs = 1000, offsetMs = 0) {
  const [now, setNow] = useState(() => new Date(Date.now() + offsetMs));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(new Date(Date.now() + offsetMs)), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, offsetMs]);
  return now;
}
export function Countdown({ endsAt, className = "", offsetMs = 0 }: { endsAt: string; className?: string; offsetMs?: number }) {
  const now = useNow(true, 1000, offsetMs);
  const ms = Date.parse(endsAt) - now.getTime();
  return (
    <span className={`countdown ${ms > 0 && ms < 3600000 ? "urgent" : ""} ${className}`}>
      <Clock3 size={13} />
      {remainingLabel(endsAt, now)}
    </span>
  );
}
export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
const successionCopy = `낙찰자가 미입금하면 차순위 입찰자에게 자동 제안 (최저 매각가 이상 입찰만 · 최대 ${SUCCESSION_MAX_ROUNDS}회 · 마감 후 ${SUCCESSION_WINDOW_DAYS}일)`;
// Listing-form fields for an auction. All inputs are named so the parent form
// reads them from FormData; mode/minLot/succession stay in local state for UI only.
export function AuctionFields({ price, stock, policy = "seller_decides", succession = false }: {
  price: number | ""; stock: number | ""; policy?: "seller_decides" | "buyer_only"; succession?: boolean;
}) {
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState<"whole" | "partial">("whole");
  const [reserve, setReserve] = useState<number | "">("");
  return (
    <div className="auction-fields">
      <div className="mode-toggle" role="radiogroup" aria-label="경매 방식">
        <label className={mode === "whole" ? "selected" : ""}>
          <input type="radio" name="auctionMode" value="whole" checked={mode === "whole"} onChange={() => setMode("whole")} />
          <b>전량 경매</b>
          <span>한 구매자가 전량을 낙찰받습니다</span>
        </label>
        <label className={mode === "partial" ? "selected" : ""}>
          <input type="radio" name="auctionMode" value="partial" checked={mode === "partial"} onChange={() => setMode("partial")} />
          <b>부분 수량 경매</b>
          <span>여러 구매자가 수량을 나눠 입찰합니다</span>
        </label>
      </div>
      <div className="field-pair">
        <label>
          경매(비딩) 기간
          <select name="auctionDays" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {AUCTION_DAYS.map((d) => (
              <option key={d} value={d}>
                {d}일
              </option>
            ))}
          </select>
          <small>기간의 절반이 지나도 최저 매각가에 못 미치면 알려드려요.</small>
        </label>
        <label>
          최저 매각가 · 하한선 (원, 비공개)
          <input
            required
            name="reservePrice"
            type="number"
            min={price || 1}
            max="100000000"
            placeholder="최소한 이 단가는 받아야 해요"
            value={reserve}
            onChange={(e) => setReserve(e.target.value === "" ? "" : Number(e.target.value))}
          />
          <small>구매자에게는 금액도, 도달 여부도 보이지 않습니다.</small>
        </label>
      </div>
      {mode === "whole" && (
        <label>
          즉시체결가 · 즉시구매가 (원, 공개 · 선택)
          <input name="instantPrice" type="number" min={reserve || price || 1} max="100000000" placeholder="이 단가에 입찰이 들어오면 바로 낙찰" />
          <small>구매자에게 공개됩니다. 이 가격 이상 입찰이 들어오는 순간 경매가 끝나고 낙찰됩니다. 경매 중에도 올리거나(자유) 현재 최고가보다 높게 내릴 수 있어요. 비워 두면 마감까지 경매합니다.</small>
        </label>
      )}
      {mode === "partial" && (
        <label>
          최소 입찰 단위
          <input required name="minLot" type="number" min="1" max={stock || 1000000} placeholder={stock ? `예: ${Math.max(1, Math.round(Number(stock) / 5))}` : "예: 100"} />
          <small>전량 수량은 최소 단위의 배수여야 합니다. 구매자는 이 단위로 수량을 정해 입찰합니다.</small>
        </label>
      )}
      {succession && (
        <label className="check-row consent">
          <input type="checkbox" name="successionEnabled" defaultChecked />
          {successionCopy}
        </label>
      )}
      <p className="inline-notice">
        {mode === "partial"
          ? "마감 시 단가가 높은 순으로 수량을 배정합니다. 최저 매각가 이상 입찰분만 낙찰되며, 남는 수량은 다시 경매할 수 있어요. 낙찰자별로 주문이 따로 생깁니다."
          : policy === "buyer_only"
            ? "마감 시 최고 입찰가가 최저 매각가 이상이면 자동 낙찰됩니다. 못 미치면 최고 입찰자에게 그 가격으로 살지 묻고, 산다고 하면 거래가 진행됩니다. 구매자 입금이 확인되면 서로의 연락처가 공개됩니다."
            : "마감 시 최고 입찰가가 최저 매각가 이상이면 자동 낙찰됩니다. 못 미치면 24시간 안에 최고 입찰가로 판매할지 직접 정하고, 판매하기로 하면 그대로 낙찰됩니다. 구매자 입금이 확인되면 서로의 연락처가 공개됩니다."}
      </p>
    </div>
  );
}
// Live state of one auction from GET /api/auctions/:id/live, polled every 3 s
// while the tab is visible. The server answers 304 when nothing changed.
export type LiveAuction = {
  listingId: string; version: string; serverTime: string; status: Auction["status"]; mode: Auction["mode"];
  currentPrice: number | null; instantPrice: number | null; startPrice: number; bidCount: number; bidderCount: number;
  endsAt: string; extendedCount: number; quantity: number; unit: string; minimumBid: number | null;
  leading: boolean; myTopBid: number | null;
  bids: { id: string; amount: number; quantity: number | null; createdAt: string; alias: string; mine: boolean }[];
  reservePrice?: number; reserveMet?: boolean; decisionStage?: "seller" | null; decisionDueAt?: string | null; closeReason?: string | null;
};
export function useLiveAuction(listingId: string, enabled: boolean, periodMs = 3000) {
  const [live, setLive] = useState<LiveAuction | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, etag = "", timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        try {
          const r = await fetch(`/api/auctions/${listingId}/live`, { cache: "no-store", headers: etag ? { "If-None-Match": etag } : {} });
          const serverTime = r.headers.get("x-server-time");
          if (r.status === 200) {
            etag = r.headers.get("etag") || "";
            const body = (await r.json()) as LiveAuction;
            if (!stopped) {
              setLive(body);
              setOffset(Date.parse(body.serverTime) - Date.now());
            }
          } else if (r.status === 304 && serverTime && !stopped) setOffset(Date.parse(serverTime) - Date.now());
        } catch {}
      }
      if (!stopped) timer = setTimeout(tick, periodMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [listingId, enabled, periodMs]);
  // Once polling stops (the snapshot already shows the auction closed), the last payload is stale.
  return { live: enabled ? live : null, offset };
}
type Fill = { alias: string; unitPrice: number; qty: number; amount: number };
export function AuctionPanel({
  product: p,
  auction: base,
  bids: baseBids,
  data,
  onAction,
  onNotice,
  onRefresh,
}: {
  product: Product;
  auction: Auction;
  bids: Bid[];
  data: MarketData;
  onAction: Action;
  onNotice: (text: string) => void;
  onRefresh?: () => void;
}) {
  const owner = p.ownerId === data.user?.id;
  const privileged = owner || data.isAdmin;
  const partial = base.mode === "partial";
  const { live, offset } = useLiveAuction(p.id, base.status === "active" || base.status === "deciding");
  // Live fields override the (slower) market snapshot; allocation details for
  // partial auctions come from the snapshot, which is refreshed when bids change.
  const a: Auction = live && live.listingId === p.id
    ? {
      ...base,
      status: live.status,
      currentPrice: live.currentPrice,
      instantPrice: live.instantPrice,
      bidCount: live.bidCount,
      bidderCount: live.bidderCount,
      endsAt: live.endsAt,
      extendedCount: live.extendedCount,
      leading: live.leading,
      myTopBid: live.myTopBid,
      minimumBid: partial ? base.minimumBid : live.minimumBid ?? base.minimumBid,
      ...(live.reservePrice !== undefined
        ? { reservePrice: live.reservePrice, reserveMet: live.reserveMet, decisionStage: live.decisionStage, decisionDueAt: live.decisionDueAt, closeReason: live.closeReason }
        : {}),
    }
    : base;
  const liveKey = live ? `${live.status}:${live.bidCount}:${live.instantPrice}` : "";
  const baseKey = `${base.status}:${base.bidCount}:${base.instantPrice}`;
  useEffect(() => {
    // Someone else bid, or the auction closed: reload the full snapshot once.
    if (liveKey && liveKey !== baseKey) onRefresh?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);
  const now = useNow(a.status === "active", 1000, offset);
  const open = a.status === "active" && Date.parse(a.endsAt) > now.getTime();
  const min = a.minimumBid ?? a.startPrice;
  const instant = !partial ? a.instantPrice : null;
  const [amount, setAmount] = useState(min),
    [lastMin, setLastMin] = useState(min),
    [qty, setQty] = useState(a.myBid?.quantity ?? a.minLot),
    [reserve, setReserve] = useState(a.reservePrice ?? 0),
    [instantDraft, setInstantDraft] = useState<number | "">(a.instantPrice ?? ""),
    [floor, setFloor] = useState(0),
    [preview, setPreview] = useState<{ fills: Fill[]; total: number; remaining: number } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [raise, setRaise] = useState(false),
    [confirm, setConfirm] = useState<"accept" | "bid" | "buynow" | "sell" | "nosell" | null>(null),
    [buyNowAt, setBuyNowAt] = useState<number | null>(null),
    [flashKey, setFlashKey] = useState(0),
    [lastPrice, setLastPrice] = useState(a.currentPrice);
  if (lastMin !== min) {
    // A newer top bid arrived while the panel was open: follow the new minimum.
    setLastMin(min);
    if (amount < min) setAmount(min);
  }
  if (lastPrice !== a.currentPrice) {
    setLastPrice(a.currentPrice);
    setFlashKey((k) => k + 1);
  }
  async function run(action: Record<string, unknown>, done?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
      setConfirm(null);
      setPreview(null);
      setRaise(false);
      if (done) onNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function loadPreview() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = (await api({ action: "preview_close", productId: p.id, floor })) as unknown as { fills: Fill[]; total: number; remaining: number };
      setPreview(r);
      setConfirm("accept");
    } catch (e) {
      setError(e instanceof Error ? e.message : "미리보기를 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const headline = partial ? (a.cutoffPrice ?? a.startPrice) : (a.currentPrice ?? a.startPrice);
  const total = partial ? a.filledQuantity * headline : headline * a.quantity;
  const feePct = Math.round(feeRateFor(data.settings, p.category) * 1000) / 10;
  const penaltyPct = Math.round(data.settings.penaltyRate * 100);
  const bidTotal = amount * (partial ? qty : a.quantity);
  const hitsInstant = !partial && instant !== null && amount >= instant;
  const blocked = data.penalty.due > 0;
  const liveBids = live && !partial ? live.bids : null;
  const commitCopy = data.settings.penalizeNonpayment
    ? `낙찰되면 ${PAYMENT_HOURS}시간 안에 입금해야 하며 입찰은 취소할 수 없습니다. 입금하지 않거나 단순 변심으로 취소하면 낙찰가의 ${penaltyPct}% 위약금이 부과됩니다.`
    : `낙찰되면 ${PAYMENT_HOURS}시간 안에 입금해야 하며 입찰은 취소할 수 없습니다. 기한 안에 입금하지 않으면 거래가 자동 취소되고, 입금 후 단순 변심으로 취소하면 낙찰가의 ${penaltyPct}% 위약금이 부과될 수 있습니다.`;
  return (
    <div className="auction-panel">
      <div className="auction-head">
        <span className={`status auction-${a.status}`}>
          <Gavel size={13} />
          {a.status === "active" ? "경매중" : auctionStatusLabels[a.status]}
        </span>
        {partial ? (
          <span className="status partial-pill"><Users size={13} />부분 수량 · 최소 {won(a.minLot)}{a.unit}</span>
        ) : (
          <span className="status partial-pill">전량 {won(a.quantity)}{a.unit}</span>
        )}
        {a.status === "active" && <Countdown endsAt={a.endsAt} offsetMs={offset} />}
        {a.extendedCount > 0 && a.status === "active" && <small>마감 직전 입찰로 {a.extendedCount}회 연장</small>}
        {live && a.status === "active" && <small className="live-dot">실시간</small>}
      </div>
      {partial ? (
        <div className="auction-stats">
          <div>
            <span>{a.cutoffPrice === null ? "시작가" : "현재 낙찰 하한가"}</span>
            <b>
              {won(headline)}
              <small>원 / {a.unit}</small>
            </b>
          </div>
          <div>
            <span>신청 수량</span>
            <b>
              {won(a.subscribedQuantity)}
              <small>/ {won(a.quantity)}{a.unit}</small>
            </b>
          </div>
          <div>
            <span>{a.remainingQuantity > 0 ? "아직 남은 수량" : "배정 예정 총액"}</span>
            <b>
              {a.remainingQuantity > 0 ? won(a.remainingQuantity) : won(total)}
              <small>{a.remainingQuantity > 0 ? a.unit : "원"}</small>
            </b>
          </div>
          <div>
            <span>{privileged && a.sellableQuantity !== undefined ? "최저가 이상 낙찰 예정" : "입찰"}</span>
            <b>
              {privileged && a.sellableQuantity !== undefined ? won(a.sellableQuantity) : a.bidCount}
              <small>{privileged && a.sellableQuantity !== undefined ? `/ ${won(a.quantity)}${a.unit}` : "건"}</small>
            </b>
          </div>
        </div>
      ) : (
        <div className={`live-board ${instant === null ? "single" : ""}`}>
          <div className="live-price">
            <span>{a.currentPrice === null ? "시작가" : "현재 최고 입찰가"}</span>
            <b key={flashKey} className={flashKey > 0 ? "flash" : ""}>
              {won(headline)}
              <small>원 / {a.unit}</small>
            </b>
            <em>
              입찰자 {a.bidderCount}명 · 입찰 {a.bidCount}건 · 총 {won(total)}원
            </em>
          </div>
          {instant !== null && (
            <div className="instant-box">
              <span><Zap size={14} />즉시구매가</span>
              <b>
                {won(instant)}
                <small>원 / {a.unit}</small>
              </b>
              <em>총 {won(instant * a.quantity)}원 · 이 가격에 입찰하면 바로 낙찰</em>
              {!owner && open && data.user && !blocked && (
                <Button className="primary" type="button" disabled={busy} onClick={() => { setBuyNowAt(instant); setConfirm("buynow"); }}>
                  즉시구매
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {!owner && confirm === "buynow" && buyNowAt !== null && (
        <div className="confirm-box">
          <p>
            즉시구매가 <b>{won(buyNowAt)}원 × {won(a.quantity)}{a.unit} = {won(buyNowAt * a.quantity)}원</b>으로 지금 바로 낙찰됩니다. {commitCopy}
          </p>
          {instant !== buyNowAt && (
            <p className="inline-notice warn">
              {instant === null ? "판매자가 즉시구매가를 없앴습니다." : `판매자가 즉시구매가를 ${won(instant)}원으로 바꿨습니다.`} 돌아가서 새 가격을 확인해 주세요.
            </p>
          )}
          <div className="form-actions">
            <Button variant="outline" type="button" onClick={() => setConfirm(null)}>돌아가기</Button>
            <Button className="primary" disabled={busy || instant !== buyNowAt} onClick={() => run({ action: "bid", productId: p.id, buyNow: true, amount: buyNowAt }, "즉시구매로 낙찰되었습니다. 주문 탭에서 입금 안내를 확인하세요.")}>
              {busy ? "처리 중…" : "즉시구매 확정"}
            </Button>
          </div>
        </div>
      )}
      {privileged && a.reserveMet !== undefined && (
        <div className={`reserve-line ${a.reserveMet ? "met" : ""}`}>
          <ShieldCheck size={15} />
          {a.status !== "active"
            ? a.reserveMet ? "최저 매각가 이상으로 마감" : "최저 매각가 미달로 마감"
            : a.reserveMet
              ? partial ? "최저 매각가 이상 입찰 있음 · 마감 시 해당 수량 자동 낙찰" : "최저 매각가 도달 · 마감 시 자동 낙찰"
              : partial ? "최저 매각가 미달 · 마감 시 유찰될 수 있음"
                : data.settings.belowReservePolicy === "buyer_only"
                  ? "최저 매각가 미달 · 마감 시 최고 입찰자에게 그 가격으로 살지 묻습니다"
                  : "최저 매각가 미달 · 마감 시 판매 여부를 직접 정합니다"}
          {a.reservePrice !== undefined && <b>{owner ? "내" : "공급자"} 최저 매각가 {won(a.reservePrice)}원 · 구매자 비공개</b>}
        </div>
      )}
      {owner && a.status === "active" && a.midpointAlertedAt && (partial ? (a.sellableQuantity ?? 0) < a.quantity : !a.reserveMet) && (
        <div className="reserve-alert">
          <TrendingDown size={18} />
          <div>
            <b>경매 기간의 절반이 지났어요</b>
            <p>
              {partial
                ? a.subscribedQuantity === 0
                  ? "아직 입찰이 없습니다. 최저 매각가를 낮추면 낙찰 가능성이 높아집니다."
                  : a.subscribedQuantity < a.quantity
                    ? `신청 수량 ${won(a.subscribedQuantity)}/${won(a.quantity)}${a.unit}, 최저가 이상 낙찰 예정은 ${won(a.sellableQuantity ?? 0)}${a.unit}입니다. 최저가를 낮추거나 마감을 기다려 주세요.`
                    : `최저 매각가를 ${won(a.fillPrice ?? 0)}원 이하로 낮추면 현재 입찰로 전량 낙찰됩니다.`
                : a.currentPrice === null
                  ? "아직 입찰이 없습니다. 최저 매각가를 낮추면 낙찰 가능성이 높아집니다."
                  : `최고 입찰가 ${won(a.currentPrice)}원이 최저 매각가보다 낮습니다. 최저 매각가를 ${won(a.currentPrice)}원 이하로 낮추면 지금 입찰로 낙찰됩니다.`}
            </p>
          </div>
        </div>
      )}
      {owner && a.status === "deciding" && a.decisionStage === "seller" && (
        <div className="decision-box">
          <AlertTriangle size={20} />
          <div>
            <b>판매 결정이 필요해요 · {formatDateTime(a.decisionDueAt)}까지</b>
            <p>
              경매가 끝났지만 최고 입찰가 <b>{won(a.currentPrice ?? 0)}원</b>(총 {won((a.currentPrice ?? 0) * a.quantity)}원)이 최저 매각가 {won(a.reservePrice ?? 0)}원에 못 미쳤습니다.
              판매하기로 하면 이 가격으로 바로 낙찰되고 구매자에게 {PAYMENT_HOURS}시간 입금 안내가 갑니다. 정하지 않으면 유찰됩니다.
            </p>
            {confirm === "sell" || confirm === "nosell" ? (
              <div className="form-actions order-actions">
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>돌아가기</Button>
                <Button className="primary" disabled={busy}
                  onClick={() => run({ action: "decide_below_reserve", productId: p.id, accept: confirm === "sell" },
                    confirm === "sell" ? "판매를 확정했습니다. 구매자 입금을 기다립니다." : "유찰 처리했습니다. 조건을 바꿔 다시 경매할 수 있어요.")}>
                  {confirm === "sell" ? `${won(a.currentPrice ?? 0)}원에 판매 확정` : "유찰 확정"}
                </Button>
              </div>
            ) : (
              <div className="form-actions order-actions">
                <Button variant="outline" disabled={busy} onClick={() => setConfirm("nosell")}>판매하지 않음</Button>
                <Button className="primary" disabled={busy} onClick={() => setConfirm("sell")}>이 가격에 판매</Button>
              </div>
            )}
          </div>
        </div>
      )}
      {!owner && a.status === "deciding" && (
        <p className="inline-notice">
          {a.leading
            ? `경매가 끝났습니다. 판매자가 ${DECISION_HOURS}시간 안에 회원님의 입찰가로 판매할지 정합니다. 판매하기로 하면 바로 낙찰되어 입금 안내를 드려요.`
            : "경매가 종료되었습니다."}
        </p>
      )}
      {owner && a.status === "active" && (
        <div className="owner-controls">
          {!partial && (
            <form
              className="counter-field"
              onSubmit={(e) => {
                e.preventDefault();
                void run({ action: "set_instant_price", productId: p.id, instantPrice: instantDraft === "" ? null : instantDraft },
                  instantDraft === "" ? "즉시체결가를 없앴습니다." : "즉시체결가를 바꿨습니다.");
              }}
            >
              <label>
                즉시체결가 조정 (원 · 지금 {a.instantPrice ? `${won(a.instantPrice)}원` : "없음"})
                <input type="number" min={Math.max(a.reservePrice ?? 1, (a.currentPrice ?? 0) + 1)} max="100000000" value={instantDraft}
                  placeholder="비우면 즉시체결 없음" onChange={(e) => setInstantDraft(e.target.value === "" ? "" : Number(e.target.value))} />
                <small>
                  올리기는 언제든 됩니다. 내릴 때는 {a.currentPrice !== null ? `현재 최고가 ${won(a.currentPrice)}원보다 높게, ` : ""}최저 매각가 {won(a.reservePrice ?? 0)}원 이상으로만 정할 수 있어요.
                </small>
              </label>
              <Button variant="outline" disabled={busy || instantDraft === (a.instantPrice ?? "")}>
                적용
              </Button>
            </form>
          )}
          <form
            className="counter-field"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ action: "lower_reserve", productId: p.id, reservePrice: reserve }, "최저 매각가를 낮췄습니다.");
            }}
          >
            <label>
              최저 매각가 낮추기 (원)
              <input type="number" min="1" max={Math.max(1, (a.reservePrice ?? 1) - 1)} value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
            </label>
            <Button variant="outline" disabled={busy || !a.reservePrice || reserve >= a.reservePrice || reserve < 1}>
              낮추기
            </Button>
          </form>
          {partial ? (
            a.subscribedQuantity > 0 && (
              confirm === "accept" && preview ? (
                <div className="confirm-box">
                  <p>
                    <b>{floor > 0 ? `${won(floor)}원 이상 입찰만` : "최저 매각가와 무관하게 모든 입찰을"}</b> 단가 높은 순으로 지금 낙찰합니다. 낙찰 후에는 되돌릴 수 없습니다.
                  </p>
                  <table className="preview-table">
                    <thead><tr><th>구매자</th><th>단가</th><th>수량</th><th>소계</th></tr></thead>
                    <tbody>
                      {preview.fills.map((f, i) => (
                        <tr key={i}><td>{f.alias}</td><td>{won(f.unitPrice)}원</td><td>{won(f.qty)}{a.unit}</td><td>{won(f.amount)}원</td></tr>
                      ))}
                      <tr className="total"><td colSpan={3}>합계 {preview.fills.length}명</td><td>{won(preview.total)}원</td></tr>
                    </tbody>
                  </table>
                  {preview.remaining > 0 && <p>미낙찰 잔여 {won(preview.remaining)}{a.unit}는 다시 경매할 수 있어요.</p>}
                  <div className="form-actions">
                    <Button variant="outline" type="button" onClick={() => { setConfirm(null); setPreview(null); }}>돌아가기</Button>
                    <Button className="primary" disabled={busy || preview.fills.length === 0} onClick={() => run({ action: "accept_bid", productId: p.id, floor }, "현재 입찰로 낙찰했습니다. 주문 탭에서 확인하세요.")}>
                      {busy ? "처리 중…" : "낙찰 확정"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="counter-field">
                  <label>
                    지금 낙찰할 최저 단가 (원, 0 = 전체)
                    <input type="number" min="0" max="100000000" value={floor} onChange={(e) => setFloor(Number(e.target.value))} />
                  </label>
                  <Button className="primary" type="button" disabled={busy} onClick={loadPreview}>
                    낙찰 미리보기 <ArrowRight size={16} />
                  </Button>
                </div>
              )
            )
          ) : a.currentPrice !== null && (
            confirm === "accept" ? (
              <div className="confirm-box">
                <p>
                  현재 최고가 <b>{won(a.currentPrice)}원 × {won(a.quantity)}{a.unit} = {won(total)}원</b>에 지금 낙찰합니다. 낙찰 후에는 되돌릴 수 없습니다.
                </p>
                <div className="form-actions">
                  <Button variant="outline" type="button" onClick={() => setConfirm(null)}>돌아가기</Button>
                  <Button className="primary" disabled={busy} onClick={() => run({ action: "accept_bid", productId: p.id }, "현재 최고가로 낙찰했습니다. 주문 탭에서 확인하세요.")}>
                    {busy ? "처리 중…" : "낙찰 확정"}
                  </Button>
                </div>
              </div>
            ) : (
              <Button className="primary" type="button" disabled={busy} onClick={() => setConfirm("accept")}>
                현재 최고가로 지금 낙찰 <ArrowRight size={16} />
              </Button>
            )
          )}
          <p className="inline-notice">
            입찰이 있으면 경매를 중단할 수 없습니다. 낙찰 후 수수료 {feePct}%(판매자 부담)를 제외한 금액이 정산됩니다.
            {a.successionEnabled ? " 낙찰자가 미입금하면 차순위 입찰자에게 자동 제안됩니다." : ""}
          </p>
        </div>
      )}
      {!owner && open && blocked && (
        <p className="inline-notice warn">
          <AlertTriangle size={16} />
          미납 위약금 {won(data.penalty.due)}원이 있어 입찰할 수 없습니다. 거래 관리에서 내역을 확인해 주세요.{data.penalty.viaBusiness ? " 같은 사업자등록번호 계정의 위약금이 포함되어 있습니다." : ""}
        </p>
      )}
      {!owner && open && !blocked && (
        <form
          className="bid-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!data.user) {
              setError("로그인 후 입찰할 수 있습니다.");
              return;
            }
            if (confirm !== "bid") {
              setBuyNowAt(hitsInstant ? instant : null);
              setConfirm("bid");
              return;
            }
            if (hitsInstant && instant !== buyNowAt) {
              setConfirm(null);
              setError("판매자가 방금 즉시구매가를 바꿨습니다. 새 가격을 확인해 주세요.");
              return;
            }
            void run(
              partial
                ? { action: "bid", productId: p.id, unitPrice: amount, quantity: qty }
                : hitsInstant
                  ? { action: "bid", productId: p.id, buyNow: true, amount: buyNowAt }
                  : { action: "bid", productId: p.id, amount },
              hitsInstant ? "즉시구매가 이상으로 입찰해 바로 낙찰되었습니다. 주문 탭에서 입금 안내를 확인하세요." : "입찰했습니다. 더 높은 입찰이 들어오면 알려드릴게요.",
            );
          }}
        >
          {partial && a.myBid && !raise ? (
            <div className={`my-bid ${a.myBid.state}`}>
              <div>
                <b>내 입찰 {won(a.myBid.unitPrice)}원 × {won(a.myBid.quantity)}{a.unit}</b>
                <p>
                  {a.myBid.state === "full" && `전량 ${won(a.myBid.quantity)}${a.unit} 낙찰 예정`}
                  {a.myBid.state === "partial" && `${won(a.myBid.allocated)}/${won(a.myBid.quantity)}${a.unit} 일부만 낙찰 예정`}
                  {a.myBid.state === "out" && "현재 낙찰권 밖 · 단가를 올리면 다시 배정됩니다"}
                </p>
              </div>
              <Button variant="outline" type="button" onClick={() => { setRaise(true); setAmount(Math.max(min, a.myBid!.unitPrice)); setQty(a.myBid!.quantity); }}>
                입찰 올리기
              </Button>
            </div>
          ) : !partial && a.leading ? (
            <p className="inline-notice leading">
              <CheckCircle2 size={16} />
              내가 현재 최고 입찰자입니다 ({won(a.myTopBid ?? a.currentPrice ?? 0)}원). 다른 입찰이 들어오면 알려드려요.
              {instant !== null ? " 지금 끝내려면 위의 즉시구매를 누르세요." : ""}
            </p>
          ) : (
            <>
              {partial && (
                <label className="qty-field">
                  수량 ({a.unit}) · {won(a.minLot)} 단위
                  <input
                    type="number"
                    min={a.myBid?.quantity ?? a.minLot}
                    step={a.minLot}
                    max={a.quantity}
                    value={qty}
                    onChange={(e) => {
                      setConfirm(null);
                      setQty(Number(e.target.value));
                    }}
                  />
                </label>
              )}
              <div className="counter-field">
                <label>
                  입찰 단가 (원 / {a.unit})
                  <input
                    type="number"
                    min={Math.max(min, a.myBid?.unitPrice ?? 0)}
                    step={partial ? bidStep(headline) : 1}
                    max="100000000"
                    value={amount}
                    onChange={(e) => {
                      setConfirm(null);
                      setAmount(Number(e.target.value));
                    }}
                  />
                  <small>
                    최소 {won(min)}원 · 총액 {won(hitsInstant ? instant! * a.quantity : bidTotal)}원
                    {!partial && a.myTopBid ? ` · 내 최고 입찰 ${won(a.myTopBid)}원` : ""}
                    {partial && a.myBid ? " · 수정하면 시간 순위가 새로 매겨집니다" : ""}
                  </small>
                </label>
                <Button className="primary" disabled={busy || !Number.isInteger(amount) || amount < min || (partial && (qty < a.minLot || qty % a.minLot !== 0 || qty > a.quantity))}>
                  {busy ? "입찰 중…" : confirm === "bid" ? (hitsInstant ? "즉시구매로 확정" : "이 금액으로 확정") : "입찰하기"}
                  <Gavel size={16} />
                </Button>
              </div>
              {!partial && (
                <div className="quick-bids">
                  {[1, 3, 5].map((k) => {
                    let v = a.currentPrice === null ? a.startPrice : a.currentPrice;
                    for (let i = 0; i < k; i++) v += bidStep(v);
                    if (a.currentPrice === null && k === 1) v = a.startPrice;
                    if (instant !== null) v = Math.min(v, instant);
                    return (
                      <button type="button" key={k} onClick={() => { setConfirm(null); setAmount(v); }}>
                        {a.currentPrice === null && k === 1 ? "시작가" : `+${k}호가`} {won(v)}
                      </button>
                    );
                  })}
                </div>
              )}
              {confirm === "bid" && (
                <p className="inline-notice">
                  {hitsInstant
                    ? <>즉시구매가 {won(instant!)}원 이상이라 <b>{won(instant!)}원 × {won(a.quantity)}{a.unit} = {won(instant! * a.quantity)}원</b>으로 바로 낙찰됩니다. </>
                    : <>{won(amount)}원 × {won(partial ? qty : a.quantity)}{a.unit} = <b>{won(bidTotal)}원</b>에 입찰합니다. </>}
                  {commitCopy}
                  {partial ? ` 재고가 부족하면 ${won(a.minLot)}${a.unit} 단위로 일부만 낙찰될 수 있습니다.` : ""}
                  {a.successionEnabled ? ` 낙찰자가 미입금하면 마감 후 ${SUCCESSION_WINDOW_DAYS}일 이내 차순위 제안을 받을 수 있습니다 (${OFFER_HOURS}시간 내 수락).` : ""}
                </p>
              )}
              {partial && a.myBid && raise && (
                <button type="button" className="text-button" onClick={() => setRaise(false)}>취소</button>
              )}
            </>
          )}
        </form>
      )}
      {!owner && a.status === "active" && !open && <p className="inline-notice">경매가 종료되어 결과를 정리하고 있습니다. 잠시만 기다려 주세요.</p>}
      {a.status !== "active" && a.status !== "deciding" && (
        <p className="inline-notice">
          {a.status === "won" && (partial
            ? `${won(a.soldQuantity)}/${won(a.quantity)}${a.unit} 낙찰되었습니다. 주문 탭에서 입금과 인수 절차를 확인하세요.`
            : owner && a.closeReason === "below_reserve_offer"
              ? "최고 입찰자에게 이 가격으로 구매할지 묻고 있습니다. 수락하면 입금 절차가 시작되고, 거절하거나 24시간 안에 답이 없으면 유찰됩니다. 진행 상황은 주문 탭에서 확인하세요."
              : "낙찰되었습니다. 주문 탭에서 입금과 인수 절차를 확인하세요.")}
          {a.status === "unsold" && "유찰되었습니다. 공급자는 조건을 바꿔 다시 등록할 수 있습니다."}
          {a.status === "cancelled" && "경매가 중단되었습니다."}
          {a.unsoldQuantity > 0 && a.status === "won" && ` 미낙찰 ${won(a.unsoldQuantity)}${a.unit}는 다시 경매할 수 있어요.`}
        </p>
      )}
      <ErrorText error={error} />
      <div className="bid-history">
        <h3>
          입찰 기록 {(liveBids ?? baseBids).length > 0 && <span>{a.bidCount}</span>}
          {liveBids && <small>최신순 · 3초마다 갱신</small>}
        </h3>
        {liveBids ? (
          liveBids.length === 0 ? (
            <p className="bid-empty">아직 입찰이 없습니다. 첫 입찰은 시작가 {won(a.startPrice)}원부터입니다.</p>
          ) : (
            <ol className="bid-list">
              {liveBids.map((b, i) => (
                <li key={b.id} className={`${b.mine ? "mine" : ""} ${i === 0 ? "top" : ""}`}>
                  <span>{b.alias}</span>
                  <b>{won(b.amount)}원</b>
                  <time>{formatDateTime(b.createdAt)}</time>
                </li>
              ))}
            </ol>
          )
        ) : baseBids.length === 0 ? (
          <p className="bid-empty">아직 입찰이 없습니다. 첫 입찰은 시작가 {won(a.startPrice)}원부터입니다.</p>
        ) : (
          <ol className="bid-list">
            {baseBids.slice(0, 30).map((b, i) => (
              <li key={b.id} className={`${b.mine ? "mine" : ""} ${i === 0 ? "top" : ""}`}>
                <span>{b.mine ? "나" : b.alias}</span>
                <b>
                  {won(b.amount)}원{b.quantity !== null ? ` × ${won(b.quantity)}${a.unit}` : ""}
                </b>
                {b.quantity !== null && (
                  <em className={`alloc ${b.allocated && b.allocated >= b.quantity ? "full" : b.allocated ? "partial" : "out"}`}>
                    {a.status === "active"
                      ? b.allocated && b.allocated >= b.quantity ? "낙찰 예정" : b.allocated ? `${won(b.allocated)} 일부` : "대기"
                      : b.status === "won" ? "낙찰" : b.status === "partial" ? `${won(b.allocated ?? 0)} 일부 낙찰` : b.status === "lost" ? "유찰" : b.status}
                  </em>
                )}
                <time>{formatDateTime(b.createdAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
export function RelistForm({
  product: p,
  remainder,
  onAction,
  onDone,
  succession: successionOn = false,
}: {
  succession?: boolean;
  product: Product;
  /** When set, only the unsold remainder of a sold lot is relisted. */
  remainder?: number;
  onAction: Action;
  onDone: () => void;
}) {
  const stock = remainder ?? p.stock;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [days, setDays] = useState(7),
    [mode, setMode] = useState<"whole" | "partial">(p.auction?.mode === "partial" ? "partial" : "whole"),
    [minLot, setMinLot] = useState(p.auction?.mode === "partial" ? Math.min(p.auction.minLot, stock) : Math.max(1, Math.round(stock / 5))),
    [succession, setSuccession] = useState(successionOn && (p.auction?.successionEnabled ?? true)),
    [start, setStart] = useState(p.price),
    [reserve, setReserve] = useState(Math.max(p.price, p.auction?.cutoffPrice ?? p.auction?.currentPrice ?? p.price)),
    [instant, setInstant] = useState<number | "">("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction({
        action: remainder ? "relist_remainder" : "relist_auction",
        productId: p.id, auctionDays: days, price: start, reservePrice: reserve,
        auctionMode: mode, minLot: mode === "partial" ? minLot : undefined, successionEnabled: succession,
        instantPrice: mode === "whole" && instant !== "" ? instant : null,
        expected: remainder,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "다시 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const divisible = mode !== "partial" || (minLot >= 1 && minLot <= stock && stock % minLot === 0);
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="conversation-product">
        <img src={p.image} alt="" />
        <div>
          <b>{p.title}</b>
          <p>
            {won(stock)}
            {p.unit} {remainder ? "미낙찰 잔여" : "전량"} · 정상가 {won(p.originalPrice)}원
          </p>
        </div>
        <span className={`status ${remainder ? "auction-won" : "unsold"}`}>{remainder ? "잔여 재경매" : "유찰"}</span>
      </div>
      {p.auction?.currentPrice != null && !remainder && (
        <p className="inline-notice">
          지난 경매 최고 입찰가는 {won(p.auction.currentPrice)}원이었습니다. 최저 매각가를 그 이하로 두면 낙찰 가능성이 높아집니다.
        </p>
      )}
      <div className="mode-toggle" role="radiogroup" aria-label="경매 방식">
        <label className={mode === "whole" ? "selected" : ""}>
          <input type="radio" checked={mode === "whole"} onChange={() => setMode("whole")} />
          <b>전량 경매</b>
          <span>한 구매자가 {won(stock)}{p.unit} 전량</span>
        </label>
        <label className={mode === "partial" ? "selected" : ""}>
          <input type="radio" checked={mode === "partial"} onChange={() => setMode("partial")} />
          <b>부분 수량 경매</b>
          <span>여러 구매자가 나눠 입찰</span>
        </label>
      </div>
      <div className="field-triple">
        <label>
          경매 기간
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {AUCTION_DAYS.map((d) => (
              <option key={d} value={d}>
                {d}일
              </option>
            ))}
          </select>
        </label>
        <label>
          시작가 (원)
          <input type="number" min="1" max={p.originalPrice} value={start} onChange={(e) => setStart(Number(e.target.value))} />
        </label>
        <label>
          최저 매각가 (원)
          <input type="number" min={start} max={p.originalPrice} value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
        </label>
      </div>
      {mode === "whole" && (
        <label>
          즉시체결가 (원, 공개 · 선택)
          <input type="number" min={reserve} max={p.originalPrice} value={instant} placeholder="비우면 마감까지 경매" onChange={(e) => setInstant(e.target.value === "" ? "" : Number(e.target.value))} />
          <small>이 가격 이상 입찰이 들어오면 바로 낙찰됩니다. 최저 매각가 이상이어야 합니다.</small>
        </label>
      )}
      {mode === "partial" && (
        <label>
          최소 입찰 단위 ({p.unit})
          <input type="number" min="1" max={stock} value={minLot} onChange={(e) => setMinLot(Number(e.target.value))} />
          <small>{divisible ? `${won(stock)}${p.unit}를 ${won(minLot)}${p.unit} 단위로 나눠 입찰받습니다.` : "전량 수량은 최소 단위의 배수여야 합니다."}</small>
        </label>
      )}
      {successionOn && (
        <label className="check-row consent">
          <input type="checkbox" checked={succession} onChange={(e) => setSuccession(e.target.checked)} />
          {successionCopy}
        </label>
      )}
      <ErrorText error={error} />
      <Button className="primary full-button" disabled={busy || reserve < start || start < 1 || !divisible || (instant !== "" && instant < reserve)}>
        {busy ? "등록 중…" : remainder ? `잔여 ${won(stock)}${p.unit} 다시 경매 시작` : "같은 재고로 다시 경매 시작"}
        <RotateCcw size={16} />
      </Button>
    </form>
  );
}
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {}
      }}
      aria-label="복사"
    >
      {done ? <CheckCircle2 size={14} /> : <Copy size={14} />}
      {done ? "복사됨" : "복사"}
    </button>
  );
}
export function OrderView({
  order: o,
  data,
  onAction,
  onNotice,
}: {
  order: Order;
  data: MarketData;
  onAction: Action;
  onNotice: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [depositor, setDepositor] = useState(data.profile?.company || ""),
    [reason, setReason] = useState(""),
    [confirmDecline, setConfirmDecline] = useState(false),
    [shipPhotos, setShipPhotos] = useState<string[]>([]);
  const current = data.orders.find((v) => v.id === o.id) || data.adminOrders.find((v) => v.id === o.id) || o;
  const dispute = data.disputes.find((d) => d.orderId === current.id && d.status === "open") ?? null;
  const pastDisputes = data.disputes.filter((d) => d.orderId === current.id && d.status === "resolved" && d.kind !== "no_payment");
  const belowReserve = current.offerKind === "below_reserve";
  const buyer = current.buyerId === data.user?.id,
    seller = current.sellerId === data.user?.id,
    admin = data.isAdmin;
  const now = useNow(["awaiting_payment", "offered"].includes(current.status), 30000);
  async function run(action: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
      onNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const cancelled = current.status === "cancelled";
  const succession = current.successionRound > 0;
  const steps: { label: string; done: boolean }[] = [
    ...(succession || belowReserve ? [{ label: belowReserve ? "구매 의사 확인" : "제안 수락", done: current.status !== "offered" }] : [{ label: "낙찰", done: true }]),
    { label: "입금 확인", done: !!current.paidAt },
    { label: "연락처 공개", done: !!current.paidAt },
    { label: "인수 완료", done: !!current.completedAt },
    { label: "정산", done: !!current.settledAt },
  ];
  const codeHint = current.depositCode ? `${current.depositCode}${(data.profile?.company || "상호").replace(/\s/g, "").slice(0, 2)}` : "";
  return (
    <div className="order-view">
      <div className="conversation-product">
        <img src={current.image} alt="" />
        <div>
          <b>{current.productTitle}</b>
          <p>
            {won(current.quantity)}
            {current.unit} × {won(current.unitPrice)}원 · {buyer ? `공급자 ${current.sellerAlias}` : `구매자 ${current.buyerAlias}`}
          </p>
        </div>
        <span className={`status order-${current.status}`}>{orderStatusLabel(current)}</span>
      </div>
      <div className="order-badges">
        {succession && <span className="status auction-active"><Users size={12} />차순위 승계 {current.successionRound}차</span>}
        {current.bidQuantity && current.quantity < current.bidQuantity && (
          <span className="status order-payment_reported">부분 낙찰 {won(current.quantity)}/{won(current.bidQuantity)}{current.unit}</span>
        )}
        {current.paidBy === "webhook" && <span className="status auction-won">자동 입금 확인</span>}
        {belowReserve && <span className="status order-payment_reported">하한선 미달 · 구매 의사 확인</span>}
        {dispute && <span className="status order-cancelled"><AlertTriangle size={12} />신고 처리 중</span>}
        {current.refundAmount > 0 && <span className="status order-payment_reported">환불 {won(current.refundAmount)}원 {current.refundAmount > current.refundPaid ? "예정" : "완료"}</span>}
      </div>
      {!cancelled && (
        <ol className="order-steps">
          {steps.map((s, i) => {
            const active = !s.done && (i === 0 || steps[i - 1].done);
            return (
              <li key={s.label} className={s.done ? "done" : active ? "active" : ""}>
                <i>{s.done ? <CheckCircle2 size={14} /> : i + 1}</i>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}
      <div className="offer-summary order-summary">
        <div>
          <span>낙찰 총액</span>
          <b>{won(current.amount)}원</b>
        </div>
        {(seller || admin) && (
          <>
            <div>
              <span>수수료 {current.feeRate / 100}%</span>
              <b>-{won(current.fee)}원</b>
            </div>
            <div>
              <span>공급자 정산액</span>
              <b>{won(current.net)}원</b>
            </div>
          </>
        )}
      </div>
      {cancelled && (
        <p className="inline-notice">
          취소된 주문입니다.{" "}
          {current.cancelReason === "payment_overdue" ? `입금 기한 초과${buyer && data.settings.penalizeNonpayment ? ` · 위약금 ${Math.round(data.settings.penaltyRate * 100)}%가 부과됩니다` : ""}`
            : current.cancelReason === "offer_expired" ? (belowReserve ? "구매 의사 확인 기한 만료 · 유찰" : "차순위 제안 기한 만료")
              : current.cancelReason === "offer_declined" ? (belowReserve ? "구매하지 않음 · 유찰" : "차순위 제안 거절")
                : current.cancelReason === "dispute" ? `분쟁 조정으로 취소${current.refundAmount ? ` · 환불 ${won(current.refundAmount)}원 ${current.refundAmount > current.refundPaid ? "예정" : "완료"}` : ""}`
                  : current.cancelReason || ""}
        </p>
      )}
      {current.status === "offered" && (
        <div className={`payment-box ${buyer ? "" : "muted"}`}>
          <Users size={20} />
          <div>
            <b>
              {belowReserve
                ? buyer ? "회원님이 제시한 가격으로 구매하시겠습니까?" : "최고 입찰자에게 구매 의사를 묻는 중"
                : buyer ? "차순위 낙찰 제안이 도착했어요" : "차순위 입찰자에게 제안 중"} · {formatDateTime(current.offerExpiresAt)}까지
            </b>
            <p>
              {belowReserve
                ? buyer
                  ? `경매는 판매 조건에 못 미쳐 끝났지만 회원님이 제시한 ${won(current.unitPrice)}원 × ${won(current.quantity)}${current.unit} = ${won(current.amount)}원으로 구매할 수 있습니다. 구매하면 ${PAYMENT_HOURS}시간 입금 기한이 시작되고, 구매하지 않으면 유찰로 끝납니다. ${remainingLabel(current.offerExpiresAt ?? current.paymentDueAt, now)}.`
                  : `구매하지 않거나 기한이 지나면 유찰됩니다. ${remainingLabel(current.offerExpiresAt ?? current.paymentDueAt, now)}.`
                : buyer
                  ? `앞선 낙찰자가 입금하지 않아 내 입찰가 ${won(current.unitPrice)}원 × ${won(current.quantity)}${current.unit} = ${won(current.amount)}원으로 낙찰받을 수 있습니다. 수락하면 ${PAYMENT_HOURS}시간 입금 기한이 시작됩니다. ${remainingLabel(current.offerExpiresAt ?? current.paymentDueAt, now)}.`
                  : `수락하지 않으면 다음 후보에게 넘어가거나 미판매로 남습니다. ${remainingLabel(current.offerExpiresAt ?? current.paymentDueAt, now)}.`}
            </p>
            {buyer && (
              confirmDecline ? (
                <div className="form-actions order-actions">
                  <Button variant="outline" disabled={busy} onClick={() => setConfirmDecline(false)}>돌아가기</Button>
                  <Button className="primary" disabled={busy} onClick={() => run({ action: "decline_offer", orderId: current.id }, belowReserve ? "구매하지 않기로 했습니다." : "제안을 거절했습니다.")}>
                    <XCircle size={16} />{belowReserve ? "구매 안 함 확정" : "거절 확정"}
                  </Button>
                </div>
              ) : (
                <div className="form-actions order-actions">
                  <Button variant="outline" disabled={busy} onClick={() => setConfirmDecline(true)}>{belowReserve ? "아니요, 사지 않을게요" : "거절"}</Button>
                  <Button className="primary" disabled={busy} onClick={() => run({ action: "accept_offer", orderId: current.id }, `${belowReserve ? "구매하기로 했습니다" : "제안을 수락했습니다"}. ${PAYMENT_HOURS}시간 안에 입금해 주세요.`)}>
                    <CheckCircle2 size={16} />{belowReserve ? "네, 그 가격에 살게요" : "제안 수락"}
                  </Button>
                </div>
              )
            )}
          </div>
        </div>
      )}
      {current.status === "awaiting_payment" && (
        <div className={`payment-box ${buyer ? "" : "muted"}`}>
          <Landmark size={20} />
          <div>
            <b>
              {buyer ? "아래 계좌로 입금해 주세요" : "구매자 입금을 기다리고 있어요"} · 기한 {formatDateTime(current.paymentDueAt)}
            </b>
            {buyer && <p className="bank">{data.settings.bankAccount || "입금 계좌는 운영자 안내를 기다려 주세요."}</p>}
            <p>
              입금액 <b>{won(current.amount)}원</b> · {remainingLabel(current.paymentDueAt, now)}. 기한이 지나면 낙찰이 자동 취소됩니다.
            </p>
            {current.depositCode && (
              <div className="deposit-code">
                <span>입금 코드</span>
                <code>{current.depositCode}</code>
                {buyer && <CopyButton text={codeHint} />}
                <small>
                  {buyer
                    ? `입금자명에 코드를 함께 적어 주세요 (예: ${codeHint}). 코드와 금액이 맞으면 자동으로 입금 확인됩니다. 몇 분 안에 확인되지 않으면 아래 입금 완료 신고를 눌러 주세요.`
                    : "구매자가 입금자명에 이 코드를 적으면 자동으로 확인됩니다."}
                </small>
              </div>
            )}
            {buyer && (
              <form
                className="counter-field"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run({ action: "report_payment", orderId: current.id, depositor }, "입금 완료를 알렸습니다. 운영자 확인 후 연락처가 공개됩니다.");
                }}
              >
                <label>
                  입금자명
                  <input required maxLength={40} value={depositor} onChange={(e) => setDepositor(e.target.value)} />
                </label>
                <Button className="primary" disabled={busy || !depositor.trim()}>
                  입금 완료 신고
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
      {buyer && ["awaiting_payment", "offered"].includes(current.status) && (
        <PushToggle vapidPublicKey={data.settings.vapidPublicKey} onAction={onAction} onNotice={onNotice} compact />
      )}
      {current.status === "payment_reported" && (
        <p className="inline-notice">
          {buyer ? "입금 신고가 접수되었습니다." : `구매자가 입금(입금자명 ${current.depositor})을 알렸습니다.`} 운영자가 입금을 확인하면 서로의 연락처가 공개됩니다.
        </p>
      )}
      {current.counterpart && (
        <div className="contact-card">
          <PhoneCall size={20} />
          <div>
            <span>{buyer ? "공급자" : "구매자"} 연락처 · 입금 확인 후 공개{current.paidBy === "webhook" ? ` (자동 확인 · 입금자 ${current.depositor ?? ""} · ${formatDateTime(current.paidAt)})` : ""}</span>
            <b>{current.counterpart.company}</b>
            <p>
              <a href={`tel:${current.counterpart.phone}`}>{current.counterpart.phone}</a>
            </p>
            <p>{current.counterpart.businessAddress}</p>
            <small>인수 일정, 배송비, 세금계산서는 두 사업자가 직접 협의합니다. 별칭 {current.counterpart.alias}</small>
          </div>
        </div>
      )}
      {current.shipPhotos.length > 0 && (
        <div className="photo-evidence">
          <span><Camera size={14} />출고 검수 사진 · {formatDateTime(current.shippedAt)}</span>
          <PhotoGrid urls={current.shipPhotos} />
          {current.status === "shipped" && current.autoCompleteAt && (
            <small>{formatDateTime(current.autoCompleteAt)}까지 수령 확인이나 문제 신고가 없으면 자동으로 수령 확인됩니다.</small>
          )}
        </div>
      )}
      {seller && current.status === "paid" && !dispute && (
        <div className="ship-box">
          <b><Truck size={16} />출고하기</b>
          <p>픽업·상차 시점의 수량과 상태가 보이게 사진을 1~5장 올려 주세요. 분쟁이 생기면 이 사진이 증거가 됩니다.</p>
          <PhotoPicker value={shipPhotos} onChange={setShipPhotos} />
          <Button className="primary" disabled={busy || shipPhotos.length === 0}
            onClick={() => run({ action: "mark_shipped", orderId: current.id, photos: shipPhotos }, "출고 완료로 표시했습니다.")}>
            <Truck size={16} />출고 완료 ({shipPhotos.length}장 첨부)
          </Button>
        </div>
      )}
      <DisputeSection order={current} dispute={dispute} past={pastDisputes} data={data} onAction={onAction} onNotice={onNotice} />
      <ErrorText error={error} />
      <div className="form-actions order-actions">
        {buyer && ["paid", "shipped"].includes(current.status) && !dispute && (
          <Button className="primary" disabled={busy} onClick={() => run({ action: "confirm_received", orderId: current.id }, "인수 완료를 확인했습니다. 공급자 정산이 진행됩니다.")}>
            <CheckCircle2 size={16} />
            재고 인수 완료
          </Button>
        )}
        {admin && ["awaiting_payment", "payment_reported"].includes(current.status) && (
          <Button className="primary" disabled={busy} onClick={() => run({ action: "confirm_payment", orderId: current.id }, "입금을 확인했습니다. 양쪽에 연락처가 공개됩니다.")}>
            입금 확인 (운영자)
          </Button>
        )}
        {admin && current.status === "completed" && (
          <Button className="primary" disabled={busy} onClick={() => run({ action: "settle_order", orderId: current.id }, "정산 완료로 표시했습니다.")}>
            정산 완료 (운영자)
          </Button>
        )}
        {admin && current.refundAmount > current.refundPaid && (
          <Button variant="outline" disabled={busy} onClick={() => run({ action: "mark_refunded", orderId: current.id, amount: current.refundAmount - current.refundPaid }, "환불 완료로 표시했습니다.")}>
            환불 {won(current.refundAmount - current.refundPaid)}원 송금 완료 (운영자)
          </Button>
        )}
      </div>
      {admin && current.status === "completed" && (
        <div className="payout-box">
          <span>공급자 정산 계좌</span>
          {current.payout ? (
            <b>
              {current.payout.bank} {current.payout.account} ({current.payout.holder})
            </b>
          ) : (
            <b>공급자가 정산 계좌를 아직 등록하지 않았습니다.</b>
          )}
        </div>
      )}
      {admin && ["awaiting_payment", "payment_reported", "offered"].includes(current.status) && (
        <form
          className="counter-field"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "cancel_order", orderId: current.id, reason }, "주문을 취소했습니다.");
          }}
        >
          <label>
            운영자 취소 사유
            <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 구매자 요청으로 취소" />
          </label>
          <Button variant="outline" disabled={busy || !reason.trim()}>
            주문 취소
          </Button>
        </form>
      )}
      <dl className="order-timeline">
        <div><dt>{succession ? "제안" : "낙찰"}</dt><dd>{formatDateTime(current.createdAt)}</dd></div>
        <div><dt>입금 신고</dt><dd>{formatDateTime(current.reportedAt)}</dd></div>
        <div><dt>입금 확인</dt><dd>{formatDateTime(current.paidAt)}</dd></div>
        <div><dt>출고</dt><dd>{formatDateTime(current.shippedAt)}</dd></div>
        <div><dt>인수 완료</dt><dd>{formatDateTime(current.completedAt)}</dd></div>
        <div><dt>정산</dt><dd>{formatDateTime(current.settledAt)}</dd></div>
      </dl>
    </div>
  );
}
export function NotificationList({
  notifications,
  onOpen,
}: {
  notifications: Notification[];
  onOpen: (n: Notification) => void;
}) {
  if (notifications.length === 0)
    return (
      <div className="empty">
        <Bell size={36} />
        <h3>아직 알림이 없어요</h3>
        <p>입찰, 낙찰, 입금, 정산 소식을 이곳에서 알려드립니다.</p>
      </div>
    );
  return (
    <ul className="notification-list">
      {notifications.map((n) => (
        <li key={n.id} className={n.readAt ? "" : "unread"}>
          <button onClick={() => onOpen(n)}>
            {n.readAt ? <Bell size={17} /> : <BellRing size={17} />}
            <div>
              <b>{n.title}</b>
              <p>{n.body}</p>
              <time>{formatDateTime(n.createdAt)}</time>
            </div>
            <ArrowRight size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
// Admin: pending deposits with candidate orders, manual entry, dismiss/retry.
export function DepositPanel({ data, onAction, onNotice, onSelectOrder }: {
  data: MarketData;
  onAction: Action;
  onNotice: (text: string) => void;
  onSelectOrder: (o: Order) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [choice, setChoice] = useState<Record<string, string>>({}),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [manual, setManual] = useState({ depositor: "", amount: "", memo: "" });
  const orderById = new Map(data.adminOrders.map((o) => [o.id, o]));
  async function run(action: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
      onNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const open = data.adminOrders.filter((o) => ["awaiting_payment", "payment_reported"].includes(o.status));
  return (
    <div className="deposit-panel">
      {!data.settings.depositWebhook && (
        <p className="inline-notice">
          입금 웹훅이 아직 연결되지 않았습니다 (DEPOSIT_WEBHOOK_SECRET 미설정). 은행 알림 문자 전달 앱이나 PG 콜백을 연결하기 전까지는 아래 수동 입력으로 처리하세요.
        </p>
      )}
      <form
        className="manual-deposit"
        onSubmit={(e) => {
          e.preventDefault();
          void run({ action: "record_deposit", depositor: manual.depositor, amount: Number(manual.amount), memo: manual.memo || undefined }, "입금을 기록하고 매칭을 시도했습니다.").then(() => setManual({ depositor: "", amount: "", memo: "" }));
        }}
      >
        <b>입금 수동 입력</b>
        <div className="field-triple">
          <label>
            입금자명
            <input required maxLength={80} value={manual.depositor} onChange={(e) => setManual({ ...manual, depositor: e.target.value })} placeholder="통장에 찍힌 이름" />
          </label>
          <label>
            금액 (원)
            <input required type="number" min="1" value={manual.amount} onChange={(e) => setManual({ ...manual, amount: e.target.value })} />
          </label>
          <label>
            메모
            <input maxLength={200} value={manual.memo} onChange={(e) => setManual({ ...manual, memo: e.target.value })} placeholder="선택" />
          </label>
        </div>
        <Button className="primary" disabled={busy || !manual.depositor || !manual.amount}>기록하고 매칭</Button>
      </form>
      <ErrorText error={error} />
      {data.deposits.length === 0 ? (
        <div className="empty">
          <Landmark size={36} />
          <h3>미확인 입금이 없어요</h3>
          <p>코드와 금액이 맞는 입금은 자동으로 확인됩니다. 애매한 입금만 여기에 남습니다.</p>
        </div>
      ) : (
        <ul className="deposit-list">
          {data.deposits.map((d) => {
            const candidates = d.candidates.map((id) => orderById.get(id)).filter((o): o is Order => !!o);
            const options = candidates.length ? candidates : open;
            const selected = choice[d.id] ?? options[0]?.id ?? "";
            const target = orderById.get(selected);
            const mismatch = target ? target.amount !== d.amount : false;
            return (
              <li key={d.id}>
                <div className="deposit-head">
                  <b>{won(d.amount)}원</b>
                  <span>입금자 {d.depositor} · {formatDateTime(d.occurredAt ?? d.receivedAt)} · {d.provider}</span>
                  <em>{d.reason ?? d.status}</em>
                </div>
                <div className="deposit-actions">
                  <select value={selected} onChange={(e) => setChoice({ ...choice, [d.id]: e.target.value })} aria-label="연결할 주문">
                    {options.length === 0 && <option value="">입금 대기 주문 없음</option>}
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.productTitle.slice(0, 18)} · {o.buyerAlias} · {won(o.amount)}원 · 코드 {o.depositCode ?? "-"}
                      </option>
                    ))}
                  </select>
                  {target && (
                    <button type="button" className="text-button" onClick={() => onSelectOrder(target)}>주문 보기</button>
                  )}
                  {mismatch && (
                    <input maxLength={200} placeholder="금액 불일치 사유 (강제 연결 시 필수)" value={notes[d.id] ?? ""} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} />
                  )}
                  <Button className="primary" disabled={busy || !selected || (mismatch && !(notes[d.id] ?? "").trim())}
                    onClick={() => run({ action: "match_deposit", depositId: d.id, orderId: selected, force: mismatch, note: notes[d.id] ?? "" }, "입금을 주문에 연결했습니다. 양쪽에 연락처가 공개됩니다.")}>
                    연결
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => run({ action: "retry_deposit", depositId: d.id }, "다시 매칭했습니다.")}>재시도</Button>
                  <Button variant="outline" disabled={busy} onClick={() => run({ action: "dismiss_deposit", depositId: d.id, note: notes[d.id] || "운영자 무시" }, "입금 내역을 무시했습니다.")}>무시</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
// Up to five evidence photos, uploaded through the existing /api/uploads route.
export function PhotoPicker({ value, onChange, max = 5 }: { value: string[]; onChange: (urls: string[]) => void; max?: number }) {
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    setUploading(true);
    const next = [...value];
    try {
      for (const file of [...files].slice(0, max - value.length)) {
        if (file.size > 3 * 1024 * 1024) throw new Error("사진은 한 장에 3MB 이하로 올려 주세요.");
        const form = new FormData();
        form.append("file", file);
        const r = await fetch("/api/uploads", { method: "POST", headers: { "X-Dumping-Client": "1" }, body: form });
        const body = (await r.json()) as { url?: string; error?: string };
        if (!r.ok || !body.url) throw new Error(body.error || "사진을 올리지 못했습니다.");
        next.push(body.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "사진을 올리지 못했습니다.");
    } finally {
      onChange(next);
      setUploading(false);
    }
  }
  return (
    <div className="photo-picker">
      <div className="photo-grid">
        {value.map((url) => (
          <div key={url} className="photo-thumb">
            <img src={url} alt="첨부 사진" />
            <button type="button" aria-label="사진 빼기" onClick={() => onChange(value.filter((v) => v !== url))}>
              <X size={12} />
            </button>
          </div>
        ))}
        {value.length < max && (
          <label className="photo-add">
            <ImagePlus size={20} />
            <span>{uploading ? "올리는 중…" : `사진 추가 (${value.length}/${max})`}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploading} onChange={(e) => void add(e.target.files)} />
          </label>
        )}
      </div>
      <ErrorText error={error} />
    </div>
  );
}
export function PhotoGrid({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <div className="photo-grid">
      {urls.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="photo-thumb">
          <img src={url} alt="증빙 사진" />
        </a>
      ))}
    </div>
  );
}
const disputeKindText: Record<Dispute["kind"], string> = {
  buyer_cancel: "구매 취소 요청(단순 변심)",
  misrepresentation: "허위매물·상품 불일치",
  not_shipped: "출고 지연",
  other: "기타",
  no_payment: "미입금",
};
const resolutionText: Record<string, string> = {
  release: "거래 계속 진행",
  cancel_refund: "거래 취소·환불",
  partial_refund: "부분 환불 후 거래 계속",
  cancel: "자동 취소",
};
// Buyer/seller view: open a report, answer one, and see past outcomes.
function DisputeSection({ order: o, dispute, past, data, onAction, onNotice }: {
  order: Order; dispute: Dispute | null; past: Dispute[]; data: MarketData; onAction: Action; onNotice: (text: string) => void;
}) {
  const buyer = o.buyerId === data.user?.id, seller = o.sellerId === data.user?.id;
  const [kind, setKind] = useState<Dispute["kind"] | "">(""),
    [text, setText] = useState(""),
    [photos, setPhotos] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const penaltyPct = Math.round(data.settings.penaltyRate * 100);
  const kinds: Dispute["kind"][] = buyer
    ? [
      ...(["awaiting_payment", "payment_reported", "paid"].includes(o.status) ? ["buyer_cancel" as const] : []),
      ...(["paid", "shipped"].includes(o.status) ? ["misrepresentation" as const] : []),
      ...(o.status === "paid" ? ["not_shipped" as const] : []),
      ...(["awaiting_payment", "payment_reported", "paid", "shipped"].includes(o.status) ? ["other" as const] : []),
    ]
    : seller && ["awaiting_payment", "payment_reported", "paid", "shipped"].includes(o.status) ? ["other"] : [];
  async function submit(action: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
      setKind("");
      setText("");
      setPhotos([]);
      onNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  if (!buyer && !seller) return null;
  return (
    <div className="dispute-section">
      {dispute ? (
        <div className="dispute-card open">
          <b><AlertTriangle size={15} />{dispute.mine ? "내가 접수한 신고" : `${dispute.openerRole === "buyer" ? "구매자" : "공급자"}가 접수한 신고`} · {disputeKindText[dispute.kind]}</b>
          <p>{dispute.description}</p>
          <PhotoGrid urls={dispute.photos} />
          {dispute.response && (
            <div className="dispute-response">
              <span>상대방 소명</span>
              <p>{dispute.response}</p>
              <PhotoGrid urls={dispute.responsePhotos} />
            </div>
          )}
          <small>운영자가 검토 중입니다. 처리될 때까지 입금 기한과 자동 수령 확인이 멈춥니다.</small>
          {!dispute.mine && !dispute.response && (
            <form className="form-stack" onSubmit={(e) => { e.preventDefault(); void submit({ action: "respond_dispute", disputeId: dispute.id, text, photos }, "소명을 남겼습니다."); }}>
              <label>
                소명 (운영자에게 전달)
                <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="상황을 설명하고 필요하면 사진을 올려 주세요." />
              </label>
              <PhotoPicker value={photos} onChange={setPhotos} />
              <Button className="primary" disabled={busy || text.trim().length < 2}>소명 보내기</Button>
            </form>
          )}
        </div>
      ) : kinds.length > 0 && (
        <details className="dispute-open">
          <summary><AlertTriangle size={14} />{buyer ? "문제가 있나요? 취소 요청·허위매물 신고" : "거래 문제 신고"}</summary>
          <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (kind) void submit({ action: "open_dispute", orderId: o.id, kind, description: text, photos }, "신고를 접수했습니다. 운영자가 검토합니다."); }}>
            <label>
              유형
              <select value={kind} onChange={(e) => setKind(e.target.value as Dispute["kind"])}>
                <option value="">선택해 주세요</option>
                {kinds.map((k) => <option key={k} value={k}>{disputeKindText[k]}</option>)}
              </select>
            </label>
            {kind === "buyer_cancel" && (
              <p className="inline-notice warn">
                단순 변심 취소는 운영자 확인 후 처리되며 낙찰가의 {penaltyPct}% 위약금({won(Math.round(o.amount * data.settings.penaltyRate))}원)이 부과될 수 있습니다. 입금했다면 위약금을 뺀 금액이 환불됩니다.
              </p>
            )}
            {kind === "misrepresentation" && (
              <p className="inline-notice">받은 재고의 수량·상태가 보이는 사진을 꼭 올려 주세요. 출고 검수 사진과 비교해 판단합니다.</p>
            )}
            <label>
              내용
              <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="무엇이 문제인지 구체적으로 적어 주세요." />
            </label>
            <PhotoPicker value={photos} onChange={setPhotos} />
            <ErrorText error={error} />
            <Button className="primary" disabled={busy || !kind || text.trim().length < 5}>신고 접수</Button>
          </form>
        </details>
      )}
      {dispute && <ErrorText error={error} />}
      {past.map((d) => (
        <div key={d.id} className="dispute-card">
          <b>{disputeKindText[d.kind]} · {resolutionText[d.resolution ?? ""] ?? "처리 완료"}</b>
          {d.refundAmount > 0 && <p>환불 {won(d.refundAmount)}원</p>}
          {d.penaltyAmount > 0 && <p>내 위약금 {won(d.penaltyAmount)}원 · {d.penaltyStatus === "due" ? "미납" : d.penaltyStatus === "paid" ? "납부 확인" : "면제"}</p>}
          {d.adminNote && <small>운영자 메모: {d.adminNote}</small>}
        </div>
      ))}
    </div>
  );
}
// Admin: open disputes with evidence and a resolution form, unpaid penalties, refunds to send.
export function AdminDisputePanel({ data, onAction, onNotice, onSelectOrder }: {
  data: MarketData; onAction: Action; onNotice: (text: string) => void; onSelectOrder: (o: Order) => void;
}) {
  const [draft, setDraft] = useState<Record<string, { resolution: string; refund: string; party: string; note: string }>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const orderById = new Map(data.adminOrders.map((o) => [o.id, o]));
  const open = data.disputes.filter((d) => d.status === "open");
  const due = data.disputes.filter((d) => d.penaltyStatus === "due");
  const refunds = data.adminOrders.filter((o) => o.refundAmount > o.refundPaid);
  async function run(action: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
      onNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  const pct = Math.round(data.settings.penaltyRate * 100);
  return (
    <div className="admin-disputes">
      <ErrorText error={error} />
      <h3>처리할 분쟁 <span>{open.length}</span></h3>
      {open.length === 0 && <p className="bid-empty">접수된 분쟁이 없습니다.</p>}
      {open.map((d) => {
        const f = draft[d.id] ?? { resolution: d.kind === "buyer_cancel" ? "cancel_refund" : "release", refund: "", party: d.kind === "buyer_cancel" ? "buyer" : "", note: "" };
        const set = (patch: Partial<typeof f>) => setDraft({ ...draft, [d.id]: { ...f, ...patch } });
        const order = orderById.get(d.orderId);
        return (
          <div key={d.id} className="dispute-card open">
            <b>{disputeKindText[d.kind]} · {d.productTitle} · {won(d.amount ?? 0)}원 · {d.orderStatus && d.orderStatus in orderStatusLabels ? orderStatusLabels[d.orderStatus as keyof typeof orderStatusLabels] : d.orderStatus}</b>
            <small>구매자 {d.buyerAlias} / 공급자 {d.sellerAlias} · {d.openerRole === "buyer" ? "구매자" : "공급자"} 신고 · {formatDateTime(d.createdAt)}</small>
            <p>{d.description}</p>
            <PhotoGrid urls={d.photos} />
            {d.response && (
              <div className="dispute-response">
                <span>상대방 소명</span>
                <p>{d.response}</p>
                <PhotoGrid urls={d.responsePhotos} />
              </div>
            )}
            {(d.shipPhotos?.length ?? 0) > 0 && (
              <div className="dispute-response">
                <span>출고 검수 사진</span>
                <PhotoGrid urls={d.shipPhotos ?? []} />
              </div>
            )}
            <div className="resolve-form">
              <select value={f.resolution} onChange={(e) => set({ resolution: e.target.value })} aria-label="처리 방법">
                <option value="release">기각 · 거래 계속</option>
                <option value="cancel_refund">거래 취소 · 환불</option>
                <option value="partial_refund">부분 환불 후 거래 계속</option>
              </select>
              {f.resolution === "partial_refund" && (
                <input type="number" min="1" value={f.refund} onChange={(e) => set({ refund: e.target.value })} placeholder="부분 환불액(원)" />
              )}
              <select value={f.party} onChange={(e) => set({ party: e.target.value })} aria-label="위약금">
                <option value="">위약금 없음</option>
                <option value="buyer">구매자 위약금 {pct}%</option>
                <option value="seller">공급자 위약금 {pct}%</option>
              </select>
              <input maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="양측에 전달할 메모" />
              {order && <button type="button" className="text-button" onClick={() => onSelectOrder(order)}>주문 보기</button>}
              <Button className="primary" disabled={busy || (f.resolution === "partial_refund" && !(Number(f.refund) > 0))}
                onClick={() => run({
                  action: "resolve_dispute", disputeId: d.id, resolution: f.resolution,
                  refundAmount: f.resolution === "partial_refund" ? Number(f.refund) : undefined,
                  penaltyParty: f.party || null, note: f.note || undefined,
                }, "분쟁을 처리했습니다.")}>
                처리
              </Button>
            </div>
          </div>
        );
      })}
      <h3>미납 위약금 <span>{due.length}</span></h3>
      {due.length === 0 && <p className="bid-empty">미납 위약금이 없습니다. 위약금이 남아 있는 회원은 입찰과 재고 등록이 막힙니다.</p>}
      {due.map((d) => (
        <div key={d.id} className="dispute-card">
          <b>{won(d.penaltyAmount)}원 · {d.penaltyParty === "buyer" ? `구매자 ${d.buyerAlias}` : `공급자 ${d.sellerAlias}`} · {disputeKindText[d.kind]}</b>
          <small>{d.productTitle} · {formatDateTime(d.resolvedAt ?? d.createdAt)}</small>
          <div className="form-actions order-actions">
            <Button variant="outline" disabled={busy} onClick={() => run({ action: "settle_penalty", disputeId: d.id, status: "waived" }, "위약금을 면제했습니다.")}>면제</Button>
            <Button className="primary" disabled={busy} onClick={() => run({ action: "settle_penalty", disputeId: d.id, status: "paid" }, "위약금 납부를 확인했습니다.")}>납부 확인</Button>
          </div>
        </div>
      ))}
      <h3>보낼 환불 <span>{refunds.length}</span></h3>
      {refunds.length === 0 && <p className="bid-empty">보낼 환불이 없습니다.</p>}
      {refunds.map((o) => (
        <div key={o.id} className="dispute-card">
          <b>{won(o.refundAmount - o.refundPaid)}원 → 구매자 {o.buyerAlias}</b>
          <small>{o.productTitle} · {orderStatusLabel(o)}</small>
          <div className="form-actions order-actions">
            <button type="button" className="text-button" onClick={() => onSelectOrder(o)}>주문 보기</button>
            <Button className="primary" disabled={busy} onClick={() => run({ action: "mark_refunded", orderId: o.id, amount: o.refundAmount - o.refundPaid }, "환불 완료로 표시했습니다.")}>송금 완료</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
// Admin: bidders who share a hashed IP or a business number with the seller.
export function FraudPanel({ data, onAction, onNotice }: { data: MarketData; onAction: Action; onNotice: (text: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function cancel(listingId: string) {
    const reason = window.prompt("경매를 중단하는 사유를 적어 주세요. 판매자와 입찰자에게 전달됩니다.", "자전거래 의심");
    if (!reason) return;
    setBusy(true);
    setError("");
    try {
      await onAction({ action: "admin_cancel_auction", productId: listingId, reason });
      onNotice("경매를 중단했습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-disputes">
      <p className="inline-notice">
        판매자와 같은 IP(해시로만 저장)나 같은 사업자등록번호를 쓰는 입찰자입니다. 같은 사무실·통신사 공유 IP일 수도 있으니 입찰 패턴을 보고 판단하세요. 같은 사업자번호 계정은 입찰 자체가 막혀 있습니다.
      </p>
      <ErrorText error={error} />
      <h3>자전거래 의심 입찰 <span>{data.fraud.length}</span></h3>
      {data.fraud.length === 0 && <p className="bid-empty">최근 90일간 의심 신호가 없습니다.</p>}
      {data.fraud.map((f) => (
        <div key={`${f.listingId}-${f.bidderAlias}`} className="dispute-card">
          <b>{f.title}</b>
          <small>공급자 {f.sellerAlias} ↔ 입찰자 {f.bidderAlias} · 입찰 {f.bids}건 · 최근 {formatDateTime(f.lastBidAt)} · {auctionStatusLabels[f.status as Auction["status"]] ?? f.status}</small>
          <p>{f.sameBusiness ? "같은 사업자등록번호" : ""}{f.sameBusiness && f.sharedIps ? " · " : ""}{f.sharedIps ? `같은 IP ${f.sharedIps}개` : ""}</p>
          {["active", "deciding"].includes(f.status) && (
            <Button variant="outline" disabled={busy} onClick={() => void cancel(f.listingId)}>경매 중단</Button>
          )}
        </div>
      ))}
      <h3>사업자번호를 함께 쓰는 계정 <span>{data.duplicateBusiness.length}</span></h3>
      {data.duplicateBusiness.length === 0 && <p className="bid-empty">없습니다.</p>}
      {data.duplicateBusiness.map((d) => (
        <div key={d.businessNumber} className="dispute-card">
          <b>{d.businessNumber.slice(0, 3)}-{d.businessNumber.slice(3, 5)}-{d.businessNumber.slice(5)}</b>
          <small>{d.aliases.join(", ")}</small>
        </div>
      ))}
    </div>
  );
}
