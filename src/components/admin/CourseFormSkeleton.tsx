import type { AdminCourse } from "@/lib/fixtures/admin";
import { formatThaiDate } from "@/lib/fixtures/admin";

/**
 * ฟอร์มข้อมูลหลักสูตร (โครง — อ่านได้อย่างเดียว) — DESIGN-SYSTEM §5.2 (Input)
 *
 * Phase 0: ทุกช่อง disabled การแก้ไขเนื้อหาหลักสูตร (authoring CRUD: CAT-001/005/006)
 * เลื่อนออกนอก Wave C ตาม D25-O3 จะเปิดให้แก้ไขได้เมื่อเริ่ม authoring wave จริง
 */

const DISABLED_INPUT_CLASS =
  "w-full rounded-[10px] border-[1.5px] border-mist-200 bg-mist-100 px-3.5 py-2.5 text-ink-500";

function Field({
  id,
  label,
  value,
  wide = false,
}: {
  id: string;
  label: string;
  value: string;
  wide?: boolean | undefined;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label
        htmlFor={id}
        className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        readOnly
        disabled
        aria-readonly="true"
        className={DISABLED_INPUT_CLASS}
      />
    </div>
  );
}

export function CourseFormSkeleton({
  course,
  categoryName,
}: {
  course: AdminCourse;
  categoryName: string;
}) {
  return (
    <section
      aria-labelledby="course-form-heading"
      className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card sm:p-6"
    >
      <h2 id="course-form-heading" className="font-heading text-lg font-semibold text-ink-900">
        ฟอร์มข้อมูลหลักสูตร (อ่านอย่างเดียว)
      </h2>
      <p className="mt-1 text-sm text-ink-500">
        ข้อมูลจาก DATA-DICTIONARY §3.2 (ตาราง courses) — ยังไม่เชื่อมต่อ API
      </p>

      <p className="mt-4 rounded-[10px] bg-warning-50 px-3 py-2 text-sm leading-relaxed text-warning-600">
        โครงหน้าจอ (skeleton): ช่องข้อมูลทั้งหมดเป็นแบบอ่านอย่างเดียว — การแก้ไขเนื้อหาหลักสูตร
        (authoring CRUD: CAT-001/005/006) เลื่อนออกนอก Wave C ตาม D25-O3 จะเปิดให้แก้ไขในเฟสถัดไป
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field id="course-code" label="รหัสหลักสูตร" value={course.code} />
        <Field id="course-title-th" label="ชื่อหลักสูตร (ไทย)" value={course.titleTh} />
        <Field
          id="course-title-en"
          label="ชื่อหลักสูตร (อังกฤษ)"
          value={course.titleEn ?? "—"}
        />
        <Field id="course-category" label="หมวดหลักสูตร" value={categoryName} />
        <Field id="course-language" label="ภาษาหลัก" value={course.language === "th" ? "ไทย" : course.language} />
        <Field
          id="course-access"
          label="การเข้าถึง"
          value={course.isPublic ? "สาธารณะ (ทุกคน)" : "เฉพาะทนายความ"}
        />
        <Field
          id="course-version"
          label="เวอร์ชัน"
          value={`ฉบับที่ ${course.version}`}
        />
        <Field
          id="course-published-at"
          label="เผยแพร่เมื่อ"
          value={course.publishedAt ? formatThaiDate(course.publishedAt) : "ยังไม่เคยเผยแพร่"}
        />
        <Field
          id="course-summary"
          label="คำอธิบายย่อ"
          value={course.summary ?? "—"}
          wide
        />
      </div>
    </section>
  );
}
