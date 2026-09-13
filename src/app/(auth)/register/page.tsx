/**
 * /register — หน้าสมัครสมาชิก (citizen) — Wave C-0
 *
 * - สมัครสำหรับประชาชนทั่วไป (citizen) — ทนายความผูกใบอนุญาตภายหลังเข้าสู่ระบบ
 *   (SDS §4.1 ระบุ flow แยก) — หน้านี้ไม่รับข้อมูลใบอนุญาต
 * - PDPA: ต้องติ๊กยืนยันการรับทราบประกาศความเป็นส่วนตัวก่อนสมัคร
 *   (SRS PRI-002 / notice_acknowledgments — DATA-DICTIONARY)
 */
import { errorDefinition, type ErrorCode } from "@/lib/errors";
import { resolveSafeNextPath } from "@/lib/auth/session";
import { registerAction } from "../actions";
import { SIGNUP_CONSENT_POLICY_VERSION } from "../signup-consents";

interface RegisterPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** allowlist ของ error code ที่หน้า register ยอมแสดง */
const REGISTER_ERROR_CODES = ["ERR-VAL-001", "ERR-RATE-001", "ERR-SYS-001"] as const satisfies readonly ErrorCode[];

const REGISTER_NOTICES = ["weak_password"] as const;
type RegisterNoticeParam = (typeof REGISTER_NOTICES)[number];

/** ข้อความไทยของ notice (fixed copy — ไม่รับจาก query string) */
const REGISTER_NOTICE_MESSAGES: Record<RegisterNoticeParam, string> = {
  weak_password:
    "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่",
};

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

function isRegisterNotice(value: string): value is RegisterNoticeParam {
  return (REGISTER_NOTICES as readonly string[]).includes(value);
}

/** ตรวจ + narrow ให้เป็น ErrorCode จริง (กัน string ปลอมจาก query string เข้า errorDefinition) */
function isRegisterErrorCode(value: string): value is (typeof REGISTER_ERROR_CODES)[number] {
  return (REGISTER_ERROR_CODES as readonly string[]).includes(value);
}

const inputClass =
  "w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none";

const labelClass = "mb-1.5 block font-heading text-sm font-semibold text-ink-900";

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const params = await searchParams;
  const next = resolveSafeNextPath(firstParam(params.next));
  const rawError = firstParam(params.error);
  const errorCode = rawError !== null && isRegisterErrorCode(rawError) ? rawError : null;
  const errorDef = errorCode !== null ? errorDefinition(errorCode) : null;
  const rawNotice = firstParam(params.notice);
  const notice = rawNotice !== null && isRegisterNotice(rawNotice) ? rawNotice : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-mist-50 px-4 py-10">
      <div className="w-full max-w-md rounded-[14px] bg-white p-6 shadow-card sm:p-8">
        <p className="text-center text-sm text-ink-500">
          ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
        </p>
        <h1 className="mt-1 text-center font-heading text-2xl font-bold text-brand-900">
          สมัครสมาชิก
        </h1>
        <p className="mt-2 text-center text-sm text-ink-600">
          สำหรับประชาชนทั่วไป (citizen) — ทนายความยืนยันใบอนุญาตภายหลังเข้าสู่ระบบ
        </p>
        {errorDef !== null ? (
          <p
            id="register-alert"
            role="alert"
            className="mt-5 rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
          >
            {errorDef.message}
          </p>
        ) : null}
        {notice !== null ? (
          <p
            id="register-notice"
            role="status"
            className="mt-5 rounded-[10px] border-[1.5px] border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700"
          >
            {REGISTER_NOTICE_MESSAGES[notice]}
          </p>
        ) : null}
        <form action={registerAction} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={next} />
          <div>
            <label htmlFor="reg-email" className={labelClass}>
              อีเมล <span className="text-danger-600" aria-hidden="true">*</span>
              <span className="sr-only">(จำเป็น)</span>
            </label>
            <input
              id="reg-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              aria-describedby={errorDef !== null || notice !== null ? "register-alert register-notice" : undefined}
              placeholder="name@example.com"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="reg-password" className={labelClass}>
              รหัสผ่าน <span className="text-danger-600" aria-hidden="true">*</span>
              <span className="sr-only">(จำเป็น)</span>
            </label>
            <input
              id="reg-password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="อย่างน้อย 8 ตัวอักษร ผสมตัวพิมพ์ใหญ่ ตัวเลข และสัญลักษณ์"
              className={inputClass}
            />
          </div>
          <div className="flex items-start gap-3 rounded-[10px] border-[1.5px] border-mist-300 bg-mist-50 px-4 py-3">
            <input
              id="reg-ack"
              name="acknowledgeNotice"
              type="checkbox"
              value="on"
              required
              className="mt-1 size-4 shrink-0"
            />
            <label htmlFor="reg-ack" className="text-sm text-ink-700">
              ข้าพเจ้ารับทราบประกาศความเป็นส่วนตัวของระบบฝึกอบรมออนไลน์ และยินยอมให้ประมวลผลข้อมูลส่วนบุคคลตามที่ระบุ
              (จำเป็น — PDPA)
            </label>
          </div>
          <div className="flex items-start gap-3 rounded-[10px] border-[1.5px] border-mist-300 bg-mist-50 px-4 py-3">
            <input
              id="reg-consent-marketing"
              name="marketingConsent"
              type="checkbox"
              value="on"
              className="mt-1 size-4 shrink-0"
            />
            <label htmlFor="reg-consent-marketing" className="text-sm text-ink-700">
              รับข่าวสาร โปรโมชัน และกิจกรรมจากสภาทนายความฯ (ไม่บังคับ)
            </label>
          </div>
          <div className="flex items-start gap-3 rounded-[10px] border-[1.5px] border-mist-300 bg-mist-50 px-4 py-3">
            <input
              id="reg-consent-email"
              name="emailNotifyConsent"
              type="checkbox"
              value="on"
              className="mt-1 size-4 shrink-0"
            />
            <label htmlFor="reg-consent-email" className="text-sm text-ink-700">
              รับการแจ้งเตือนผ่านอีเมล (ไม่บังคับ)
            </label>
          </div>
          <p id="reg-consent-note" className="text-xs text-ink-500">
            ให้ความยินยอมได้ และถอนได้ทุกเมื่อที่หน้าการตั้งค่า (เวอร์ชันนโยบาย:{" "}
            {SIGNUP_CONSENT_POLICY_VERSION})
          </p>
          <button
            type="submit"
            className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
          >
            สมัครสมาชิก
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-ink-600">
          มีบัญชีผู้ใช้แล้ว{" "}
          <a
            href={`/login?next=${encodeURIComponent(next)}`}
            className="font-semibold text-brand-700 hover:underline"
          >
            เข้าสู่ระบบ
          </a>
        </p>
      </div>
    </main>
  );
}
