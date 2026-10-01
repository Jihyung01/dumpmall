import Login from "@/components/market/login";
import { socialProviders } from "@/lib/auth/social";
export const dynamic = "force-dynamic";
export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <Login providers={socialProviders} socialError={Boolean(error)} />;
}
