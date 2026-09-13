"use client";

/**
 * reset-password-client — หน้าตั้งรหัสผ่านใหม่ (AUTH-004 · Wave G P1 · D72)
 *
 * - ลิงก์ recovery ของ GoTrue วาง token ไว้ใน URL **fragment** (#access_token=...)
 *   ซึ่งไม่เดินทางถึง server — component อ่าน fragment เอง แล้วลบทิ้งจาก address
 *   bar ทันที (history.replaceState) — token อยู่ใน memory ของหน้าเท่านั้น
 * - flow: checking → มี fragment session → establishRecoverySession (setSession
 *   ตรวจกับ GoTrue แล้วเขียน cookie) → form → POST /confirm → success | invalid
 * - ไม่มี fragment (หรือ fragment error — ลิงก์ใช้แล้ว/หมดอายุ) → การ์ด
 *   "ลิงก์ไม่ถูกต้องหรือหมดอายุ" + ลิงก์ไป /forgot-password (สัญญา D72)
 * - ไม่มี noindex meta ซ้ำ (RSC export metadata แล้ว) · ไม่ log token ทุกชนิด
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";

import { establishRecoverySession } from "./actions";

type Phase = "checking" | "form" | "success" | "invalid";

/** ข้อความการ์ด invalid เริ่มต้น (ลิงก์เสีย) — rate limit แทนที่ด้วย setInvalidMessage */
const INVALID_LINK_MESSAGE =
  "ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอลิงก์ใหม่";

/** ข้อความ success — copy เดียวกับ PASSWORD_RESET_DONE_MESSAGE (lib เป็น server-only) */
const DONE_MESSAGE =
  "ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่";

/** ข้อความ policy — copy เดียวกับ PASSWORD_RESET_POLICY_MESSAGE (lib เป็น server-only) */
const POLICY_MESSAGE =
  "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่";

/** อ่าน + จำแนก fragment ปัจจุบัน (แล้วลบทิ้งจาก address bar ทันที) */
function classifyFragment(): { phase: "form" | "invalid"; tokens: { access_token: string; refresh_token: string } | null } {
  const fragment = window.location.hash.replace(/^#/, "");
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  if (fragment.length === 0) {
    return { phase: "invalid", tokens: null };
  }
  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token") ?? "";
  const refreshToken = params.get("refresh_token") ?? "";
  const hasError = params.get("error") !== null || params.get("error_code") !== null;
  if (hasError) {
    return { phase: "invalid", tokens: null };
  }
  if (accessToken.length === 0 || refreshToken.length === 0) {
    return { phase: "invalid", tokens: null };
  }
  return { phase: "form", tokens: { access_token: accessToken, refresh_token: refreshToken } };
}

export function ResetPasswordClient() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const startedRef = useRef(false);

  // fragment → classify → strip → establish session (ครั้งเดียว — StrictMode กันด้วย ref)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const { phase, tokens } = classifyFragment();
      if (phase === "invalid" || tokens === null) {
        setPhase("invalid");
        return;
      }
      const result = await establishRecoverySession(tokens);
      if (!result.ok) {
        // เกิน quota AUTH = การ์ด rate limit (ข้อความทะเบียน ERR-RATE-001) —
        // ต่างจากลิงก์เสีย: ลิงก์ยังใช้ได้ รอแล้วเปิดใหม่
        if (result.code === "ERR-RATE-001") {
          setInvalidMessage("มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่แล้วเปิดลิงก์นี้อีกครั้ง");
        }
        setPhase("invalid");
        return;
      }
      setPhase("form");
    })();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (password.length < 12) {
      setError("รหัสผ่านต้องมีความยาวอย่างน้อย 12 อักขระ");
      return;
    }
    if (password !== confirm) {
      setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      let payload: { data?: { message?: string }; error?: { code?: string; message?: string } } = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (res.ok) {
        setPhase("success");
        return;
      }
      const code = payload.error?.code ?? "";
      if (code === "ERR-AUTH-001" || code === "ERR-AUTH-005") {
        setPhase("invalid");
        return;
      }
      if (code === "ERR-VAL-001") {
        setError(payload.error?.message ?? POLICY_MESSAGE);
        return;
      }
      setError("ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง");
    } catch {
      setError("ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "checking") {
    return (
      <p role="status" className="mt-6 text-center text-sm text-ink-600">
        กำลังตรวจสอบลิงก์...
      </p>
    );
  }

  if (phase === "invalid") {
    return (
      <div className="mt-6">
        <p
          id="reset-invalid"
          role="alert"
          className="rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {invalidMessage ?? INVALID_LINK_MESSAGE}
        </p>
        <Link
          href="/forgot-password"
          className="mt-5 block w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 text-center font-heading font-semibold text-white shadow-card hover:bg-brand-700"
        >
          ขอลิงก์ตั้งรหัสผ่านใหม่
        </Link>
      </div>
    );
  }

  if (phase === "success") {
    return (
      <div className="mt-6">
        <p
          id="reset-success"
          role="status"
          className="rounded-[10px] border-[1.5px] border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700"
        >
          {DONE_MESSAGE}
        </p>
        <Link
          href="/login"
          className="mt-5 block w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 text-center font-heading font-semibold text-white shadow-card hover:bg-brand-700"
        >
          ไปหน้าเข้าสู่ระบบ
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      {error !== null ? (
        <p
          id="reset-alert"
          role="alert"
          className="rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {error}
        </p>
      ) : null}
      <div>
        <label
          htmlFor="password"
          className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
        >
          รหัสผ่านใหม่ <span className="text-danger-600" aria-hidden="true">*</span>
          <span className="sr-only">(จำเป็น)</span>
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
        />
      </div>
      <div>
        <label
          htmlFor="confirm"
          className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
        >
          ยืนยันรหัสผ่านใหม่ <span className="text-danger-600" aria-hidden="true">*</span>
          <span className="sr-only">(จำเป็น)</span>
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700 disabled:opacity-60"
      >
        {submitting ? "กำลังบันทึก..." : "ตั้งรหัสผ่านใหม่"}
      </button>
    </form>
  );
}
