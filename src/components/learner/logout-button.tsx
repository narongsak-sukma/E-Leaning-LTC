/**
 * LogoutButton — ปุ่มออกจากระบบ (learner shell)
 *
 * POST /api/v1/auth/logout (fetch same-origin — browser แนบ Origin/Sec-Fetch-Site ให้เอง
 * จึงผ่าน middleware CSRF เอง) แล้วเปลี่ยนไป /login · แม้ 401 (ไม่มี session) ก็ยังไป /login
 * เพราะเป้าหมายปลายทางเดียวกัน · ใช้ full navigation เพื่อไม่ค้าง RSC cache ของหน้าเดิม
 */
"use client";

import { useState } from "react";

import { logout } from "@/lib/fixtures/learning";

export function LogoutButton({ className }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const handleClick = async () => {
    setPending(true);
    try {
      await logout();
    } catch {
      // 401 (ไม่มี session) / 500 — ปลายทางคือ /login เหมือนกัน จึงไม่บล็อกผู้เรียน
    }
    window.location.assign("/login");
  };

  return (
    <button
      type="button"
      onClick={() => {
        void handleClick();
      }}
      disabled={pending}
      className={className ?? "rounded-[8px] px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"}
    >
      {pending ? "กำลังออกจากระบบ..." : "ออกจากระบบ"}
    </button>
  );
}
