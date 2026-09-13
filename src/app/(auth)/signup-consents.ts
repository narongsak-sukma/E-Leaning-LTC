/**
 * signup-consents — ตัวช่วย (pure) แปลง checkbox PDPA เสริมจากฟอร์มสมัคร → payload
 * `options.data.consents_granted` ของ `supabase.auth.signUp` (Wave F · D-f-3 · [#91])
 *
 * กลไกปลายทาง (migration 0043 — ห้ามแก้): trigger บน auth.users อ่าน
 * `raw_user_meta_data->'consents_granted'` ตอน email_confirmed_at null→non-null
 * แล้ว insert แถว `consents` เฉพาะ key `marketing` / `email_notify`
 * (source='register', action='grant') — ช่องที่ไม่ได้ติ๊ก = ไม่ส่ง = ไม่เกิดแถว
 *
 * PDPA: checkbox ทั้งสอง "ไม่ติ๊ก" เป็นค่าเริ่มต้น — ห้าม pre-tick (opt-in ต้องชัดเจน);
 * helper ยอมรับเฉพาะค่า "on" ตรง ๆ (checkbox ของ HTML ส่ง "on" เมื่อถูกติ๊กเท่านั้น)
 * — ค่าอื่น ("yes"/"true"/อื่น ๆ) ถือว่าไม่ได้ยินยอม
 */

/**
 * เวอร์ชันนโยบาย (policy_version) — home เดียวอยู่ที่ config (lead ย้ายจาก const
 * ท้องถิ่นตอน integrate ตาม D-f-3 "จาก config") · re-export ให้ผู้เรียกใช้เดิม
 * (actions.ts/register page) · รูปแบบต้องผ่าน regex ฝั่ง DB (0043):
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$`
 */
export { SIGNUP_CONSENT_POLICY_VERSION } from "@/lib/config";

/** รายการ consent หนึ่งรายการสำหรับ trigger (0043) — { key, version } */
export interface SignupConsent {
  key: string;
  version: string;
}

/** checkbox → consent key — ลำดับตายตัว [marketing, email_notify] (ยึด API-SPEC) */
const CONSENT_FIELDS = [
  { field: "marketingConsent", key: "marketing" },
  { field: "emailNotifyConsent", key: "email_notify" },
] as const;

/** ติ๊ก = มีค่า "on" เท่านั้น (checkbox ปกติของ HTML ส่ง "on" 1 ค่าเมื่อถูกติ๊ก) — ค่าอื่น = ไม่ยินยอม */
function isTicked(values: FormDataEntryValue[]): boolean {
  return values.includes("on");
}

/**
 * อ่าน checkbox PDPA เสริมจาก FormData → อาร์เรย์ consents_granted
 *
 * - เฉพาะช่องที่ติ๊ก ("on") เท่านั้น — ไม่ติ๊ก = ไม่มี entry (trigger ใส่เฉพาะที่มี)
 * - ลำดับตายตัว [marketing, email_notify]
 * - อาร์เรย์ว่าง [] เมื่อไม่ติ๊กอะไรเลย (ถูกต้อง — ไม่มี consent)
 */
export function buildSignupConsents(formData: FormData, version: string): SignupConsent[] {
  const consents: SignupConsent[] = [];
  for (const { field, key } of CONSENT_FIELDS) {
    if (isTicked(formData.getAll(field))) {
      consents.push({ key, version });
    }
  }
  return consents;
}
