import { bucket } from "@/db";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id))
    return new Response("Not found", { status: 404 });
  try {
    const object = await bucket().get(id);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "public,max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Image unavailable", { status: 503 });
  }
}
