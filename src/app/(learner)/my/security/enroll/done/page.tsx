/**
 * /my/security/enroll/done — หน้าแสดงโค้ดสำรอง "ครั้งเดียว" (Wave F · D-f-1)
 *
 * - อ่านโค้ดจาก cookie ชั่วคราว path-scoped (`ltc_mfa_codes` · path=…/done · 2 นาที)
 *   ไม่มี = แสดงแล้ว/หมดอายุ → กลับ /my/security (โค้ดแสดงครั้งเดียวตามสัญญา —
 *   เก็บ hash เท่านั้นใน DB; หน้าจอคือทางเดียวที่โค้ดเคยปรากฏ)
 * - RSC เปลี่ยน cookie ไม่อนุญาต — การล้าง stash ทำโดย finishBackupCodesAction
 *   (ผู้ใช้กด "บันทึกแล้ว" → ล้าง → กลับหน้า security) หรือหมดอายุเองใน 2 นาที
 * - force-dynamic + อ่านผ่าน cookies() = ไม่มี caching ของหน้า (แนว no-store)
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getUser } from "@/lib/auth/session";
import { finishBackupCodesAction } from "../../actions";

export const dynamic = "force-dynamic";

const CODE_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/;

/** แกะโค้ดจาก stash fail-closed (รูปเพี้ยน/จำนวนผิด = ถือว่าไม่มีโค้ดให้แสดง) */
function parseCodes(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 8 || parsed.length > 12) {
    return null;
  }
  for (const code of parsed) {
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
      return null;
    }
  }
  return parsed;
}

export default async function EnrollDonePage() {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const store = await cookies();
  const codes = parseCodes(store.get("ltc_mfa_codes")?.value ?? "");
  if (codes === null) {
    redirect("/my/security");
  }

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">โค้ดสำรองของท่าน</h1>
      <p
        role="alert"
        className="mt-4 rounded-[10px] border-[1.5px] border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
      >
        บันทึกโค้ดเหล่านี้ทันที — ระบบจะไม่แสดงอีกครั้ง และฝั่งระบบเก็บ hash เท่านั้น
        หากทำหายจะไม่มีทางเรียกคืนได้ (ต้องสร้างชุดใหม่)
      </p>
      <ul className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {codes.map((code) => (
          <li
            key={code}
            className="rounded-[10px] border-[1.5px] border-mist-300 bg-mist-50 px-3.5 py-2.5 font-mono text-sm tracking-wide text-ink-900"
          >
            {code}
          </li>
        ))}
      </ul>
      <p className="mt-5 text-sm text-ink-600">
        ใช้เมื่อแอปยืนยันตัวตนไม่อยู่กับท่าน — กรอกโค้ดได้ที่หน้ายืนยันตอนเข้าสู่ระบบ
        แต่ละโค้ดใช้ได้ครั้งเดียว
      </p>
      <form action={finishBackupCodesAction} className="mt-6">
        <button
          type="submit"
          className="w-full rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700 sm:w-auto"
        >
          ฉันบันทึกโค้ดไว้เรียบร้อยแล้ว
        </button>
      </form>
    </div>
  );
}
