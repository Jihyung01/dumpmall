import "server-only";
import { createHash, createHmac } from "node:crypto";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Kakao from "next-auth/providers/kakao";
import Naver from "next-auth/providers/naver";

export const socialProviders = [
  { id: "google", name: "구글", ready: process.env.AUTH_GOOGLE_ENABLED === "true" && Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) },
  { id: "kakao", name: "카카오", ready: process.env.AUTH_KAKAO_ENABLED === "true" && Boolean(process.env.AUTH_KAKAO_ID && process.env.AUTH_KAKAO_SECRET) },
  { id: "naver", name: "네이버", ready: process.env.AUTH_NAVER_ENABLED === "true" && Boolean(process.env.AUTH_NAVER_ID && process.env.AUTH_NAVER_SECRET) },
] as const;

const configuredProviders = [
  Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET, checks: ["pkce", "state"] }),
  Kakao({ clientId: process.env.AUTH_KAKAO_ID, clientSecret: process.env.AUTH_KAKAO_SECRET, checks: ["state"] }),
  Naver({ clientId: process.env.AUTH_NAVER_ID, clientSecret: process.env.AUTH_NAVER_SECRET, checks: ["state"] }),
].filter(provider => socialProviders.some(p => p.id === provider.id && p.ready));
// Domain separation keeps social JWT encryption independent of Neon cookies.
const secret = process.env.AUTH_SECRET || (process.env.NEON_AUTH_COOKIE_SECRET
  ? createHmac("sha256", process.env.NEON_AUTH_COOKIE_SECRET).update("dumpmall-social-auth-v1").digest("hex")
  : undefined);

export const { handlers, auth: getSocialSession, signIn: socialSignIn, signOut: socialSignOut } = NextAuth({
  basePath: "/api/social-auth",
  secret,
  trustHost: true,
  providers: configuredProviders,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        // Provider IDs are authoritative. Email addresses never merge accounts.
        token.sub = `social:${account.provider}:${createHash("sha256").update(account.providerAccountId).digest("hex")}`;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
