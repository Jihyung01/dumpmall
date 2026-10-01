import { getUser } from "@/lib/auth/server";
import { query } from "@/db";
import { adminIds } from "@/lib/auction-core";
export const dynamic = "force-dynamic";
// Admin-only CSV export of every order for bookkeeping (Excel-friendly UTF-8 BOM).
const columns = [
  ["id", "주문번호"],
  ["created_at", "낙찰일시"],
  ["status", "상태"],
  ["product_title", "상품"],
  ["seller_alias", "공급자 별칭"],
  ["seller_company", "공급자 상호"],
  ["buyer_alias", "구매자 별칭"],
  ["buyer_company", "구매자 상호"],
  ["quantity", "수량"],
  ["unit", "단위"],
  ["unit_price", "낙찰 단가"],
  ["amount", "낙찰 총액"],
  ["fee_rate", "수수료율(bp)"],
  ["fee", "수수료"],
  ["net", "정산액"],
  ["depositor", "입금자명"],
  ["reported_at", "입금 신고"],
  ["paid_at", "입금 확인"],
  ["shipped_at", "출고"],
  ["completed_at", "인수 완료"],
  ["settled_at", "정산 완료"],
  ["cancelled_at", "취소"],
  ["cancel_reason", "취소 사유"],
] as const;
function cell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at the start).
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export async function GET(request: Request) {
  const user = await getUser();
  if (!user || !adminIds().includes(user.userId))
    return Response.json({ error: "운영자만 내려받을 수 있습니다." }, { status: 403 });
  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  if (month && !/^\d{4}-\d{2}$/.test(month))
    return Response.json({ error: "month는 YYYY-MM 형식입니다." }, { status: 400 });
  const rows = await query<Record<string, unknown>>(
    `SELECT o.*,
       (SELECT public_alias FROM profiles WHERE user_id=o.seller_id) AS seller_alias,
       (SELECT company FROM profiles WHERE user_id=o.seller_id) AS seller_company,
       (SELECT public_alias FROM profiles WHERE user_id=o.buyer_id) AS buyer_alias,
       (SELECT company FROM profiles WHERE user_id=o.buyer_id) AS buyer_company
     FROM orders o
     WHERE $1::text IS NULL OR to_char((o.created_at::timestamptz) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') = $1
     ORDER BY o.created_at DESC LIMIT 5000`,
    [month],
  );
  const lines = [columns.map((c) => c[1]).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c[0]])).join(","));
  const name = `dumpmall-orders${month ? `-${month}` : ""}.csv`;
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
