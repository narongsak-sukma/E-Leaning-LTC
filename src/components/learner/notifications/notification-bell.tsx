/**
 * NotificationBell — ไอคอนกระดิ่ง + ป้ายเลขไม่อ่านบน header ของ learner shell (NTF-001 · lane D)
 *
 * - client component — fetch GET /api/v1/me/notifications?limit=1 ตอน mount + ทุก 60 วินาที
 *   (อ่าน unread_count จาก payload เดียวกับรายการ — ไม่มีเส้นแยกตาม contract ของ lane B)
 * - ป้ายเลข: > 0 แสดง · เกิน 99 = "99+" · 0 หรือยังโหลดไม่ได้ = ซ่อนป้าย (กระดิ่งยังอยู่ —
 *   BFF ยังไม่ deploy ใน dev ก็ไม่ crash ไม่ noise)
 * - ลิงก์ไป /my/notifications (full navigation ผ่าน next/link — RSC cache ของหน้า inbox
 *   สร้างใหม่ทุกครั้ง ผู้ใช้เห็นรายการล่าสุดเสมอ)
 * - ไอคอน inline SVG แบบเดียวกับ src/components/course/icons.tsx (DS §5.14 · stroke 1.8)
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { NOTIF_READ_CHANGED_EVENT, getMyNotifications, type TransportCallOptions } from "./api";

/** รอบดึงเลขไม่อ่าน — 60 วินาที ตามสัญญาของ lane D */
export const UNREAD_POLL_INTERVAL_MS = 60_000;

/** เพดานป้ายเลข — เกินแสดง "99+" */
export const UNREAD_BADGE_MAX = 99;

/** ป้ายเลขไม่อ่าน — null = ซ่อนป้าย (0 รายการ หรือยังไม่มีค่า) */
export function badgeLabelOf(unreadCount: number | null): string | null {
  if (unreadCount === null || unreadCount <= 0) {
    return null;
  }
  if (unreadCount > UNREAD_BADGE_MAX) {
    return "99+";
  }
  return String(unreadCount);
}

/** โหลดเลขไม่อ่าน — limit=1 เพื่อ payload เล็กสุด (items ไม่ถูกใช้) · ล้ม → ApiError ตาม transport */
export async function loadUnreadCount(options?: TransportCallOptions): Promise<number> {
  const page = await getMyNotifications({ limit: 1 }, options);
  return page.unread_count;
}

/** ไอคอนกระดิ่ง (Lucide "bell" — stroke 1.8 · currentColor · aria-hidden ตาม DS §5.14) */
function BellIcon() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** ป้าย aria ของปุ่มกระดิ่ง — มีเลข = บอกจำนวน (screen reader รับรู้โดยไม่ต้องเห็นป้าย) */
export function bellAriaLabel(unreadCount: number | null): string {
  const label = badgeLabelOf(unreadCount);
  return label === null
    ? "การแจ้งเตือน"
    : `การแจ้งเตือน — ยังไม่ได้อ่าน ${unreadCount ?? 0} รายการ`;
}

export function NotificationBell() {
  /** null = ยังไม่รู้ค่า (กำลังโหลด/ดึงไม่สำเร็จ) — ซ่อนป้ายทั้งกรณี */
  const [unreadCount, setUnreadCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void loadUnreadCount()
        .then((count) => {
          if (alive) {
            setUnreadCount(count);
          }
        })
        .catch(() => {
          if (alive) {
            setUnreadCount(null);
          }
        });
    };
    refresh();
    // หน้า inbox ยิง event นี้หลังอ่านสำเร็จ — ป้ายรีเฟรชทันที ไม่ต้องรอรอบ poll
    window.addEventListener(NOTIF_READ_CHANGED_EVENT, refresh);
    const timer = setInterval(refresh, UNREAD_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.removeEventListener(NOTIF_READ_CHANGED_EVENT, refresh);
      clearInterval(timer);
    };
  }, []);

  const label = badgeLabelOf(unreadCount);

  return (
    <Link
      href="/my/notifications"
      data-testid="bell-button"
      aria-label={bellAriaLabel(unreadCount)}
      className="relative inline-flex items-center justify-center rounded-[8px] p-2 text-brand-700 hover:bg-brand-50"
    >
      <BellIcon />
      {label !== null ? (
        <span
          data-testid="bell-count"
          className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger-600 px-1 py-px text-[10px] font-bold leading-none text-white"
        >
          {label}
        </span>
      ) : null}
    </Link>
  );
}
