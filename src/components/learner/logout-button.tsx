/**
 * LogoutButton — ปุ่มออกจากระบบ (learner shell)
 *
 * POST /api/v1/auth/logout (fetch same-origin — browser แนบ Origin/Sec-Fetch-Site ให้เอง
 * จึงผ่าน middleware CSRF เอง) · เปลี่ยนไป /login **เฉพาะเมื่อ route ตอบ 204 เท่านั้น**
 * (สำเร็จ หรือไม่มี session เหลืออยู่ — route ตอบ 204 ทั้งสองกรณีตั้งแต่ gate r4)
 * · กรณีอื่น (network/5xx = auth server ล้ม) ต้องแสดงว่าออกไม่สำเร็จและให้ลองใหม่
 * ห้ามเดินหน้าเหมือนสำเร็จ เพราะ session ยังใช้ได้ (ผู้ใช้เครื่องร่วมจะเข้าใจผิด)
 * ใช้ full navigation เพื่อไม่ค้าง RSC cache ของหน้าเดิม
 */
"use client";

import { useState } from "react";

import { logout } from "@/lib/fixtures/learning";

export function LogoutButton({ className }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const handleClick = async () => {
    setPending(true);
    setFailed(false);
    try {
      await logout(); // 204 เท่านั้นที่ไม่ throw — requestJson โยน ApiError ทุก non-2xx
      window.location.assign("/login");
    } catch {
      // network ล่ม/auth server ล้ม — session ยังอยู่ ห้ามทำเหมือนสำเร็จ (gate r4)
      setFailed(true);
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
          ออกจากระบบไม่สำเร็จ — โปรดลองอีกครั้ง หากยังไม่สำเร็จ
          ล้างข้อมูลการเข้าชมของเว็บไซต์นี้ (cookies) เพื่อความปลอดภัย
        </span>
      ) : null}
    </span>
  );
}
