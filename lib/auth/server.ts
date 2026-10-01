import "server-only";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import { getSocialSession } from "./social";

let instance: ReturnType<typeof createNeonAuth> | undefined;
export function getAuth() {
  if (!instance) {
    const baseUrl = process.env.NEON_AUTH_BASE_URL;
    const secret = process.env.NEON_AUTH_COOKIE_SECRET;
    if (!baseUrl || !secret) throw new Error("Authentication is not configured");
    instance = createNeonAuth({ baseUrl, cookies: { secret } });
  }
  return instance;
}
export async function getUser() {
  const social = await getSocialSession();
  if (social?.user?.id) return {
    userId: social.user.id,
    displayName: social.user.name || "사장님",
    email: social.user.email || "",
  };
  const { data } = await getAuth().getSession();
  const user = data?.user;
  return user ? { userId: user.id, displayName: user.name || user.email, email: user.email } : null;
}
