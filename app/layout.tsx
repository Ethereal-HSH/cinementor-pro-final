import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LinguaFlow Pro",
  description: "沉浸式外刊精读与学术拆解平台"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="bg-paper text-ink">{children}</body>
    </html>
  );
}
