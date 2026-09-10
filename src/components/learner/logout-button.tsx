/**
 * LogoutButton — ปุ่มออกจากระบบ (learner shell)
 *
 * POST /api/v1/auth/logout (fetch same-origin — browser แนบ Origin/Sec-Fetch-Site ให้เอง
 * จึงผ่าน middleware CSRF เอง) · เปลี่ยนไป /login เฉพาะเมื่อยืนยันสำเร็จแล้ว
 * (204) หรือ 401 (ไม่มี session อยู่แล้ว — ปลายทางเดียวกัน) — กรณีอื่น (network/5xx)
 * ต้องแสดงว่าออกไม่สำเร็จและให้ลองใหม่ ห้ามเดินหน้าเหมือนสำเร็จ เพราะ session ยังใช้ได้
 * (gate r3: ผู้ใช้เครื่องร่วมจะเข้าใจผิดว่าออกจากระบบแล้ว)
 * ใช้ full navigation เพื่อไม่ค้าง RSC cache ของหน้าเดิม
 */
"use client";

import { useState } from "react";

import { ApiError, logout } from "@/lib/fixtures/learning";

export function LogoutButton({ className }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const handleClick = async () => {
    setPending(true);
    setFailed(false);
    try {
      await logout();
      window.location.assign("/login");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // ไม่มี session อยู่แล้ว — ถือว่าออกจากระบบเรียบร้อย ไป /login ได้
        window.location.assign("/login");
        return;
      }
      setFailed(true); // network ล่ม/5xx — session ยังอยู่ ห้ามทำเหมือนสำเร็จ
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
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
      {failed ? (
        <span role="alert" className="max-w-56 text-right text-xs leading-relaxed text-danger-600">
          ออกจากระบบไม่สำเร็จ — โปรดลองอีกครั้ง หากยังไม่สำเร็จ ปิดหน้าต่างเบราว์เซอร์ทุกหน้าต่างเพื่อความปลอดภัย
        </span>
      ) : null}
    </span>
  );
}
