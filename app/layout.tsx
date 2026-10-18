import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "LTC E-Learning — ระบบอีเลิร์นนิ่ง สภาทนายความแห่งประเทศไทย",
  description:
    "ระบบฝึกอบรมออนไลน์ สอบรับประกาศนียบัตร และธนาคารหน่วยกิต (Credit Bank) สภาทนายความแห่งประเทศไทย พร้อมพอร์ทัลผู้เรียน (Frontoffice) และระบบบริหารจัดการสำหรับเจ้าหน้าที่ (Backoffice)",
  openGraph: {
    title: "LTC E-Learning — ระบบอีเลิร์นนิ่ง สภาทนายความแห่งประเทศไทย",
    description:
      "ระบบฝึกอบรมออนไลน์ สอบรับประกาศนียบัตร และธนาคารหน่วยกิต (Credit Bank) สภาทนายความแห่งประเทศไทย",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LTC E-Learning — ระบบอีเลิร์นนิ่ง สภาทนายความแห่งประเทศไทย",
    description:
      "ระบบฝึกอบรมออนไลน์ สอบรับประกาศนียบัตร และธนาคารหน่วยกิต (Credit Bank) สภาทนายความแห่งประเทศไทย",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Sarabun:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning className="min-h-dvh bg-mist-50 font-sans text-ink-700 antialiased">
        {children}
      </body>
    </html>
  );
}
