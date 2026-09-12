/**
 * providers — ชั้นส่งอีเมลจริงของ NTF-006 (Wave E Phase 4 · D-p4-8)
 *
 * - ผู้ให้บริการ 3 แบบ config-driven ด้วย EMAIL_PROVIDER (src/lib/config.ts):
 *   `console` (dev ที่ไม่มี SMTP — "ส่ง" ด้วยการเขียน log structured บรรทัดเดียว,
 *   **ห้ามมี to_email/เนื้อหาใน log — ใช้ hash ของผู้รับแทน**) · `smtp` (nodemailer
 *   ตรง ๆ — dev ชี้ Mailpit, prod ชี้ SMTP จริง) · `resend` (prod — HTTP API)
 * - interface เดียวทุก provider: `sendEmail(msg): Promise<{ ok, error? }>` —
 *   **catch ทุกอย่างเอง ไม่ throw ออกนอกฟังก์ชันเด็ดขาด** (คิวต้องไม่ตายเพราะ
 *   provider ล้ม — error กลับเป็นผลลัพธ์ให้ dispatch รายงาน email_complete ต่อ)
 * - error ที่คืนเป็น static token ไม่มี PII — ห้ามฝังข้อความดิบของ provider/HTTP
 *   body (อาจสะท้อน to_email/เนื้อหา) เพราะค่านี้ถูกเก็บลง email_outbox.last_error
 * - ห้าม log to_email/payload ทุก environment (กติกาโปรเจกต์ NEVER log sensitive data)
 */
import "server-only";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { AppConfig } from "@/lib/config";
import type { LogLevel } from "@/lib/logger";
import { createLogger } from "@/lib/logger";

/** ข้อความอีเมลที่ provider ทุกตัวรับรู้เรื่องเดียวกัน (html สร้างจาก body เสมอ) */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** เนื้อความล้วน (ภาษาไทย) — provider สร้าง html จากข้อความนี้ด้วย buildEmailHtml */
  readonly body: string;
}

/**
 * ผลลัพธ์การส่ง — ok=false พร้อม error แบบ static token (ไม่มี PII) แทนการ throw ·
 * ok=true ไม่ใส่ error (exactOptionalPropertyTypes-safe)
 */
export interface EmailSendResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** ฟังก์ชันส่งอีเมล — interface เดียวของ provider ทั้ง 3 แบบ */
export type EmailSender = (msg: EmailMessage) => Promise<EmailSendResult>;

/** ส่วนของ AppConfig ที่ชั้น provider ใช้ (แคบ — stub ใน unit test ง่าย) */
export type EmailProviderConfig = Pick<
  AppConfig,
  "emailProvider" | "smtp" | "emailFrom" | "resendApiKey" | "logLevel"
>;

/** ปลายทาง HTTP API ของ Resend (SDS — prod provider) */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** หมดเวลา fetch ของ resend (มิลลิวินาที) — worker ต้องไม่ค้างรอ provider เงียบ ๆ */
const RESEND_TIMEOUT_MS = 10_000;

/** pattern ตัด line break ออกจาก subject (กัน header injection) */
const CRLF_RE = /[\r\n]+/g;

/** sha256 hex — ใช้ hash ผู้รับใน log แทน to_email (one-way) */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** escape อักขระ HTML — เนื้อหามาจาก template + payload จึงต้องกัน HTML injection */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** subject ห้ามมี line break — ตัดทิ้งเงียบ ๆ ไม่ให้พังงานส่ง */
export function normalizeSubject(subject: string): string {
  return subject.replaceAll(CRLF_RE, " ").trim();
}

/**
 * สร้าง html จาก subject/body (ภาษาไทย) — wrapper ง่าย: doctype + meta charset
 * utf-8 + lang="th" · escape ก่อนฝัง (กัน injection) แล้วแปลง \n เป็น <br> ·
 * ไม่มี external asset (Mailpit แสดงได้แม้ offline)
 */
export function buildEmailHtml(subject: string, body: string): string {
  const safeSubject = escapeHtml(normalizeSubject(subject));
  const safeBody = escapeHtml(body).replaceAll("\n", "<br>");
  return [
    "<!doctype html>",
    '<html lang="th">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeSubject}</title>`,
    "</head>",
    '<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,\'Noto Sans Thai\',Tahoma,sans-serif;color:#1f2937;">',
    '  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">',
    `    <p style="margin:0 0 12px;font-size:14px;line-height:1.8;">${safeBody}</p>`,
    '    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">',
    '    <p style="margin:0;font-size:12px;color:#6b7280;">ระบบฝึกอบรมออนไลน์ สภาทนายความฯ — อีเมลอัตโนมัติ ไม่ต้องตอบกลับ</p>',
    "  </div>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ————————————————————————————————————————————————————————— providers

/**
 * provider `console` — "ส่ง" ด้วยการเขียน log structured **บรรทัดเดียว** ลง stdout:
 * มีแต่ hash ของผู้รับ (sha256 ตัดสั้น) + นับ byte ของเนื้อหา — โครงสร้างของ
 * allowlist ใน logger ทำให้ to_email/subject/body/payload เข้า log ไม่ได้
 * · ส่งได้เสมอ (ok เสมอ — provider นี้ล้มไม่ได้ตามโครงสร้าง)
 */
export function consoleProvider(level: LogLevel = "info"): EmailSender {
  const logger = createLogger(level);
  return async (msg) => {
    logger.info("email_console_delivery", {
      status: "ok",
      // hash ระบุผู้รับแทน to_email — one-way (ตัดเหลือ 16 hex)
      request_id: sha256Hex(msg.to).slice(0, 16),
      duration_ms: Buffer.byteLength(msg.subject) + Buffer.byteLength(msg.body),
      route: "email/console",
    });
    return { ok: true };
  };
}

/**
 * provider `smtp` — nodemailer createTransport จาก config.smtp โดยตรง (repo ไม่ใช้
 * @nestjs) · สร้าง auth เมื่อมีคู่ user+password เท่านั้น (dev Mailpit ไม่ต้อง auth) ·
 * catch ทุก error เอง — คืน static token พร้อม error.code ของ nodemailer ได้
 * (ECONNREFUSED/EAUTH — token สั้นปลอดภัย ไม่มี PII)
 */
export function smtpProvider(config: EmailProviderConfig): EmailSender {
  const smtp = config.smtp;
  if (smtp === null) {
    // config superRefine บังคับครบเมื่อ EMAIL_PROVIDER=smtp แล้ว — ถึงจุดนี้ = drift
    return async () => ({ ok: false, error: "smtp_config_missing" });
  }
  const transportOptions: SMTPTransport.Options = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
  };
  if (smtp.user !== null && smtp.password !== null) {
    transportOptions.auth = { user: smtp.user, pass: smtp.password };
  }
  const transport: Transporter = nodemailer.createTransport(transportOptions);
  return async (msg) => {
    if (config.emailFrom === null) {
      return { ok: false, error: "email_from_missing" };
    }
    try {
      await transport.sendMail({
        from: config.emailFrom,
        to: msg.to,
        subject: normalizeSubject(msg.subject),
        text: msg.body,
        html: buildEmailHtml(msg.subject, msg.body),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: smtpErrorCode(err) };
    }
  };
}

/**
 * provider `resend` — fetch POST RESEND_ENDPOINT · Bearer RESEND_API_KEY · body
 * JSON {from, to:[to], subject, html} · **ไม่อ่าน response body** (อาจสะท้อน
 * to_email — เก็บเป็น static token แทน) · AbortSignal.timeout กันค้าง
 */
export function resendProvider(config: EmailProviderConfig): EmailSender {
  const apiKey = config.resendApiKey;
  if (apiKey === null) {
    return async () => ({ ok: false, error: "resend_api_key_missing" });
  }
  if (config.emailFrom === null) {
    return async () => ({ ok: false, error: "email_from_missing" });
  }
  const from = config.emailFrom;
  return async (msg) => {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: normalizeSubject(msg.subject),
          html: buildEmailHtml(msg.subject, msg.body),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, error: `resend_http_${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: resendErrorCode(err) };
    }
  };
}

/** ผู้ให้บริการตาม config — จุดเข้าเดียวที่ dispatch ควรเรียก */
export function createEmailSender(config: EmailProviderConfig): EmailSender {
  switch (config.emailProvider) {
    case "console":
      return consoleProvider(config.logLevel);
    case "smtp":
      return smtpProvider(config);
    case "resend":
      return resendProvider(config);
  }
}

/** error.code ของ nodemailer (เช่น ECONNREFUSED) — กรองเฉพาะ token สั้นปลอดภัย */
function smtpErrorCode(err: unknown): string {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) {
    return `smtp_${code.toLowerCase()}`;
  }
  return "smtp_send_failed";
}

/** error ของ fetch — แยก timeout ออกจาก error เครือข่ายทั่วไป (static token) */
function resendErrorCode(err: unknown): string {
  const name =
    typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return "resend_timeout";
  }
  return "resend_network_error";
}
