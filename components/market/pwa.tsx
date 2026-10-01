"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Smartphone, Check, Share2, PlusSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
function subscribeNetwork(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}
function subscribeDisplayMode(notify: () => void) {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
export function usePwa() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null),
    [installed, setInstalled] = useState(false),
    [workerError, setWorkerError] = useState(false);
  const offline = useSyncExternalStore(subscribeNetwork, () => !navigator.onLine, () => false);
  const standalone = useSyncExternalStore(subscribeDisplayMode, () => window.matchMedia("(display-mode: standalone)").matches, () => false);
  useEffect(() => {
    const before = (e: Event) => {
        e.preventDefault();
        setPrompt(e as InstallEvent);
      },
      done = () => {
        setInstalled(true);
        setPrompt(null);
      };
    window.addEventListener("beforeinstallprompt", before);
    window.addEventListener("appinstalled", done);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => setWorkerError(true));
    return () => {
      window.removeEventListener("beforeinstallprompt", before);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const r = await prompt.userChoice;
    setPrompt(null);
    if (r.outcome === "accepted") setInstalled(true);
  }
  return { canInstall: !!prompt, installed: installed || standalone, offline, workerError, install };
}
export function InstallInstructions({
  pwa,
}: {
  pwa: ReturnType<typeof usePwa>;
}) {
  return (
    <div className="install-content">
      <img src="/icons/icon-192.png" alt="덤핑몰 앱 아이콘" />
      <h3>필요한 재고, 한 번에 찾아보세요.</h3>
      <p>
        홈 화면에 덤핑몰을 추가하면
        <br />
        앱처럼 빠르게 열 수 있습니다.
      </p>
      {pwa.installed ? (
        <div className="installed">
          <Check />
          앱으로 실행 중입니다.
        </div>
      ) : pwa.canInstall ? (
        <Button className="primary" onClick={pwa.install}>
          <Download />
          덤핑몰 설치하기
        </Button>
      ) : (
        <div className="install-steps">
          <div>
            <Smartphone size={21} />
            <p>
              <b>iPhone · iPad</b>
              <span>
                Safari의 공유 <Share2 size={13} /> 메뉴 → 홈 화면에 추가
              </span>
            </p>
          </div>
          <div>
            <PlusSquare size={21} />
            <p>
              <b>Android · PC</b>
              <span>Chrome 메뉴 → 앱 설치 또는 홈 화면에 추가</span>
            </p>
          </div>
        </div>
      )}
      <small>브라우저와 기기에 따라 설치 메뉴가 다를 수 있습니다.</small>
      {pwa.workerError && (
        <p className="form-error">
          오프라인 기능을 준비하지 못했습니다. 온라인에서 새로고침해 주세요.
        </p>
      )}
    </div>
  );
}
