/**
 * /my/security/enroll — เริ่มผูก TOTP (Wave F · D-f-1)
 *
 * - gate ด้วย getUser() — ไม่มี session → /login (reachable ที่ aal1 ตามดีไซน์:
 *   บทบาทบังคับ MFA ต้องผูกครั้งแรกได้ ก่อนจะมี session aal2)
 * - มี factor verified อยู่แล้ว → กลับ /my/security?status=already
 * - ฟอร์มส่ง startEnrollAction — enroll บน session จริง แล้วพาไปหน้า setup
 */
import { redirect } from "next/navigation";

import { firstVerifiedTotpFactor } from "@/lib/auth/mfa";
import { getUser } from "@/lib/auth/session";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { startEnrollAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function EnrollStartPage() {
  const user = await getUser();
  if (user === null) {
    redirect("/login?next=%2Fmy%2Fsecurity");
  }
  const supabase = await createSupabaseSsrClient();
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  if (firstVerifiedTotpFactor(factorsData?.all ?? []) !== null) {
    redirect("/my/security?status=already");
  }

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">
        เริ่มการผูกแอปยืนยันตัวตน (TOTP)
      </h1>
      <p className="mt-1 text-sm text-ink-600">
        การยืนยันตัวตนสองชั้นช่วยป้องกันบัญชีของท่าน แม้รหัสผ่านจะรั่วไหล
      </p>
      <form action={startEnrollAction} className="mt-6 rounded-[14px] border-[1.5px] border-mist-200 bg-white p-6">
        <p className="text-sm text-ink-700">
          กดปุ่มด้านล่างเพื่อเริ่มการผูก — ระบบจะสร้าง secret ให้ท่านนำไปเพิ่มในแอปยืนยันตัวตน
          (เช่น Google Authenticator, Aegis) แล้วให้ท่านยืนยันรหัส 6 หลัก
          ก่อนระบบออกโค้ดสำรอง 8 โค้ดให้บันทึก
        </p>
        <button
          type="submit"
          className="mt-5 rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading font-semibold text-white shadow-card hover:bg-brand-700"
        >
          เริ่มการผูก
        </button>
      </form>
    </div>
  );
}
