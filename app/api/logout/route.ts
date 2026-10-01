import { getAuth } from "@/lib/auth/server";
import { socialSignOut } from "@/lib/auth/social";
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "허용되지 않은 요청입니다." }, { status: 403 });
  await getAuth().signOut();
  await socialSignOut({ redirect: false });
  return Response.redirect(new URL("/", request.url), 303);
}
