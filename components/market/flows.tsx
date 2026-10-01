"use client";
import { useEffect, useState, type FormEvent } from "react";
import { businessRegion } from "@/lib/business-region";
import {
  ArrowRight,
  ArrowUpRight,
  Clock3,
  Heart,
  MapPin,
  Package,
  Truck,
  Upload,
  ShieldCheck,
  MessageCircle,
  Send,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  categories,
  discount,
  won,
  daysLeft,
  type Product,
} from "@/lib/catalog";
import {
  type MarketData,
  type Notification,
  type Offer,
  type Order,
  type Profile,
  auctionStatusLabels,
  orderStatusLabel,
  feeRateFor,
  statusLabels,
} from "@/lib/models";
import { AdminDisputePanel, AuctionFields, AuctionPanel, Countdown, DepositPanel, FraudPanel, NotificationList, formatDateTime } from "./auction";
import { PushToggle } from "./push";
import { Bell, Gavel, Receipt, ShieldAlert } from "lucide-react";
export type Action = (data: Record<string, unknown>) => Promise<void>;
export function Modal({
  title,
  description,
  children,
  open,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  open: boolean;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={`market-modal ${wide ? "wide" : ""}`}>
        <DialogTitle className="modal-title">{title}</DialogTitle>
        <DialogDescription
          className={description ? "modal-description" : "sr-only"}
        >
          {description || title}
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;
}
export function ProductDetail({
  product: p,
  onClose,
  onAction,
  onSuccess,
  favorite,
  onFavorite,
  userId,
  data,
  onNotice,
  onRefresh,
}: {
  product: Product;
  onClose: () => void;
  onAction: Action;
  onSuccess: () => void;
  favorite: boolean;
  onFavorite: () => void;
  userId?: string;
  data: MarketData;
  onNotice: (text: string) => void;
  onRefresh?: () => void;
}) {
  const isAuction = p.saleType === "auction" && !!p.auction;
  const [quote, setQuote] = useState(false),
    [quantity, setQuantity] = useState(p.moq),
    [price, setPrice] = useState(p.price),
    [shipping, setShipping] = useState("배송 협의"),
    [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [requestId] = useState(() => crypto.randomUUID());
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await onAction({
        action: "create_offer",
        id: requestId,
        productId: p.id,
        quantity,
        price,
        shipping,
        note,
      });
      onClose();
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={quote ? "매입 견적 요청" : p.title}
      description={
        quote
          ? "수량과 희망 단가를 제안해 주세요. 내 거래에서 협의를 이어갈 수 있어요."
          : `${p.category} · ${p.seller}${isAuction ? (p.auction?.mode === "partial" ? " · 부분 수량 경매" : " · 전량 경매") : ""}`
      }
      wide
    >
      <div className="detail-grid">
        <div>
          <img
            className={`detail-image photo-${p.id.replace("sample-", "")}`}
            src={p.image}
            alt={p.title}
          />
          {p.sample && (
            <div className="sample-notice">
              샘플 상품 · 사진은 예시이며 실제 판매 재고가 아닙니다.
            </div>
          )}
          <div className="supplier-box">
            <div className="supplier-avatar">
              <Package size={23} />
            </div>
            <div>
              <b>{p.seller}</b>
              <p>
                <MapPin size={13} />
                {p.region} 보관 · {p.sellerVerified ? "사업자번호 조회: 계속사업자" : "사업자번호 조회 전"}
              </p>
            </div>
          </div>
        </div>
        <div className="detail-info">
          <div className="detail-pills">
            <span>{p.condition}</span>
            {isAuction ? (
              <span className="pill-auction"><Gavel size={13} />{p.auction?.mode === "partial" ? "부분 수량 경매" : "전량 경매"}</span>
            ) : (
              <span>
                <Clock3 size={13} />
                {daysLeft(p.deadline) < 0 ? "마감" : `D-${daysLeft(p.deadline)}`}
              </span>
            )}
          </div>
          <h2>{p.title}</h2>
          <p className="detail-original">
            정상가 <s>{won(p.originalPrice)}원</s>
          </p>
          {isAuction ? (
            <>
              <div className="detail-price">
                <strong>{Math.max(0, Math.round((1 - (p.auction!.currentPrice ?? p.auction!.startPrice) / p.originalPrice) * 100))}%</strong>
                <b>
                  {won(p.auction!.currentPrice ?? p.auction!.startPrice)}
                  <small>원</small>
                </b>
                <span>/ {p.unit} · {p.auction!.currentPrice === null ? "시작가" : p.auction!.status === "active" ? "현재 최고가" : "최종 입찰가"}</span>
              </div>
              <p className="tax-note">단가 기준 · 부가세·배송비는 낙찰 후 두 사업자가 협의 · 공급자 수수료 {Math.round(feeRateFor(data.settings, p.category) * 1000) / 10}%</p>
              <AuctionPanel
                product={p}
                auction={p.auction!}
                bids={data.bids.filter((b) => b.listingId === p.id)}
                data={data}
                onAction={onAction}
                onNotice={onNotice}
                onRefresh={onRefresh}
              />
              <div className="description">
                <h3>상품 안내</h3>
                <p>{p.description}</p>
              </div>
              <div className="detail-actions">
                <Button variant="outline" className="save-detail" onClick={onFavorite} aria-label="관심상품" aria-pressed={favorite}>
                  <Heart fill={favorite ? "currentColor" : "none"} />
                </Button>
              </div>
            </>
          ) : (
          <>
          <div className="detail-price">
            <strong>{discount(p)}%</strong>
            <b>
              {won(p.price)}
              <small>원</small>
            </b>
            <span>/ {p.unit}</span>
          </div>
          <p className="tax-note">
            표시 단가 기준 · 부가세 포함 여부는 공급자와 협의
          </p>
          {!quote ? (
            <>
              <dl className="detail-specs">
                <div>
                  <dt>최소 매입</dt>
                  <dd>
                    {won(p.moq)}
                    {p.unit}
                  </dd>
                </div>
                <div>
                  <dt>잔여 재고</dt>
                  <dd>
                    {won(p.stock)}
                    {p.unit}
                  </dd>
                </div>
                <div>
                  <dt>거래 마감</dt>
                  <dd>{p.deadline}</dd>
                </div>
                <div>
                  <dt>배송 방식</dt>
                  <dd>직접 픽업 · 화물 · 협의</dd>
                </div>
              </dl>
              <div className="description">
                <h3>상품 안내</h3>
                <p>{p.description}</p>
              </div>
              <div className="detail-actions">
                <Button
                  variant="outline"
                  className="save-detail"
                  onClick={onFavorite}
                  aria-label="관심상품"
                  aria-pressed={favorite}
                >
                  <Heart fill={favorite ? "currentColor" : "none"} />
                </Button>
                <Button
                  className="primary"
                  disabled={daysLeft(p.deadline) < 0 || p.ownerId === userId}
                  onClick={() => setQuote(true)}
                >
                  {p.ownerId === userId
                    ? "내가 등록한 상품"
                    : daysLeft(p.deadline) < 0
                      ? "마감된 재고"
                      : "매입 견적 요청"}
                  <ArrowRight />
                </Button>
              </div>
            </>
          ) : (
            <form className="form-stack" onSubmit={submit}>
              <div className="field-pair">
                <label>
                  매입 수량 ({p.unit})
                  <input
                    required
                    type="number"
                    min={p.moq}
                    max={p.stock}
                    step="1"
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                  <small>
                    최소 {won(p.moq)}
                    {p.unit}
                  </small>
                </label>
                <label>
                  희망 단가 (원)
                  <input
                    required
                    type="number"
                    min="1"
                    max="100000000"
                    step="1"
                    value={price}
                    onChange={(e) => setPrice(Number(e.target.value))}
                  />
                </label>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setQuantity(p.stock)}
              >
                잔여 재고 전량 선택 ({won(p.stock)}
                {p.unit})
              </button>
              <label>
                배송 방식
                <select
                  value={shipping}
                  onChange={(e) => setShipping(e.target.value)}
                >
                  {["배송 협의", "직접 픽업", "택배", "화물 배송"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                공급자에게 남길 내용
                <textarea
                  maxLength={2000}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="희망 납기, 인수 지역, 확인할 사항을 적어주세요."
                />
              </label>
              <div className="quote-total">
                <span>제안 상품 금액</span>
                <b>{won(quantity * price)}원</b>
                <small>배송비·부가세 별도 협의 · 결제 요청이 아닙니다.</small>
              </div>
              {p.sample && (
                <p className="inline-notice">
                  샘플 견적은 내 거래에 저장됩니다. 실제 공급자에게 전달되거나
                  자동 응답되지 않습니다.
                </p>
              )}
              <ErrorText error={error} />
              <div className="form-actions">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setQuote(false)}
                >
                  이전
                </Button>
                <Button className="primary" disabled={busy}>
                  {busy ? "저장 중…" : "견적 요청 저장"}
                  <ArrowRight size={16} />
                </Button>
              </div>
            </form>
          )}
          </>
          )}
        </div>
      </div>
    </Modal>
  );
}
export function ListingForm({
  profile,
  onAction,
  onDone,
  policy,
  succession = false,
}: {
  profile: Profile | null;
  onAction: Action;
  onDone: () => void;
  policy?: "seller_decides" | "buyer_only";
  succession?: boolean;
}) {
  const [image, setImage] = useState(""),
    [uploading, setUploading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saleType, setSaleType] = useState<"quote" | "auction">("auction"),
    [startPrice, setStartPrice] = useState<number | "">(""),
    [stockValue, setStockValue] = useState<number | "">("");
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 3 * 1024 * 1024) {
      setError("사진은 3MB 이하로 선택해 주세요.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/uploads", {
          method: "POST",
          headers: { "X-Dumping-Client": "1" },
          body: form,
        }),
        data = (await r.json()) as { error?: string; url: string };
      if (!r.ok) throw new Error(data.error);
      setImage(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "사진을 올리지 못했습니다.");
    } finally {
      setUploading(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!image) {
      setError("상품 사진을 먼저 올려주세요.");
      return;
    }
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const product = Object.fromEntries(f.entries());
      const stock = Number(f.get("stock"));
      await onAction({
        action: "create_listing",
        product: {
          ...product,
          image,
          saleType,
          price: Number(f.get("price")),
          originalPrice: Number(f.get("originalPrice")),
          stock,
          moq: saleType === "auction" ? stock : Number(f.get("moq")),
          auctionDays: saleType === "auction" ? Number(f.get("auctionDays")) : undefined,
          reservePrice: saleType === "auction" ? Number(f.get("reservePrice")) : undefined,
          auctionMode: saleType === "auction" ? String(f.get("auctionMode") || "whole") : undefined,
          minLot: saleType === "auction" && f.get("auctionMode") === "partial" ? Number(f.get("minLot")) : undefined,
          successionEnabled: saleType === "auction" ? f.get("successionEnabled") === "on" : undefined,
          instantPrice: saleType === "auction" && f.get("auctionMode") !== "partial" && f.get("instantPrice") ? Number(f.get("instantPrice")) : undefined,
          deadline: saleType === "auction" ? undefined : f.get("deadline"),
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <p className="inline-notice">
        등록한 상품과 사진은 공개됩니다. 공급자명은 거래 별칭으로 표시됩니다.
      </p>
      <div className="sale-type" role="radiogroup" aria-label="판매 방식">
        <button type="button" className={saleType === "auction" ? "selected" : ""} aria-pressed={saleType === "auction"} onClick={() => setSaleType("auction")}>
          <Gavel size={18} />
          <b>전량 경매</b>
          <span>기간·최저 매각가를 정하면 구매자가 입찰합니다</span>
        </button>
        <button type="button" className={saleType === "quote" ? "selected" : ""} aria-pressed={saleType === "quote"} onClick={() => setSaleType("quote")}>
          <MessageCircle size={18} />
          <b>견적 협의</b>
          <span>구매자가 수량·가격을 제안하면 협의합니다</span>
        </button>
      </div>
      <label className="upload-area">
        {image ? (
          <img src={image} alt="등록할 상품 사진" />
        ) : (
          <Upload size={26} />
        )}
        <b>
          {uploading
            ? "사진을 올리고 있어요…"
            : image
              ? "사진 변경하기"
              : "상품 사진 올리기"}
        </b>
        <span>JPG, PNG, WebP · 최대 3MB</span>
        <input
          aria-label="상품 사진"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading || busy}
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </label>
      <label>
        상품명
        <input
          required
          minLength={2}
          maxLength={100}
          name="title"
          placeholder="상품명, 규격, 구성 수량을 적어주세요"
        />
      </label>
      <div className="field-pair">
        <label>
          카테고리
          <select name="category">
            {categories.slice(1).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          상품 상태
          <select name="condition">
            {[
              "새상품",
              "재고정리",
              "시즌오프",
              "소비기한 임박",
              "박스훼손",
              "패키지 변경",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-pair">
        <label>
          정상가 (원)
          <input
            required
            name="originalPrice"
            type="number"
            min="1"
            max="100000000"
            placeholder="예: 10,000"
          />
        </label>
        <label>
          {saleType === "auction" ? "경매 시작가 (원 / 단위)" : "희망 단가 (원)"}
          <input
            required
            name="price"
            type="number"
            min="1"
            max="100000000"
            placeholder="예: 3,000"
            value={startPrice}
            onChange={(e) => setStartPrice(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
      </div>
      {saleType === "auction" && <AuctionFields price={startPrice} stock={stockValue} policy={policy} succession={succession} />}
      <div className="field-triple">
        <label>
          {saleType === "auction" ? "전량 수량" : "총 재고"}
          <input
            required
            name="stock"
            type="number"
            min="1"
            max="1000000"
            placeholder="1000"
            value={stockValue}
            onChange={(e) => setStockValue(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        {saleType === "quote" && (
        <label>
          최소 매입 수량
          <input
            required
            name="moq"
            type="number"
            min="1"
            max="1000000"
            placeholder="30"
          />
        </label>
        )}
        <label>
          단위
          <select name="unit">
            {["개", "박스", "장", "봉", "병", "세트", "팔레트"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-pair">
        <label>
          보관 지역
          <select name="region" defaultValue={profile?.region || "경기"}>
            {[
              "서울",
              "경기",
              "인천",
              "충청",
              "경상",
              "전라",
              "강원",
              "제주",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {saleType === "quote" && (
        <label>
          거래 마감일
          <input
            required
            name="deadline"
            type="date"
            min={new Date().toLocaleDateString("sv-SE", {
              timeZone: "Asia/Seoul",
            })}
          />
        </label>
        )}
      </div>
      <label>
        공개되는 거래 별칭
        <input
          readOnly
          value={profile?.publicAlias || "사업자 주소 등록 후 자동 배정"}
        />
      </label>
      <label>
        상품 설명
        <textarea
          required
          minLength={10}
          maxLength={2000}
          name="description"
          rows={4}
          placeholder="재고 처분 사유, 소비기한, 상품 상태와 배송 조건을 알려주세요."
        />
      </label>
      <label className="check-row consent">
        <input required type="checkbox" />
        상품 정보와 사진의 사용 권한을 확인했습니다.
      </label>
      <ErrorText error={error} />
      <Button className="primary full-button" disabled={busy || uploading || !profile?.publicAlias}>
        {busy ? "재고 등록 중…" : saleType === "auction" ? "경매 시작하기" : "재고 등록하기"}
        {saleType === "auction" ? <Gavel size={17} /> : <Plus size={17} />}
      </Button>
    </form>
  );
}
export function Logistics() {
  const [from, setFrom] = useState("경기"),
    [to, setTo] = useState("서울"),
    [count, setCount] = useState(1),
    [cold, setCold] = useState(false);
  const regions = [
    "서울",
    "경기",
    "인천",
    "충청",
    "경상",
    "전라",
    "강원",
    "제주",
  ];
  const base =
    from === to
      ? 45000
      : from === "제주" || to === "제주"
        ? 180000
        : Math.abs(regions.indexOf(from) - regions.indexOf(to)) < 3
          ? 65000
          : 100000;
  const low = (base + Math.max(0, count - 1) * 30000) * (cold ? 1.4 : 1);
  return (
    <div className="form-stack">
      <div className="field-pair">
        <label>
          출발 지역
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {regions.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          도착 지역
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {regions.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        팔레트 수 (1~20)
        <input
          type="number"
          min="1"
          max="20"
          value={count}
          onChange={(e) =>
            setCount(Math.max(1, Math.min(20, Number(e.target.value))))
          }
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={cold}
          onChange={(e) => setCold(e.target.checked)}
        />
        냉장·냉동 운송 필요
      </label>
      <div className="logistics-result">
        <Truck size={29} />
        <span>예상 운송비 범위</span>
        <b>
          {won(Math.round(low))} ~ {won(Math.round(low * 1.35))}
          <small>원</small>
        </b>
      </div>
      <p className="inline-notice">
        임의의 지역별 단가를 적용한 시뮬레이션입니다. 운송사 실견적이 아니며
        중량, 상세 주소, 상하차, 부가세에 따라 달라집니다. 실제 배송비는
        공급자와 협의해 주세요.
      </p>
    </div>
  );
}
export function ProfileForm({
  profile,
  onAction,
  onDone,
  userId,
}: {
  profile: Profile | null;
  onAction: Action;
  onDone: () => void;
  userId?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [address, setAddress] = useState(profile?.businessAddress || "");
  const area = businessRegion(address);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onAction({
        action: "profile",
        profile: {
          company: f.get("company"),
          businessNumber: String(f.get("businessNumber")).replace(/-/g, ""),
          phone: String(f.get("phone")).replace(/-/g, ""),
          businessAddress: address,
          payoutBank: f.get("payoutBank"),
          payoutAccount: String(f.get("payoutAccount") || ""),
          payoutHolder: f.get("payoutHolder"),
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <p className="inline-notice">
        <ShieldCheck size={18} />
        {profile?.businessStatus === "active"
          ? "국세청 조회 결과 이 번호는 계속사업자입니다. 번호의 영업 상태만 확인하며 소유자 확인은 아닙니다."
          : profile?.businessStatus === "suspended"
            ? "국세청 조회 결과 휴업 중인 사업자입니다."
            : "사업자등록번호는 번호 규칙을 검사합니다. 국세청 상태 조회는 운영자가 조회 키를 등록하면 저장할 때 함께 확인됩니다."}
        {" "}판매자와 같은 사업자번호로 등록된 계정은 그 판매자의 경매에 입찰할 수 없습니다.
      </p>
      <label>
        실제 상호 (본인에게만 표시)
        <input
          required
          name="company"
          minLength={2}
          maxLength={60}
          defaultValue={profile?.company}
        />
      </label>
      <label>
        사업자등록번호
        <input
          required
          name="businessNumber"
          inputMode="numeric"
          pattern="[0-9-]{10,12}"
          placeholder="000-00-00000"
          defaultValue={profile?.businessNumber}
        />
      </label>
      <label>
        연락처
        <input
          required
          name="phone"
          type="tel"
          maxLength={13}
          placeholder="010-0000-0000"
          defaultValue={profile?.phone}
        />
      </label>
      <label>
        사업자등록증의 사업장 주소
        <input required name="businessAddress" autoComplete="street-address"
          value={address} onChange={e => setAddress(e.target.value)}
          minLength={8} maxLength={200} placeholder="서울특별시 강남구 테헤란로 123" />
        <small>시·도부터 건물 번호까지 입력해 주세요. 상세 주소는 공개되지 않습니다.</small>
      </label>
      <div className="business-alias" aria-live="polite">
        <span>공개되는 거래 별칭</span>
        <strong>{profile?.publicAlias && area?.districtKey === profile.districtKey
          ? profile.publicAlias : area ? `${area.districtKey} · 저장하면 형용사 자동 배정` : "사업자 주소를 입력해 주세요"}</strong>
        <p>사업장 지역에 따라 중복되지 않는 별칭을 자동 배정합니다. 다른 지역으로 주소를 변경하면 별칭도 바뀝니다.</p>
      </div>
      <div className="payout-fields">
        <b>정산 계좌 (낙찰 정산용 · 본인과 운영자에게만 표시)</b>
        <div className="field-triple">
          <label>
            은행
            <input name="payoutBank" maxLength={30} placeholder="예: 국민은행" defaultValue={profile?.payoutBank || ""} />
          </label>
          <label>
            계좌번호
            <input name="payoutAccount" inputMode="numeric" maxLength={30} placeholder="숫자와 -" defaultValue={profile?.payoutAccount || ""} />
          </label>
          <label>
            예금주
            <input name="payoutHolder" maxLength={40} defaultValue={profile?.payoutHolder || ""} />
          </label>
        </div>
      </div>
      {userId && (
        <p className="account-id">
          계정 ID <code>{userId}</code>
          <small>운영자 권한은 이 ID를 ADMIN_USER_IDS 환경 변수에 넣어 부여합니다.</small>
        </p>
      )}
      <ErrorText error={error} />
      <Button className="primary full-button" disabled={busy}>
        {busy ? "저장 중…" : "사업자 정보 저장"}
      </Button>
    </form>
  );
}
export function Dashboard({
  data,
  onAction,
  onSelectOffer,
  onRegister,
  onProfile,
  onSelectOrder,
  onOpenProduct,
  onRelist,
  onNotification,
  onNotice,
  initialTab = "auction",
}: {
  data: MarketData;
  onAction: Action;
  onSelectOffer: (o: Offer) => void;
  onRegister: () => void;
  onProfile: () => void;
  onSelectOrder: (o: Order) => void;
  onOpenProduct: (id: string) => void;
  onRelist: (p: Product, remainder?: number) => void;
  onNotification: (n: Notification) => void;
  onNotice: (text: string) => void;
  initialTab?: string;
}) {
  const [tab, setTab] = useState(initialTab),
    [error, setError] = useState(""),
    [archiveId, setArchiveId] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const userId = data.user?.id;
  const offers = data.offers.filter((o) =>
    tab === "sell" ? o.sellerId === userId : o.buyerId === userId,
  );
  const buy = data.offers.filter((o) => o.buyerId === userId);
  const waiting = buy.filter((o) =>
    ["pending", "countered"].includes(o.status),
  );
  const accepted = buy.filter((o) => o.status === "accepted");
  const myAuctions = data.ownListings.filter((p) => p.saleType === "auction");
  const liveAuctions = myAuctions.filter((p) => p.auction?.status === "active");
  const biddingIds = [...new Set(data.bids.filter((b) => b.mine).map((b) => b.listingId))];
  const bidding = biddingIds
    .map((id) => data.products.find((p) => p.id === id) ?? data.bidListings.find((p) => p.id === id))
    .filter((p): p is Product => !!p);
  const actionOrders = data.orders.filter((o) =>
    (o.buyerId === userId && ["offered", "awaiting_payment", "paid", "shipped"].includes(o.status)) ||
    (o.sellerId === userId && o.status === "paid"),
  );
  const adminPending = data.adminOrders.filter((o) => ["payment_reported", "completed"].includes(o.status)).length + data.deposits.length +
    data.disputes.filter((d) => d.status === "open").length;
  const deciding = data.ownListings.filter((p) => p.auction?.status === "deciding");
  useEffect(() => {
    if (tab === "alerts" && data.unread > 0) void onAction({ action: "read_notifications" }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, data.unread]);
  async function archive() {
    if (!archiveId || busy) return;
    setBusy(true);
    try {
      await onAction({ action: "archive_listing", id: archiveId });
      setArchiveId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dashboard">
      <div className="dashboard-heading">
        <div>
          <span className="eyebrow orange">MY BUSINESS</span>
          <h1>사장님의 거래 현황</h1>
          <p>
            {data.profile?.company || "내 사업자"}의 재고와 매입 제안을 한곳에서
            확인하세요.
          </p>
          {data.profile?.publicAlias && <p>공개 별칭 · <b>{data.profile.publicAlias}</b></p>}
          {data.penalty.due > 0 && (
            <p className="inline-notice warn">
              미납 위약금 {won(data.penalty.due)}원 · 납부가 확인될 때까지 입찰·재고 등록·구매 수락이 제한됩니다. 운영자 계좌로 입금한 뒤 문의해 주세요{data.settings.bankAccount ? ` (${data.settings.bankAccount})` : ""}.
              {data.penalty.viaBusiness && " 같은 사업자등록번호로 등록된 다른 계정의 미납 위약금이 포함되어 있습니다. 내 사업자번호가 아니라면 운영자에게 알려 주세요."}
            </p>
          )}
          {deciding.length > 0 && (
            <p className="inline-notice warn">
              판매 결정이 필요한 경매 {deciding.length}건 · 경매 탭에서 최고 입찰가로 판매할지 정해 주세요.
            </p>
          )}
        </div>
        <Button variant="outline" onClick={onProfile}>
          <UserRound size={16} />
          사업자 정보
        </Button>
      </div>
      <div className="stats-grid">
        <div>
          <span>진행 중인 내 경매 · 입찰</span>
          <b>
            {liveAuctions.length + bidding.filter((p) => p.auction?.status === "active").length}
            <small>건</small>
          </b>
          <Gavel />
        </div>
        <div>
          <span>처리할 주문</span>
          <b>
            {actionOrders.length}
            <small>건</small>
          </b>
          <Receipt />
        </div>
        <div>
          <span>검토 중인 견적</span>
          <b>
            {waiting.length}
            <small>건</small>
          </b>
          <Clock3 />
        </div>
        <div>
          <span>조건 합의 금액</span>
          <b>
            {won(accepted.reduce((s, o) => s + o.price * o.quantity, 0))}
            <small>원</small>
          </b>
          <ShoppingBagIcon />
        </div>
      </div>
      <div className="dashboard-tabs">
        <button className={tab === "auction" ? "selected" : ""} onClick={() => setTab("auction")}>
          경매 <span>{liveAuctions.length + bidding.length}</span>
        </button>
        <button className={tab === "orders" ? "selected" : ""} onClick={() => setTab("orders")}>
          주문·정산 <span>{data.orders.length}</span>
        </button>
        <button className={tab === "alerts" ? "selected" : ""} onClick={() => setTab("alerts")}>
          알림 {data.unread > 0 ? <span className="unread">{data.unread}</span> : <span>{data.notifications.length}</span>}
        </button>
        <button
          className={tab === "buy" ? "selected" : ""}
          onClick={() => setTab("buy")}
        >
          보낸 견적 <span>{buy.length}</span>
        </button>
        <button
          className={tab === "sell" ? "selected" : ""}
          onClick={() => setTab("sell")}
        >
          받은 견적{" "}
          <span>{data.offers.filter((o) => o.sellerId === userId).length}</span>
        </button>
        <button
          className={tab === "stock" ? "selected" : ""}
          onClick={() => setTab("stock")}
        >
          내 재고 <span>{data.ownListings.length}</span>
        </button>
        {data.isAdmin && (
          <button className={`admin-tab ${tab === "admin" ? "selected" : ""}`} onClick={() => setTab("admin")}>
            <ShieldAlert size={14} /> 운영 {adminPending > 0 && <span className="unread">{adminPending}</span>}
          </button>
        )}
      </div>
      <ErrorText error={error} />
      {tab === "auction" ? (
        <AuctionTab mine={myAuctions} bidding={bidding} data={data} onOpenProduct={onOpenProduct} onRelist={onRelist} onRegister={onRegister} />
      ) : tab === "orders" ? (
        <OrderList orders={data.orders} userId={userId} onSelect={onSelectOrder} empty="낙찰이 이루어지면 주문이 이곳에 생깁니다." />
      ) : tab === "alerts" ? (
        <>
          <PushToggle vapidPublicKey={data.settings.vapidPublicKey} onAction={onAction} onNotice={onNotice} />
          <NotificationList notifications={data.notifications} onOpen={onNotification} />
        </>
      ) : tab === "admin" ? (
        <AdminTab data={data} onSelect={onSelectOrder} onAction={onAction} onNotice={onNotice} />
      ) : tab === "stock" ? (
        <>
          {data.ownListings.length === 0 ? (
            <div className="empty">
              <Package size={38} />
              <h3>새로운 기회를 기다리는 재고가 있나요?</h3>
              <p>상품 사진과 판매 조건을 등록해 보세요.</p>
              <Button className="primary" onClick={onRegister}>
                <Plus />첫 재고 등록하기
              </Button>
            </div>
          ) : (
            <div className="trade-list">
              {data.ownListings.map((p) => (
                <div className="trade-row" key={p.id}>
                  <img src={p.image} alt="" />
                  <div className="trade-copy">
                    <span>
                      {p.category} · {p.region}
                    </span>
                    <h3>{p.title}</h3>
                    <p>
                      {won(p.stock)}
                      {p.unit} · 단가 {won(p.price)}원
                    </p>
                  </div>
                  <span className={`status ${p.auction ? `auction-${p.auction.status}` : "accepted"}`}>
                    {p.auction ? auctionStatusLabels[p.auction.status] : daysLeft(p.deadline) < 0 ? "마감" : "등록 완료"}
                  </span>
                  {p.status === "unsold" ? (
                    <Button variant="outline" onClick={() => onRelist(p)}>
                      다시 경매
                    </Button>
                  ) : p.status === "sold" ? (
                    <Button variant="outline" onClick={() => onOpenProduct(p.id)}>
                      낙찰 확인
                    </Button>
                  ) : (
                  <Button
                    variant="outline"
                    disabled={!!p.auction && p.auction.status === "active" && p.auction.bidCount > 0}
                    onClick={() => {
                      setError("");
                      setArchiveId(p.id);
                    }}
                  >
                    <Trash2 size={15} />
                    {p.auction ? "경매 중단" : "판매 종료"}
                  </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : offers.length === 0 ? (
        <div className="empty">
          <MessageCircle size={38} />
          <h3>
            {tab === "sell"
              ? "아직 받은 견적이 없어요"
              : "첫 매입 제안을 기다리고 있어요"}
          </h3>
          <p>
            {tab === "sell"
              ? "등록한 재고에 구매자가 견적을 보내면 이곳에 표시됩니다."
              : "관심 있는 상품에서 수량과 희망 가격을 제안해 보세요."}
          </p>
        </div>
      ) : (
        <div className="trade-list">
          {offers.map((o) => (
            <button
              className="trade-row"
              key={o.id}
              onClick={() => onSelectOffer(o)}
            >
              <img src={o.image} alt="" />
              <div className="trade-copy">
                <span>
                  {new Date(o.createdAt).toLocaleDateString("ko-KR")}
                  {o.sample ? " · 샘플 견적" : ""}
                </span>
                <h3>{o.productTitle}</h3>
                <p>
                  {won(o.quantity)}
                  {o.unit} × {won(o.price)}원 · {o.shipping}
                </p>
              </div>
              <div className="trade-amount">
                <b>{won(o.quantity * o.price)}원</b>
                <span className={`status ${o.status}`}>
                  {statusLabels[o.status]}
                </span>
              </div>
              <ArrowUpRight size={20} />
            </button>
          ))}
        </div>
      )}
      <p className="dashboard-note">
        경매 낙찰 후 입금은 덤핑몰 계좌로 이루어지며, 운영자가 입금을 확인하면 연락처가 공개됩니다. 거래 완료 후 수수료 {Math.round(data.settings.feeRate * 100)}%를 제외하고 정산합니다. 견적 협의는 결제가 아닙니다.
      </p>
      <Modal
        open={!!archiveId}
        onClose={() => setArchiveId(null)}
        title="이 재고의 판매를 종료할까요?"
        description="마켓에서 내려가며, 기존 견적과 대화는 내 거래에 남습니다."
      >
        <ErrorText error={error} />
        <div className="form-actions">
          <Button variant="outline" onClick={() => setArchiveId(null)}>
            계속 판매
          </Button>
          <Button className="primary" disabled={busy} onClick={archive}>
            {busy ? "처리 중…" : "판매 종료"}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
function ShoppingBagIcon() {
  return <Package />;
}
function AuctionTab({
  mine,
  bidding,
  data,
  onOpenProduct,
  onRelist,
  onRegister,
}: {
  mine: Product[];
  bidding: Product[];
  data: MarketData;
  onOpenProduct: (id: string) => void;
  onRelist: (p: Product, remainder?: number) => void;
  onRegister: () => void;
}) {
  if (mine.length === 0 && bidding.length === 0)
    return (
      <div className="empty">
        <Gavel size={38} />
        <h3>아직 참여 중인 경매가 없어요</h3>
        <p>재고를 전량 경매로 등록하거나, 마켓의 경매 상품에 입찰해 보세요.</p>
        <Button className="primary" onClick={onRegister}>
          <Plus />경매로 재고 등록
        </Button>
      </div>
    );
  const row = (p: Product, role: "seller" | "bidder") => {
    const a = p.auction!;
    const myTop = data.bids.filter((b) => b.listingId === p.id && b.mine).reduce((m, b) => Math.max(m, b.amount), 0);
    return (
      <div className="trade-row" key={p.id}>
        <img src={p.image} alt="" />
        <div className="trade-copy">
          <span>
            {role === "seller" ? "내 경매" : "내 입찰"} · {a.bidCount}건 입찰
            {a.status === "active" && <> · <Countdown endsAt={a.endsAt} /></>}
          </span>
          <h3>{p.title}</h3>
          <p>
            {a.mode === "partial"
              ? `${a.cutoffPrice === null ? `시작가 ${won(a.startPrice)}원` : `하한가 ${won(a.cutoffPrice)}원`} · 신청 ${won(a.subscribedQuantity)}/${won(a.quantity)}${a.unit}`
              : `${a.currentPrice === null ? `시작가 ${won(a.startPrice)}원` : `현재 ${won(a.currentPrice)}원`} × ${won(a.quantity)}${a.unit}`}
            {role === "seller" && a.reservePrice !== undefined && ` · 최저 매각가 ${won(a.reservePrice)}원`}
            {role === "seller" && a.status !== "active" && a.mode === "partial" && ` · 낙찰 ${won(a.soldQuantity)}/${won(a.quantity)}${a.unit}`}
            {role === "bidder" && a.mode === "partial" && a.myBid && ` · 내 입찰 ${won(a.myBid.unitPrice)}원 × ${won(a.myBid.quantity)}${a.unit} (${a.myBid.state === "full" ? "전량 예정" : a.myBid.state === "partial" ? `${won(a.myBid.allocated)} 일부` : "낙찰권 밖"})`}
            {role === "bidder" && a.mode !== "partial" && myTop > 0 && ` · 내 입찰 ${won(myTop)}원${a.leading ? " (최고)" : ""}`}
          </p>
          {role === "seller" && a.status === "active" && a.midpointAlertedAt && !a.reserveMet && (
            <p className="row-alert"><TrendingDownIcon /> 절반 경과 · 최저 매각가를 낮춰보세요</p>
          )}
          {role === "seller" && a.status === "deciding" && (
            <p className="row-alert"><TrendingDownIcon /> 최저 매각가 미달로 종료 · {formatDateTime(a.decisionDueAt)}까지 판매 여부를 정해 주세요</p>
          )}
          {a.status === "active" && a.instantPrice !== null && a.mode === "whole" && (
            <p>즉시구매가 {won(a.instantPrice)}원</p>
          )}
        </div>
        <div className="trade-amount">
          <b>{won(a.mode === "partial" ? (a.cutoffPrice ?? a.startPrice) * (a.filledQuantity || a.quantity) : (a.currentPrice ?? a.startPrice) * a.quantity)}원</b>
          <span className={`status auction-${a.status}`}>
            {a.status === "active"
              ? role === "seller" && a.reserveMet ? "낙찰 조건 충족" : role === "bidder" && a.leading ? "최고 입찰 중" : "진행 중"
              : a.status === "deciding" && role === "bidder" ? "판매자 확인 중" : auctionStatusLabels[a.status]}
          </span>
        </div>
        {p.status === "unsold" && role === "seller" ? (
          <Button variant="outline" onClick={() => onRelist(p)}>다시 경매</Button>
        ) : role === "seller" && a.status !== "active" && a.unsoldQuantity > 0 ? (
          <Button variant="outline" onClick={() => onRelist(p, a.unsoldQuantity)}>잔여 {won(a.unsoldQuantity)}{a.unit} 다시 경매</Button>
        ) : (
          <Button variant={role === "seller" && a.status === "deciding" ? "default" : "outline"} className={role === "seller" && a.status === "deciding" ? "primary" : ""} onClick={() => onOpenProduct(p.id)}>
            {a.status === "active" ? "경매장 열기" : role === "seller" && a.status === "deciding" ? "판매 결정하기" : "상세"}
          </Button>
        )}
      </div>
    );
  };
  return (
    <div className="trade-list">
      {mine.map((p) => row(p, "seller"))}
      {bidding.filter((p) => !mine.some((m) => m.id === p.id)).map((p) => row(p, "bidder"))}
    </div>
  );
}
function TrendingDownIcon() {
  return <ArrowRight size={13} style={{ transform: "rotate(45deg)" }} />;
}
export function OrderList({
  orders,
  userId,
  onSelect,
  empty,
}: {
  orders: Order[];
  userId?: string;
  onSelect: (o: Order) => void;
  empty: string;
}) {
  if (orders.length === 0)
    return (
      <div className="empty">
        <Receipt size={38} />
        <h3>아직 주문이 없어요</h3>
        <p>{empty}</p>
      </div>
    );
  return (
    <div className="trade-list">
      {orders.map((o) => {
        const buyer = o.buyerId === userId;
        const needs =
          (buyer && o.status === "awaiting_payment") ||
          (buyer && ["paid", "shipped"].includes(o.status)) ||
          (!buyer && o.sellerId === userId && o.status === "paid");
        return (
          <button className={`trade-row ${needs ? "needs-action" : ""}`} key={o.id} onClick={() => onSelect(o)}>
            <img src={o.image} alt="" />
            <div className="trade-copy">
              <span>
                {formatDateTime(o.createdAt)} · {buyer ? `매입 · 공급자 ${o.sellerAlias}` : o.sellerId === userId ? `판매 · 구매자 ${o.buyerAlias}` : `${o.sellerAlias} → ${o.buyerAlias}`}
              </span>
              <h3>{o.productTitle}</h3>
              <p>
                {won(o.quantity)}
                {o.unit} × {won(o.unitPrice)}원
                {o.status === "awaiting_payment" && ` · 입금 기한 ${formatDateTime(o.paymentDueAt)}`}
              </p>
            </div>
            <div className="trade-amount">
              <b>{won(o.amount)}원</b>
              <span className={`status order-${o.status}`}>{orderStatusLabel(o)}</span>
            </div>
            <ArrowUpRight size={20} />
          </button>
        );
      })}
    </div>
  );
}
function AdminTab({ data, onSelect, onAction, onNotice }: { data: MarketData; onSelect: (o: Order) => void; onAction: Action; onNotice: (text: string) => void }) {
  const [filter, setFilter] = useState("todo");
  const openDisputes = data.disputes.filter((d) => d.status === "open").length + data.disputes.filter((d) => d.penaltyStatus === "due").length;
  const todo = data.adminOrders.filter((o) => ["payment_reported", "completed"].includes(o.status) || (o.refundAmount > o.refundPaid));
  const list = filter === "todo" ? todo : data.adminOrders;
  const gross = data.adminOrders.filter((o) => ["completed", "settled"].includes(o.status)).reduce((s, o) => s + o.amount, 0);
  const fees = data.adminOrders.filter((o) => ["completed", "settled"].includes(o.status)).reduce((s, o) => s + o.fee, 0);
  return (
    <div className="admin-tab">
      <div className="stats-grid admin-stats">
        <div>
          <span>입금 확인 대기 · 미확인 입금</span>
          <b>{data.adminOrders.filter((o) => o.status === "payment_reported").length + data.deposits.length}<small>건</small></b>
          <Bell />
        </div>
        <div>
          <span>정산 대기</span>
          <b>{data.adminOrders.filter((o) => o.status === "completed").length}<small>건</small></b>
          <Receipt />
        </div>
        <div>
          <span>완료 거래액</span>
          <b>{won(gross)}<small>원</small></b>
          <Package />
        </div>
        <div>
          <span>누적 수수료</span>
          <b>{won(fees)}<small>원</small></b>
          <ShieldCheck />
        </div>
      </div>
      <div className="dashboard-tabs sub">
        <button className={filter === "todo" ? "selected" : ""} onClick={() => setFilter("todo")}>처리 필요 <span>{todo.length}</span></button>
        <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>전체 주문 <span>{data.adminOrders.length}</span></button>
        <button className={filter === "deposits" ? "selected" : ""} onClick={() => setFilter("deposits")}>입금 관리 {data.deposits.length > 0 ? <span className="unread">{data.deposits.length}</span> : <span>0</span>}</button>
        <button className={filter === "disputes" ? "selected" : ""} onClick={() => setFilter("disputes")}>
          분쟁·위약금 {openDisputes > 0 ? <span className="unread">{openDisputes}</span> : <span>0</span>}
        </button>
        <button className={filter === "fraud" ? "selected" : ""} onClick={() => setFilter("fraud")}>
          부정거래 {data.fraud.length > 0 ? <span className="unread">{data.fraud.length}</span> : <span>0</span>}
        </button>
        <button className={filter === "revenue" ? "selected" : ""} onClick={() => setFilter("revenue")}>매출·수수료</button>
      </div>
      {filter === "revenue" ? (
        <RevenuePanel data={data} />
      ) : filter === "disputes" ? (
        <AdminDisputePanel data={data} onAction={onAction} onNotice={onNotice} onSelectOrder={onSelect} />
      ) : filter === "fraud" ? (
        <FraudPanel data={data} onAction={onAction} onNotice={onNotice} />
      ) : filter === "deposits" ? (
        <DepositPanel data={data} onAction={onAction} onNotice={onNotice} onSelectOrder={onSelect} />
      ) : (
        <OrderList orders={list} userId={data.user?.id} onSelect={onSelect} empty="입금 신고나 인수 완료가 들어오면 여기서 처리합니다." />
      )}
    </div>
  );
}
function RevenuePanel({ data }: { data: MarketData }) {
  const r = data.revenue;
  const fee = data.settings.feeTable;
  return (
    <div className="revenue-panel">
      <div className="fee-table">
        <b>적용 중인 수수료율</b>
        <p>
          기본 <strong>{fee ? fee.base / 100 : data.settings.feeRate * 100}%</strong>
          {fee && Object.keys(fee.overrides).length > 0 && (
            <> · 카테고리별 {Object.entries(fee.overrides).map(([k, v]) => `${k} ${v / 100}%`).join(", ")}</>
          )}
        </p>
        <small>Vercel 환경 변수 PLATFORM_FEE_RATE(기본), PLATFORM_FEE_RATES(카테고리별 JSON)로 바꾸고 재배포하면 이후 낙찰부터 적용됩니다. 이미 생긴 주문의 수수료는 바뀌지 않습니다.</small>
      </div>
      {r && (
        <div className="stats-grid admin-stats">
          <div><span>누적 낙찰액 (GMV)</span><b>{won(r.total.gmv)}<small>원</small></b><Package /></div>
          <div><span>확정 수수료 (매출)</span><b>{won(r.total.fee)}<small>원</small></b><ShieldCheck /></div>
          <div><span>보유 예치금 (정산 전)</span><b>{won(r.total.held)}<small>원</small></b><Receipt /></div>
          <div><span>정산 지급 예정</span><b>{won(r.total.payable)}<small>원</small></b><Bell /></div>
        </div>
      )}
      {r && (
        <div className="stats-grid admin-stats">
          <div><span>위약금 수령</span><b>{won(r.extras.penaltiesCollected)}<small>원</small></b><ShieldCheck /></div>
          <div><span>위약금 미납</span><b>{won(r.extras.penaltiesDue)}<small>원</small></b><Bell /></div>
          <div><span>보낼 환불</span><b>{won(r.extras.refundsPending)}<small>원</small></b><Receipt /></div>
          <div><span>보낸 환불</span><b>{won(r.extras.refundsPaid)}<small>원</small></b><Package /></div>
        </div>
      )}
      <div className="table-scroll">
        <table className="revenue-table">
          <thead>
            <tr><th>월</th><th>낙찰 건</th><th>낙찰액</th><th>입금 확인액</th><th>수수료</th><th>정산 예정</th><th>정산 완료</th><th>취소</th><th>CSV</th></tr>
          </thead>
          <tbody>
            {(r?.months ?? []).length === 0 && (
              <tr><td colSpan={9} className="revenue-empty">아직 낙찰 주문이 없습니다. 첫 낙찰이 생기면 월별로 집계됩니다.</td></tr>
            )}
            {(r?.months ?? []).map((m) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                <td>{m.orders}</td>
                <td>{won(m.gmv)}</td>
                <td>{won(m.paid)}</td>
                <td><b>{won(m.fee)}</b></td>
                <td>{won(m.payable)}</td>
                <td>{won(m.settled)}</td>
                <td>{m.cancelled}</td>
                <td><a href={`/api/admin/orders?month=${m.month}`} download>내려받기</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dashboard-note">
        수수료는 구매자가 인수 완료를 눌러 거래가 완료된 시점에 확정됩니다. 낙찰액은 취소와 차순위 제안(수락 전)을 제외한 주문 총액, 보유 예치금은 입금 확인 후 아직 정산하지 않은 금액입니다. <a className="text-link" href="/api/admin/orders" download>전체 주문 CSV 내려받기</a>
      </p>
    </div>
  );
}
export function Conversation({
  offer: o,
  data,
  onAction,
}: {
  offer: Offer;
  data: MarketData;
  onAction: Action;
}) {
  const [body, setBody] = useState(""),
    [counter, setCounter] = useState(o.price),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const isSeller = o.sellerId === data.user?.id;
  const messages = data.messages.filter((m) => m.offerId === o.id);
  const current = data.offers.find((v) => v.id === o.id) || o;
  const open = ["pending", "countered"].includes(current.status);
  async function run(action: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
      if (action.action === "message") setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="conversation">
      <div className="conversation-product">
        <img src={o.image} alt="" />
        <div>
          <b>{o.productTitle}</b>
          <p>
            {won(o.quantity)}
            {o.unit} · {o.shipping}
          </p>
        </div>
        <span className={`status ${current.status}`}>
          {statusLabels[current.status]}
        </span>
      </div>
      <div className="offer-summary">
        <div>
          <span>현재 제안 단가</span>
          <b>{won(current.price)}원</b>
        </div>
        <div>
          <span>상품 금액</span>
          <b>{won(current.price * o.quantity)}원</b>
        </div>
      </div>
      <p className="offer-note">{o.note || "별도 요청사항 없음"}</p>
      {!!o.sample && (
        <p className="inline-notice">
          샘플 상품의 대화 기록입니다. 실제 공급자에게 전달되지 않으며 자동
          답변은 없습니다.
        </p>
      )}
      {current.status === "accepted" && (
        <p className="inline-notice">
          매입 조건에 합의했습니다. 실제 주문이나 재고 확보는 진행되지 않습니다.
        </p>
      )}
      {open && (
        <div className="negotiation-actions">
          {isSeller ? (
            <>
              <div className="counter-field">
                <label>
                  재제안 단가 (원)
                  <input
                    type="number"
                    min="1"
                    max="100000000"
                    value={counter}
                    onChange={(e) => setCounter(Number(e.target.value))}
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={busy || !Number.isInteger(counter) || counter < 1}
                  onClick={() =>
                    run({
                      action: "respond",
                      id: o.id,
                      response: "counter",
                      price: counter,
                    })
                  }
                >
                  가격 재제안
                </Button>
              </div>
              <div className="form-actions">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run({ action: "respond", id: o.id, response: "reject" })
                  }
                >
                  제안 거절
                </Button>
                {current.status === "pending" && (
                  <Button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      run({ action: "respond", id: o.id, response: "accept" })
                    }
                  >
                    제안 수락
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="form-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run({ action: "respond", id: o.id, response: "cancel" })
                }
              >
                요청 취소
              </Button>
              {current.status === "countered" && (
                <Button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    run({
                      action: "respond",
                      id: o.id,
                      response: "accept_counter",
                    })
                  }
                >
                  재제안 수락
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <div className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="message-empty">
            <MessageCircle size={24} />
            <p>상품 상태와 인수 조건을 대화로 확인하세요.</p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              className={`message ${m.authorId === data.user?.id ? "mine" : ""}`}
              key={m.id}
            >
              <span>{m.authorId === data.user?.id ? "나" : (isSeller ? current.buyerAlias : current.sellerAlias) || "거래 상대"}</span>
              <p>{m.body}</p>
              <time>
                {new Date(m.createdAt).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
          ))
        )}
      </div>
      <ErrorText error={error} />
      <form
        className="message-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) void run({ action: "message", offerId: o.id, body });
        }}
      >
        <input
          aria-label="거래 메시지"
          placeholder="거래에 관해 궁금한 점을 남겨주세요"
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          className="primary"
          disabled={busy || !body.trim()}
          aria-label="메시지 보내기"
        >
          <Send size={18} />
        </Button>
      </form>
    </div>
  );
}
