import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseStatusBadge } from "@/components/admin/StatusBadge";
import { CourseFormSkeleton } from "@/components/admin/CourseFormSkeleton";
import {
  adminCategories,
  adminCourses,
  adminFixtureStaff,
  formatThaiDate,
} from "@/lib/fixtures/admin";

export const metadata: Metadata = {
  title: "รายละเอียดหลักสูตร · หลังบ้านจัดการเนื้อหา",
  description:
    "ดูข้อมูลหลักสูตรและสถานะเผยแพร่ (โครงหน้าจอ — ปุ่มเผยแพร่ยังไม่เชื่อมต่อ PATCH /api/v1/admin/courses/{id})",
};

const PUBLISH_NEXT_NOTE =
  "ยังไม่เชื่อมต่อ API — เชื่อมต่อในเฟสถัดไป: PATCH /api/v1/admin/courses/{id} (เปลี่ยนสถานะเผยแพร่ พร้อมบันทึก audit COURSE_PUBLISH)";

const canPublish = adminFixtureStaff.role === "staff:content" || adminFixtureStaff.role === "super_admin";

export default async function AdminCourseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const course = adminCourses.find((course) => course.id === id);
  if (!course) {
    notFound();
  }
  const categoryName =
    adminCategories.find((category) => category.id === course.categoryId)?.nameTh ?? "—";

  return (
    <div>
      <nav aria-label="เส้นทาง" className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-500">
          <li>
            <Link href="/admin/courses" className="text-brand-600 hover:underline">
              หลักสูตร
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-ink-700">
            {course.titleTh}
          </li>
        </ol>
        <Link href="/admin/courses" className="mt-1 inline-flex text-sm text-brand-600 hover:underline">
          ← กลับไปหน้ารายการหลักสูตร
        </Link>
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">
          {course.titleTh}
        </h1>
        <CourseStatusBadge status={course.status} />
      </div>
      <p className="mt-1 text-sm text-ink-500">
        รหัสหลักสูตร {course.code} · เวอร์ชัน {course.version} · อัปเดตล่าสุด {formatThaiDate(course.updatedAt)}
      </p>

      <div className="mt-5">
        <CourseFormSkeleton course={course} categoryName={categoryName} />
      </div>

      <section aria-labelledby="publish-actions-heading" className="mt-4 rounded-[14px] border border-mist-200 bg-white p-5 shadow-card sm:p-6">
        <h2 id="publish-actions-heading" className="font-heading text-lg font-semibold text-ink-900">
          การเผยแพร่
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          วงจรชีวิตหลักสูตร: ร่าง → รอตรวจ → เผยแพร่แล้ว → เก็บเข้าคลัง (SRS CAT-005)
        </p>

        {canPublish ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled
                title={PUBLISH_NEXT_NOTE}
                className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card disabled:cursor-not-allowed disabled:bg-mist-200 disabled:text-ink-500"
              >
                เผยแพร่
              </button>
              <button
                type="button"
                disabled
                title={PUBLISH_NEXT_NOTE}
                className="rounded-[10px] border-[1.5px] border-mist-300 bg-white px-[18px] py-2.5 font-heading text-base font-semibold text-ink-600 disabled:cursor-not-allowed disabled:bg-mist-200 disabled:text-ink-500"
              >
                ยกเลิกการเผยแพร่
              </button>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-500">{PUBLISH_NEXT_NOTE}</p>
          </div>
        ) : (
          <p className="mt-4 rounded-[10px] bg-brand-50 px-3 py-2 text-sm leading-relaxed text-brand-700">
            บทบาท staff:viewer เป็นโหมดดูอย่างเดียว — ไม่มีสิทธิ์เผยแพร่/ยกเลิกการเผยแพร่
            (course:publish เฉพาะ staff:content/super_admin ตาม RBAC §2.1)
          </p>
        )}
      </section>
    </div>
  );
}
