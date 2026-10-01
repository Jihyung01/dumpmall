"use client";
import { useEffect, useState } from "react";
import { BellRing, BellOff, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Action } from "./flows";
function toKey(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
type State = "unsupported" | "ios-install" | "denied" | "off" | "on" | "busy";
// One toggle that mirrors the browser's real subscription state. Push is
// optional: the in-app feed works without it.
// Best-effort device unsubscribe used on logout (bounded so logout never hangs).
export async function unsubscribePush(onAction?: Action) {
  const work = (async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    if (onAction) await onAction({ action: "push_unsubscribe", endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe();
  })();
  await Promise.race([work, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
}
export function PushToggle({ vapidPublicKey, onAction, onNotice, compact = false }: {
  vapidPublicKey: string;
  onAction: Action;
  onNotice: (text: string) => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<State>("busy");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        if (!cancelled) setState(ios && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setState("denied");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (!cancelled) setState(existing ? "on" : "off");
    })().catch(() => !cancelled && setState("unsupported"));
    return () => {
      cancelled = true;
    };
  }, []);
  async function enable() {
    setState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(vapidPublicKey) }));
      const json = subscription.toJSON();
      await onAction({
        action: "push_subscribe",
        subscription: { endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent.slice(0, 300) },
      });
      setState("on");
      onNotice("이 기기로 입찰·낙찰·입금 알림을 보냅니다.");
    } catch (e) {
      setState("off");
      onNotice(e instanceof Error ? e.message : "알림을 켜지 못했습니다.");
    }
  }
  async function disable() {
    setState("busy");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await onAction({ action: "push_unsubscribe", endpoint: subscription.endpoint }).catch(() => {});
        await subscription.unsubscribe();
      }
      setState("off");
      onNotice("이 기기의 푸시 알림을 껐습니다.");
    } catch {
      setState("on");
    }
  }
  if (!vapidPublicKey)
    return compact ? null : (
      <div className="push-box muted">
        <BellOff size={18} />
        <div>
          <b>기기 푸시 알림 준비 중</b>
          <p>운영자가 VAPID 키를 설정하면 앱을 닫아도 알림을 받을 수 있습니다. 지금은 이 화면의 알림 목록으로 확인해 주세요.</p>
        </div>
      </div>
    );
  if (compact && (state === "on" || state === "busy" || state === "unsupported")) return null;
  return (
    <div className={`push-box ${state === "on" ? "on" : ""} ${compact ? "compact" : ""}`}>
      {state === "on" ? <BellRing size={18} /> : state === "ios-install" ? <Smartphone size={18} /> : <BellOff size={18} />}
      <div>
        <b>
          {state === "on" && "이 기기로 푸시 알림을 받고 있어요"}
          {state === "off" && "앱을 닫아도 알림 받기"}
          {state === "busy" && "알림 상태 확인 중…"}
          {state === "denied" && "브라우저에서 알림이 차단되어 있어요"}
          {state === "ios-install" && "iPhone은 홈 화면에 추가한 뒤 알림을 켤 수 있어요"}
          {state === "unsupported" && "이 브라우저는 푸시 알림을 지원하지 않아요"}
        </b>
        <p>
          {state === "denied"
            ? "주소창 왼쪽 자물쇠 → 알림 → 허용으로 바꾼 뒤 다시 시도해 주세요."
            : state === "ios-install"
              ? "Safari 공유 메뉴 → 홈 화면에 추가 → 추가된 앱에서 알림을 켜 주세요."
              : "입찰, 낙찰, 입금 확인, 정산 소식을 기기 알림으로 보냅니다."}
        </p>
      </div>
      {state === "off" && (
        <Button className="primary" onClick={enable}>
          알림 켜기
        </Button>
      )}
      {state === "on" && (
        <Button variant="outline" onClick={disable}>
          끄기
        </Button>
      )}
    </div>
  );
}
