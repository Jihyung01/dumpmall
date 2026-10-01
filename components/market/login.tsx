"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { ArrowRight, Mail } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { startSocialLogin, clearSocialSession } from "@/lib/auth/actions";

function SocialButton({ provider, busy }: { provider: {id: string; name: string; ready: boolean}; busy: boolean }) {
  const { pending } = useFormStatus();
  return <button className={`social-login social-${provider.id}`} disabled={!provider.ready || busy || pending}>
    {pending ? "연결 중…" : `${provider.name}로 시작하기`}
    {!provider.ready && <small>준비 중</small>}
  </button>;
}

export default function Login({ providers, socialError }: {
  providers: readonly { id: string; name: string; ready: boolean }[];
  socialError: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(socialError ? "간편 로그인을 완료하지 못했습니다. 다시 시도하거나 이메일로 로그인해 주세요." : "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (!sent) {
        const result = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
        if (result.error) throw new Error("인증번호를 보내지 못했습니다. 이메일을 확인하고 잠시 후 다시 시도해 주세요.");
        setSent(true);
      } else {
        const result = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
        if (result.error) throw new Error("인증번호가 올바르지 않거나 만료됐습니다. 다시 확인해 주세요.");
        await clearSocialSession();
        router.push("/");
        router.refresh();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "연결을 확인하고 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  return <main className="auth-page">
    <Link href="/" className="auth-logo">덤핑몰<span>DUMPING MALL</span></Link>
    <section className="auth-card">
      <div className="auth-icon"><Mail size={28} /></div>
      <p className="auth-eyebrow">YOUR NEXT OPPORTUNITY</p>
      <h1>{sent ? "이메일을 확인해 주세요" : "사장님의 다음 거래를 시작하세요"}</h1>
      <p>{sent ? `${email}로 보낸 인증번호를 입력해 주세요.` : "이메일 인증으로 간편하게 시작하세요. 처음 방문하셨다면 계정이 만들어집니다."}</p>
      {!sent && <>
        <div className="social-logins" aria-label="간편 로그인">
          {providers.map(provider => <form key={provider.id} action={startSocialLogin.bind(null, provider.id)}>
            <SocialButton provider={provider} busy={busy} />
          </form>)}
        </div>
        <div className="auth-divider">또는 이메일로 시작하기</div>
      </>}
      <form onSubmit={submit}>
        {!sent ? <label>이메일<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" required maxLength={254} /></label>
          : <label>인증번호<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="이메일의 인증번호" required minLength={6} maxLength={8} autoFocus /></label>}
        {error && <p role="alert" className="auth-error">{error}</p>}
        <button className="auth-submit" disabled={busy}>{busy ? "처리 중…" : sent ? "로그인" : "인증번호 받기"}<ArrowRight size={18} /></button>
        {sent && <button type="button" className="auth-back" disabled={busy} onClick={() => { setSent(false); setCode(""); setError(""); }}>이메일 변경 / 인증번호 다시 받기</button>}
      </form>
      <div className="auth-note">상품은 로그인 없이 둘러볼 수 있어요.<br />사업자 정보는 로그인 후 별도로 등록합니다.<br />로그인 수단이 다르면 별도 계정으로 가입됩니다.</div>
      <Link href="/" className="auth-back">재고 마켓으로 돌아가기</Link>
    </section>
  </main>;
}
