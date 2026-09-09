import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย",
  description:
    "ระบบฝึกอบรมออนไลน์อย่างเป็นทางการของสภาทนายความแห่งประเทศไทย — หลักสูตรออนไลน์ การสอบรับประกาศนียบัตร และธนาคารหน่วยกิต (Credit Bank)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* ใช้ <link> แทน next/font เพื่อไม่ให้ build ต้องยิง network หา fonts.googleapis.com
            (DESIGN-SYSTEM §3.1) — ปิด warning ที่ออกแบบมาสำหรับ Pages Router */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Sarabun:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-dvh bg-mist-50 font-sans text-ink-700 antialiased">
        {children}
      </body>
    </html>
  );
}
