/**
 * LogoutAllButton — ปุ่ม "ออกจากระบบทุกเครื่อง" (AUTH-010 UI · Wave G P1 · D72)
 *
 * POST /api/v1/auth/logout-all (route ของ lane W3 — UI เรียก path ตามสัญญาเท่านั้น
 * ห้ามสร้าง route เอง) — fetch same-origin (browser แนบ Origin ให้เองจึงผ่าน CSRF
 * ของ middleware) · 2xx = ยกเลิกทุกเซสชันรวมถึงเครื่องนี้ → เดินหน้า /login ด้วย
 * full navigation (ไม่ค้าง RSC cache ของหน้าเดิม) · non-2xx = ยกเลิกไม่สำเร็จ —
 * session ยังอยู่ ห้ามทำเหมือนสำเร็จ (แนวเดียวกับ LogoutButton · gate r4)
 */
"use client";

import { useState } from "react";

/** path ตามสัญญาของ lane W3 — ห้ามแก้ที่นี่ */
const LOGOUT_ALL_PATH = "/api/v1/auth/logout-all";

/** การ์ดข้อผิดพลาด (แนวเดียวกับหน้า security) */
const ALERT_CLASS =
  "rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700";

export function LogoutAllButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleClick = async () => {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch(LOGOUT_ALL_PATH, {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      // 2xx = ทุกเซสชันถูกยกเลิกรวมถึงเครื่องนี้ — เดินหน้า /login (full navigation)
      window.location.assign("/login");
    } catch {
      // network ล่ม — session ยังอยู่ ห้ามทำเหมือนสำเร็จ
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => {
          void handleClick();
        }}
        disabled={pending}
        className="rounded-[10px] border-[1.5px] border-danger-300 bg-white px-[18px] py-2.5 font-heading font-semibold text-danger-700 hover:bg-danger-50"
      >
        {pending ? "กำลังออกจากระบบทุกเครื่อง..." : "ออกจากระบบทุกเครื่อง"}
      </button>
      {failed ? (
        <span role="alert" className={ALERT_CLASS}>
          ออกจากระบบทุกเครื่องไม่สำเร็จ — โปรดลองอีกครั้ง หากยังไม่สำเร็จ
          ล้างข้อมูลการเข้าชมของเว็บไซต์นี้ (cookies) เพื่อความปลอดภัย
        </span>
      ) : null}
    </span>
  );
}
