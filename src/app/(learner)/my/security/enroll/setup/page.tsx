/**
 * /my/security/enroll/setup — หน้า setup TOTP (Wave F · D-f-1)
 *
 * - อ่านข้อมูล setup จาก cookie ชั่วคราว path-scoped (`ltc_mfa_enroll` · 10 นาที)
 *   ไม่มี = ยังไม่เริ่ม/หมดอายุ → กลับหน้า enroll
 * - แสดง secret + otpauth URI พร้อมขั้นตอนไทย · ฟอร์มยืนยันรหัส 6 หลัก
 *   → confirmEnrollAction (ยืนยันกับ factor จาก stash เท่านั้น — ไม่เชื่อ formData)
 * - RSC เปลี่ยน cookie ไม่ได้ — การล้าง stash ทำใน action ทั้งหมด
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getUser } from "@/lib/auth/session";
import { confirmEnrollAction } from "../../actions";

export const dynamic = "force-dynamic";

const SETUP_STATES = ["invalid"] as const;
type SetupState = (typeof SETUP_STATES)[number];

const SETUP_STATE_MESSAGES: Record<SetupState, string> = {
  invalid: "รหัสไม่ถูกต้อง กรุณาลองอีกครั้ง",
};

const secretClass =
  "mt-1 block w-full break-all rounded-[10px] border-[1.5px] border-mist-300 bg-mist-50 px-3.5 py-2.5 font-mono text-sm text-ink-900";

interface EnrollStashView {
  readonly factorId: string;
  readonly secret: string;
  readonly otpauthUri: string;
}

/** แกะ stash fail-closed (รูปเพี้ยน = ยังไม่เริ่ม/หมดอายุ) */
function parseStash(raw: string): EnrollStashView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const factorId = record["factorId"];
  const secret = record["secret"];
  const otpauthUri = record["otpauthUri"];
  if (
    typeof factorId !== "string" ||
    factorId === "" ||
    typeof secret !== "string" ||
    secret === "" ||
    typeof otpauthUri !== "string" ||
    otpauthUri === "" ||
    !otpauthUri.startsWith("otpauth://")
  ) {
    return null;
  }
  return { factorId, secret, otpauthUri };
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

export default async function EnrollSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const params = await searchParams;
  const rawState = firstParam(params.status);
  const state =
    rawState !== null && (SETUP_STATES as readonly string[]).includes(rawState)
      ? (rawState as SetupState)
      : null;

  const store = await cookies();
  const stash = parseStash(store.get("ltc_mfa_enroll")?.value ?? "");
  if (stash === null) {
    redirect("/my/security/enroll");
  }

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ผูกแอปยืนยันตัวตน</h1>
      <p className="mt-1 text-sm text-ink-600">
        เพิ่ม secret ด้านล่างลงในแอปยืนยันตัวตนของท่าน แล้วยืนยันด้วยรหัส 6 หลัก
      </p>

      {state !== null ? (
        <p
          role="alert"
          className="mt-5 rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {SETUP_STATE_MESSAGES[state]}
        </p>
      ) : null}

      <section className="mt-6 rounded-[14px] border-[1.5px] border-mist-200 bg-white p-6">
        <h2 className="font-heading text-lg font-bold text-ink-900">ขั้นที่ 1 — เพิ่มบัญชีในแอปยืนยันตัวตน</h2>
        <p className="mt-2 text-sm text-ink-700">
          เปิดแอปยืนยันตัวตน (เช่น Google Authenticator, Aegis) เลือกเพิ่มบัญชี
          แล้วเลือก &quot;ป้อนรหัสตั้งค่าด้วยตนเอง&quot; (Enter a setup key)
        </p>
        <p className="mt-3 text-sm font-semibold text-ink-900">Secret (ใช้กับแอปยืนยันตัวตน):</p>
        <p className={secretClass}>{stash.secret}</p>
        <p className="mt-3 text-sm font-semibold text-ink-900">หรือวาง URI แบบเต็ม:</p>
        <p className={secretClass}>{stash.otpauthUri}</p>
      </section>

      <section className="mt-5 rounded-[14px] border-[1.5px] border-mist-200 bg-white p-6">
        <h2 className="font-heading text-lg font-bold text-ink-900">ขั้นที่ 2 — ยืนยันรหัส 6 หลัก</h2>
        <p className="mt-2 text-sm text-ink-700">
          กรอกรหัส 6 หลักจากแอปยืนยันตัวตน ระบบจะยืนยันการผูกและออกโค้ดสำรอง 8 โค้ดให้บันทึกทันที
        </p>
        <form action={confirmEnrollAction} className="mt-4 space-y-4">
          <div>
            <label htmlFor="code" className="mb-1.5 block font-heading text-sm font-semibold text-ink-900">
              รหัสยืนยัน <span className="text-danger-600" aria-hidden="true">*</span>
              <span className="sr-only">(จำเป็น)</span>
            </label>
            <input
              id="code"
              name="code"
              type="text"
              required
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700 sm:w-auto"
          >
            ยืนยันและออกโค้ดสำรอง
          </button>
        </form>
      </section>
    </div>
  );
}
