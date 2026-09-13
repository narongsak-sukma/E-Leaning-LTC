"use client";

/**
 * forgot-password-form — ฟอร์มอีเมลของหน้า /forgot-password (AUTH-004 · Wave G P1)
 *
 * - POST /api/v1/auth/password-reset/request — 200 = แสดงข้อความคงที่เสมอ (prop
 *   fixedMessage จาก RSC — ไม่ว่าอีเมลมีในระบบหรือไม่ ผู้ใช้เห็นข้อความเดียวกัน)
 * - error แสดงข้อความไทยจากทะเบียน (response error.message) เท่านั้น
 */
import { useState, type FormEvent } from "react";

interface ForgotPasswordFormProps {
  /** ข้อความคงที่ anti-enumeration (PASSWORD_RESET_REQUEST_MESSAGE จาก RSC) */
  readonly fixedMessage: string;
}

/** จำแนก error ของ response → ข้อความที่แสดง (code อื่น = ข้อความกลาง) */
function errorMessageOf(status: number, code: string, message: string): string {
  if (status === 429) return `${message} กรุณารอสักครู่แล้วลองอีกครั้ง`;
  if (code === "ERR-VAL-001") return "รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง";
  if (status >= 500) return "ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง";
  return message;
}

/** รูปแบบอีเมลแบบง่าย (ฝั่ง API ตรวจจริงด้วย zod) */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordForm({ fixedMessage }: ForgotPasswordFormProps) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (EMAIL_RE.test(normalized) === false) {
      setError("รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง");
      return;
    }
    setError(null);
    setState("sending");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: normalized }),
      });
      let payload: { error?: { code?: string; message?: string } } = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (res.ok) {
        setState("sent");
        return;
      }
      const code = payload.error?.code ?? "";
      const message = payload.error?.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่ภายหลัง";
      setState("idle");
      setError(errorMessageOf(res.status, code, message));
    } catch {
      setState("idle");
      setError("ระบบขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง");
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      {state === "sent" ? (
        <p
          id="forgot-notice"
          role="status"
          className="rounded-[10px] border-[1.5px] border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700"
        >
          {fixedMessage}
          <br />
          ตรวจสอบโฟลเดอร์ junk/spam ด้วย หากไม่พบในกล่องจดหมายเข้า
        </p>
      ) : (
        <>
          {error !== null ? (
            <p
              id="forgot-alert"
              role="alert"
              className="rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
            >
              {error}
            </p>
          ) : null}
          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
            >
              อีเมล <span className="text-danger-600" aria-hidden="true">*</span>
              <span className="sr-only">(จำเป็น)</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="name@example.com"
              className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={state === "sending"}
            className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700 disabled:opacity-60"
          >
            {state === "sending" ? "กำลังส่ง..." : "ส่งลิงก์ตั้งรหัสผ่านใหม่"}
          </button>
        </>
      )}
    </form>
  );
}
