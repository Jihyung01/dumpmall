import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "덤핑몰 — 재고의 다음 기회",
  description:
    "필요한 재고는 합리적으로, 남은 재고는 빠르게. 사업자를 위한 B2B 재고 거래 플랫폼 덤핑몰.",
  icons: { icon: "/favicon.svg", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "덤핑몰" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f26037",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="manifest"
          href="/manifest.webmanifest"
          crossOrigin="use-credentials"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
