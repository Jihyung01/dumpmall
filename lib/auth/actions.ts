"use server";
import { socialProviders, socialSignIn, socialSignOut } from "./social";
import { getAuth } from "./server";

export async function startSocialLogin(provider: string) {
  if (!socialProviders.some(p => p.id === provider && p.ready)) return;
  await getAuth().signOut();
  await socialSignIn(provider, { redirectTo: "/" });
}
export async function clearSocialSession() {
  await socialSignOut({ redirect: false });
}
