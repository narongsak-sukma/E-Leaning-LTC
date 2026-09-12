/**
 * หน้ายืนยันการลบบัญชี /profile/delete/confirm?token=… (gate p5-r1 B2 · #90)
 *
 * - **สาธารณะ ไม่ต้อง session** — ผู้คลิกลิงก์จากอีเมลยืนยัน (อีเมลธุรกรรม
 *   account.delete.confirm · 0035 §9) ยังไม่ได้ login ก็ต้องยืนยันได้ตาม spec §3.2
 *   (เดิมมีแค่ route JSON ที่ /api/v1/… พาธหน้า HTML ไม่มี → คลิกแล้ว 404)
 * - server component เรียก lib/pdpa/deletion.confirmAccountDeletion ตรง (ทางเข้า
 *   RPC เดียวกับ route — ไม่ fetch ตัวเอง) · rate-limit อยู่ที่ route JSON ฝั่ง
 *   programmatic · หน้านี้พึ่งเอนโทรปีของ token (CSPRNG 43 อักขระ 0036 §5)
 * - ผล 3 แบบ: confirmed / link_invalid (generic — ไม่เฉลยสถานะคำขอ) / sod_changed
 *   (B6 — บัญชีได้บทบาทเจ้าหน้าที่/ผู้สอนระหว่างอายุ token คำขอยัง pending)
 * - ห้าม log token (D24) — token อยู่ใน URL ที่ RPC อ่านเท่านั้น
 * - force-dynamic + no-store: ผลยืนยัน single-use ต้องไม่ถูก cache ทุกชั้น
 */
import type { Metadata } from "next";
import Link from "next/link";

import { confirmAccountDeletion } from "@/lib/pdpa/deletion";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ยืนยันการลบบัญชี — สภาทนายความแห่งประเทศไทย",
  description: "ยืนยันการลบบัญชีด้วยลิงก์จากอีเมลของสภาทนายความแห่งประเทศไทย",
  robots: { index: false, follow: false },
};

/** รูปแบบ token ตรง route API (base64url 20..200) — ไม่ผ่าน = หน้าลิงก์เสียเลย */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

/** ผลที่จะ render — เอามาแต่เฉดสีกับข้อความ ไม่มีข้อมูลผู้ใช้ใด ๆ */
type PageOutcome = "confirmed" | "link_invalid" | "sod_changed" | "system_error";

const VIEW: Record<
  PageOutcome,
  { readonly title: string; readonly tone: string; readonly message: string }
> = {
  confirmed: {
    title: "ยืนยันการลบบัญชีสำเร็จ",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
    message:
      "บัญชีของท่านถูกลบเรียบร้อยแล้ว ขอบคุณที่ใช้บริการ หากมีข้อสงสัยกรุณาติดต่อผู้ดูแลระบบ",
  },
  link_invalid: {
    title: "ลิงก์ไม่ถูกต้องหรือหมดอายุ",
    tone: "border-amber-200 bg-amber-50 text-amber-900",
    message:
      "ลิงก์ยืนยันไม่ถูกต้อง ถูกใช้ไปแล้ว หรือหมดอายุ (24 ชั่วโมง) หากท่านยังต้องการลบบัญชี กรุณาเข้าสู่ระบบและยื่นคำขอใหม่",
  },
  sod_changed: {
    title: "ไม่สามารถยืนยันการลบได้",
    tone: "border-amber-200 bg-amber-50 text-amber-900",
    message:
      "บัญชีนี้มีบทบาทผู้สอนหรือเจ้าหน้าที่อยู่ จึงยืนยันการลบด้วยตนเองไม่ได้ กรุณาติดต่อผู้ดูแลระบบ",
  },
  system_error: {
    title: "เกิดข้อผิดพลาดของระบบ",
    tone: "border-red-200 bg-red-50 text-red-900",
    message:
      "ระบบขัดข้องชั่วคราว ไม่สามารถยืนยันสถานะคำขอได้ กรุณาลองเปิดลิงก์นี้อีกครั้งภายหลัง หรือติดต่อผู้ดูแลระบบ",
  },
};

/** ทางเข้าเดียวของหน้า — token จาก query → lib → ผล 4 แบบ (ไม่ log token) */
async function resolveOutcome(token: string | undefined): Promise<PageOutcome> {
  if (token === undefined || !TOKEN_RE.test(token)) {
    return "link_invalid";
  }
  try {
    const result = await confirmAccountDeletion(token, null);
    if (result.outcome === "confirmed") {
      return "confirmed";
    }
    if (result.outcome === "sod_changed") {
      return "sod_changed";
    }
    return "link_invalid";
  } catch {
    // system error — RPC อาจ commit แล้วแต่ตอบผิดสัญญา ไม่ทราบสถานะแน่นอน →
    // การ์ดข้อผิดพลาด (ไม่เฉลย ไม่เขียนผลยืนยันปลอม)
    return "system_error";
  }
}

export default async function DeleteConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawToken = params["token"];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const outcome = await resolveOutcome(token);
  const view = VIEW[outcome];

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
      <header className="mb-6 text-center">
        <h1 className="font-heading text-2xl font-bold text-ink-900 sm:text-3xl">
          ยืนยันการลบบัญชี
        </h1>
        <p className="mt-2 text-sm leading-tight text-ink-500 sm:text-base">
          สภาทนายความแห่งประเทศไทย — ระบบฝึกอบรมและสอบออนไลน์
        </p>
      </header>

      <section
        role="status"
        aria-live="polite"
        className={`rounded-xl border px-6 py-8 text-center ${view.tone}`}
      >
        <h2 className="text-lg font-semibold sm:text-xl">{view.title}</h2>
        <p className="mt-3 text-sm leading-relaxed sm:text-base">{view.message}</p>
      </section>

      <p className="mt-8 text-center text-sm">
        <Link className="text-brand-700 hover:underline" href="/">
          กลับหน้าแรก
        </Link>
      </p>
    </div>
  );
}
