/**
 * VerifyPanel — ฟอร์ม + ผลตรวจสอบประกาศนียบัตรสาธารณะ (Wave D-6)
 *
 * - รับทั้ง cert_no (LTC-<ปี>-<6 หลัก> — D10) และ verify_code (QR — D10) — BFF จำแนกเอง
 * - ตรวจผ่าน browser โดยตรง (same-origin GET): endpoint บันทึก certificate_verifications
 *   ด้วย ip_hash และ rate คีย์ต่อ IP — ให้ RSC ยิงแทนจะได้ IP เซิร์ฟเวอร์ทั้งก้อน
 * - ผล 4 ฟิลด์ {code, course_title, issued_at, status} — แสดงครบ 4 สถานะภาษาไทย
 *   ไม่มีชื่อผู้ถือ/PII (schema ตรวจซ้ำ ผิดสัญญา = fail-closed)
 * - ลิงก์ตรง /verify/<code> จาก QR: [code] page ส่ง initialCode → ตรวจทันทีเมื่อ hydrate
 */
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatIssuedAtThai,
  publicVerifyPageUrl,
  verificationDetailThai,
  verificationHeadingThai,
  verifyCertificate,
} from "@/lib/fixtures/certificates";
import { ApiError } from "@/lib/fixtures/learning";
import type { CertificatePublicViewParsed } from "@/lib/schemas/v1/certificate";

/** สถานะของหน้า — idle/loading/ผลตรวจ/ข้อผิดพลาด */
type VerifyState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; result: CertificatePublicViewParsed }
  | { kind: "failed"; code: "ERR-RATE-001" | "SYSTEM" | "EMPTY_INPUT"; message: string };

/** โทนแผงผลตรวจตามสถานะ — คู่สีอ้าง DESIGN-SYSTEM §2.5 (contrast >= 4.5:1) */
const RESULT_TONE: Record<
  CertificatePublicViewParsed["status"],
  { panel: string; title: string; text: string }
> = {
  valid: {
    panel: "border-success-300 bg-success-50",
    title: "text-success-700",
    text: "text-success-600",
  },
  revoked: {
    panel: "border-danger-200 bg-danger-50",
    title: "text-danger-700",
    text: "text-danger-600",
  },
  superseded: {
    panel: "border-gold-200 bg-gold-50",
    title: "text-ink-900",
    text: "text-ink-600",
  },
  not_found: {
    panel: "border-mist-200 bg-white",
    title: "text-ink-900",
    text: "text-ink-500",
  },
};

/** ความยาวรหัสสูงสุดที่ช่องกรอกรับ — ตรง CODE_MAX_LENGTH ของ BFF (route ตัดเกินเอง) */
const CODE_MAX_LENGTH = 128;

export function VerifyPanel({ initialCode }: { initialCode: string | null }) {
  const router = useRouter();
  const [codeInput, setCodeInput] = useState("");
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  // ผลล่าสุดชนะเสมอ — กัน response ของรหัสเก่าตอบทับผลใหม่เมื่อผู้ใช้กดตรวจรัว ๆ
  const latestRequestRef = useRef(0);

  const runVerify = useCallback(async (code: string): Promise<void> => {
    const requestId = ++latestRequestRef.current;
    setState({ kind: "loading" });
    try {
      const result = await verifyCertificate(code);
      if (latestRequestRef.current === requestId) {
        setState({ kind: "done", result });
      }
    } catch (caught: unknown) {
      if (latestRequestRef.current !== requestId) {
        return;
      }
      if (caught instanceof ApiError && caught.code === "ERR-RATE-001") {
        setState({
          kind: "failed",
          code: "ERR-RATE-001",
          message: "ท่านค้นหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง",
        });
      } else {
        setState({
          kind: "failed",
          code: "SYSTEM",
          message:
            "ไม่สามารถตรวจสอบได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่",
        });
      }
    }
  }, []);

  useEffect(() => {
    if (initialCode !== null && initialCode.length > 0) {
      void runVerify(initialCode);
    }
  }, [initialCode, runVerify]);

  const handleSearch = (): void => {
    const code = codeInput.trim().slice(0, CODE_MAX_LENGTH);
    if (code.length === 0) {
      setState({
        kind: "failed",
        code: "EMPTY_INPUT",
        message: "กรุณากรอกรหัสประกาศนียบัตรที่ต้องการตรวจสอบ",
      });
      return;
    }
    // อยู่ path ของรหัสนี้อยู่แล้ว (กดค้นซ้ำรหัสเดิม) → ตรวจซ้ำตรง ๆ ไม่ต้องเปลี่ยนหน้า
    if (publicVerifyPageUrl(code) === window.location.pathname) {
      void runVerify(code);
      return;
    }
    router.push(publicVerifyPageUrl(code));
  };

  return (
    <div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleSearch();
        }}
        className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card sm:p-6"
        aria-labelledby="verify-form-heading"
      >
        <h2 id="verify-form-heading" className="font-heading text-lg font-bold text-ink-900">
          กรอกรหัสประกาศนียบัตร
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          ตัวอย่างรหัส: LTC-2026-123456 (เลขที่ใบ) หรือรหัสจาก QR Code ด้านหลังใบประกาศนียบัตร
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value)}
            maxLength={CODE_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            aria-label="รหัสประกาศนียบัตร"
            placeholder="LTC-2026-123456"
            className="h-12 flex-1 rounded-[10px] border border-mist-300 bg-white px-4 text-base text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <button
            type="submit"
            disabled={state.kind === "loading"}
            className="h-12 shrink-0 rounded-[10px] bg-brand-600 px-8 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
          >
            {state.kind === "loading" ? "กำลังตรวจสอบ..." : "ตรวจสอบ"}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-400">
          ระบบแสดงเฉพาะข้อมูลจำเพาะของประกาศนียบัตร — ไม่แสดงชื่อหรือข้อมูลส่วนบุคคลของผู้ถือใบ
        </p>
      </form>

      <div aria-live="polite">
        {state.kind === "loading" ? (
          <p role="status" className="mt-4 text-sm text-ink-500">
            กำลังตรวจสอบรหัสของท่าน...
          </p>
        ) : null}
        {state.kind === "failed" ? (
          <div role="alert" className="mt-4 rounded-[14px] border border-danger-200 bg-danger-50 p-5">
            <p className="font-heading text-base font-semibold text-danger-700">{state.message}</p>
            {state.code === "ERR-RATE-001" ? (
              <p className="mt-1 text-sm text-danger-600">
                ระบบจำกัดจำนวนการตรวจสอบเพื่อป้องกันการเดารหัส (กรุณารอสักครู่แล้วลองใหม่)
              </p>
            ) : null}
          </div>
        ) : null}
        {state.kind === "done" ? <VerifyResultPanel result={state.result} /> : null}
      </div>
    </div>
  );
}

/** แผงผลตรวจ 4 ฟิลด์ — โทนสี/ข้อความตามสถานะ (ไม่มี holder_name ใด ๆ โดยเด็ดขาด) */
function VerifyResultPanel({ result }: { result: CertificatePublicViewParsed }) {
  const tone = RESULT_TONE[result.status];
  const issuedAt = result.issued_at === null ? null : formatIssuedAtThai(result.issued_at);
  return (
    <section
      aria-labelledby="verify-result-heading"
      className={`mt-4 rounded-[14px] border p-5 sm:p-6 ${tone.panel}`}
    >
      <h2 id="verify-result-heading" className={`font-heading text-lg font-bold ${tone.title}`}>
        {verificationHeadingThai(result.status)}
      </h2>
      <p className={`mt-1 text-sm ${tone.text}`}>{verificationDetailThai(result.status)}</p>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-[10px] bg-white/70 p-3">
          <dt className="text-xs font-semibold text-ink-500">เลขที่/รหัสอ้างอิง</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink-900 break-words">{result.code}</dd>
        </div>
        <div className="rounded-[10px] bg-white/70 p-3">
          <dt className="text-xs font-semibold text-ink-500">หลักสูตร</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink-900">
            {result.course_title ?? "—"}
          </dd>
        </div>
        <div className="rounded-[10px] bg-white/70 p-3">
          <dt className="text-xs font-semibold text-ink-500">วันที่ออกใบ</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink-900">{issuedAt ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
