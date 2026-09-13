/**
 * หน้า "ความเป็นส่วนตัว" (/my/privacy) — Wave E Phase 5 · SEC-011/IDENT-008 (D-p5-13) · lane E
 *
 * - RSC shell — หัวเรื่อง + ตาราง "ข้อมูลที่ระบบเก็บ + วัตถุประสงค์" (เนื้อหาไทยคงที่ตาม
 *   ประกาศ PDPA ของสภาทนายความฯ) + retention note (SEC-012 — ผลสอบ/audit เก็บตามกฎหมาย)
 * - Client islands: ConsentSwitches (PATCH /profile/consents) · ExportDeleteActions
 *   (GET /profile/export → 202 · POST /profile/delete ผ่าน ConfirmModal)
 * - BFF ยังไม่ deploy = แผง error ไทยจาก client island (ไม่ crash ไม่แสดง stack)
 */
import type { Metadata } from "next";

import { ConsentSwitches } from "@/components/learner/privacy/consent-switches";
import { ExportDeleteActions } from "@/components/learner/privacy/export-delete-actions";

// gate r2 G2: บังคับ dynamic rendering — หน้าที่ prerender เป็น static จะไม่มี
// CSP nonce ให้ inline script ของ client island (middleware ออก nonce ต่อ request)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ความเป็นส่วนตัวและข้อมูลส่วนบุคคล — ระบบฝึกอบรมออนไลน์",
  description:
    "ตรวจดูข้อมูลที่ระบบเก็บ จัดการความยินยอม ขอสำเนาข้อมูลของท่าน หรือขอลบบัญชี ตามสิทธิของเจ้าของข้อมูลส่วนบุคคล (PDPA)",
};

/** ตารางข้อมูลที่ระบบเก็บ — เนื้อหาคงที่ตามประกาศคุ้มครองข้อมูลส่วนบุคคล (D-p5-13 item 1) */
const DATA_CATEGORIES: readonly {
  readonly category: string;
  readonly examples: string;
  readonly purpose: string;
}[] = [
  {
    category: "ข้อมูลโปรไฟล์และการติดต่อ",
    examples: "ชื่อที่ใช้แสดง อีเมล เบอร์โทรศัพท์ ชื่อ-นามสกุลตามทะเบียน",
    purpose: "ยืนยันตัวตน ติดต่อสื่อสารเรื่องการอบรม และพิมพ์ใบประกาศนียบัตร",
  },
  {
    category: "ข้อมูลการเรียน",
    examples: "หลักสูตรที่ลงทะเบียน ความคืบหน้าบทเรียน สถานะการเรียน",
    purpose: "บันทึกความคืบหน้าการเรียนและแสดงผลกลับให้ท่านเห็น",
  },
  {
    category: "ข้อมูลการสอบ",
    examples: "ชุดข้อสอบที่ได้รับ คำตอบ ผลสอบ จำนวนครั้งที่สอบ",
    purpose: "ตรวจและประมวลผลการสอบตามเกณฑ์ของหลักสูตร",
  },
  {
    category: "ใบประกาศนียบัตรและหนังสือยืนยัน",
    examples: "เลขที่ใบประกาศ วันที่ออกใบ สถานะใบ (รวมการเพิกถอน)",
    purpose: "ออกใบประกาศนียบัตรและให้บุคคลที่สามตรวจสอบความถูกต้องของใบ",
  },
  {
    category: "หน่วยกิตสะสม",
    examples: "รายการรับ ปรับ และหักหน่วยกิตรายรอบต่ออายุ",
    purpose: "สรุปหน่วยกิตเพื่อการต่ออายุใบอนุญาตว่าความ",
  },
  {
    category: "ใบอนุญาตว่าความและเอกสารแนบ",
    examples: "เลขที่ใบอนุญาต ไฟล์หลักฐานที่ท่านแนบ",
    purpose: "ยืนยันคุณวุฒิทางกฎหมายและมอบบทบาททนายความในระบบ",
  },
  {
    category: "ความยินยอมและการรับทราบประกาศ",
    examples: "ประวัติการให้/ถอนความยินยอม (append-only)",
    purpose: "พิสูจน์การยินยอมตามกฎหมายคุ้มครองข้อมูลส่วนบุคคล",
  },
];

export default function MyPrivacyPage() {
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-ink-900">ความเป็นส่วนตัวและข้อมูลส่วนบุคคล</h1>
      <p className="mt-1 text-sm text-ink-600">
        สิทธิของท่านตามกฎหมายคุ้มครองข้อมูลส่วนบุคคล — ตรวจดูข้อมูลที่ระบบเก็บ จัดการความยินยอม
        ขอสำเนาข้อมูล หรือขอลบบัญชี
      </p>

      {/* (1) ข้อมูลที่ระบบเก็บ + วัตถุประสงค์ — เนื้อหาไทยคงที่ตามประกาศ PDPA */}
      <section aria-labelledby="privacy-data-table" className="mt-6">
        <h2 id="privacy-data-table" className="font-heading text-lg font-semibold text-ink-900">
          ข้อมูลที่ระบบเก็บและวัตถุประสงค์การเก็บ
        </h2>
        <div className="mt-3 overflow-x-auto rounded-[14px] border border-mist-200 bg-white shadow-card">
          <table className="w-full text-left text-sm" data-testid="privacy-data-table">
            <thead>
              <tr className="border-b border-mist-200 bg-mist-50">
                <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">ประเภทข้อมูล</th>
                <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">ตัวอย่างข้อมูล</th>
                <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">วัตถุประสงค์การเก็บ</th>
              </tr>
            </thead>
            <tbody>
              {DATA_CATEGORIES.map((row) => (
                <tr key={row.category} className="border-b border-mist-200 last:border-b-0">
                  <td className="px-4 py-3 font-semibold text-ink-900">{row.category}</td>
                  <td className="px-4 py-3 text-ink-600">{row.examples}</td>
                  <td className="px-4 py-3 text-ink-600">{row.purpose}</td>
  </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 rounded-[10px] border border-warning-200 bg-warning-50 p-3 text-xs leading-relaxed text-ink-600">
          หมายเหตุ: ผลการสอบและประวัติการตรวจสอบถูกเก็บรักษาตามระยะเวลาที่กฎหมายกำหนด
          แม้ท่านจะลบบัญชีแล้วก็ตาม — การลบบัญชีเป็นแบบ soft-delete เพื่อคงไว้ซึ่งหลักฐาน
          ทางกฎหมายของระบบฝึกอบรม
        </p>
      </section>

      {/* (2) ความยินยอมเสริม — PATCH /profile/consents */}
      <ConsentSwitches />

      {/* (3)+(4) ส่งออกข้อมูล / ขอลบบัญชี */}
      <ExportDeleteActions />
    </div>
  );
}
