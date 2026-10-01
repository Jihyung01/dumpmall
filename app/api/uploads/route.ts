import { getUser } from "@/lib/auth/server";
import { bucket } from "@/db";
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("x-dumping-client") !== "1" ||
      (request.headers.get("origin") &&
        request.headers.get("origin") !== new URL(request.url).origin)
    )
      return Response.json(
        { error: "허용되지 않은 요청입니다." },
        { status: 403 },
      );
    const user = await getUser();
    if (!user)
      return Response.json(
        { error: "로그인 후 사진을 올려주세요." },
        { status: 401 },
      );
    if (Number(request.headers.get("content-length")) > 4 * 1024 * 1024)
      return Response.json(
        { error: "사진은 3MB 이하로 올려주세요." },
        { status: 413 },
      );
    const form = await request.formData(),
      file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size > 3 * 1024 * 1024 ||
      file.size < 12
    )
      return Response.json(
        { error: "3MB 이하의 JPG, PNG, WebP 사진을 선택해 주세요." },
        { status: 400 },
      );
    const bytes = await file.arrayBuffer(),
      b = new Uint8Array(bytes);
    let type = "";
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) type = "image/jpeg";
    if (
      b[0] === 137 &&
      b[1] === 80 &&
      b[2] === 78 &&
      b[3] === 71 &&
      b[4] === 13 &&
      b[5] === 10 &&
      b[6] === 26 &&
      b[7] === 10
    )
      type = "image/png";
    if (
      String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.slice(8, 12)) === "WEBP"
    )
      type = "image/webp";
    if (!type)
      return Response.json(
        { error: "JPG, PNG, WebP 형식만 사용할 수 있습니다." },
        { status: 400 },
      );
    const id = crypto.randomUUID();
    await bucket().put(id, bytes, {
      httpMetadata: { contentType: type },
      customMetadata: { owner: user.userId },
    });
    return Response.json(
      { url: `/api/images/${id}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "사진을 업로드하지 못했습니다. 다시 시도해 주세요." },
      { status: 503 },
    );
  }
}
