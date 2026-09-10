import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseStatusBadge } from "@/components/admin/StatusBadge";
import { CourseFormSkeleton } from "@/components/admin/CourseFormSkeleton";
import { AdminDataState } from "@/components/admin/AdminDataState";
import {
  adminCanWrite,
  adminPrimaryRole,
} from "@/components/admin/RoleModeBanner";
import {
  formatThaiDate,
  getAdminCategories,
  getAdminCourses,
  getAdminStaffSession,
  type AdminCourse,
  type AdminDataErrorKind,
} from "@/lib/fixtures/admin";

export const metadata: Metadata = {
  title: "รายละเอียดหลักสูตร · หลังบ้านจัดการเนื้อหา",
  description:
    "ดูข้อมูลหลักสูตรและสถานะเผยแพร่ (ข้อมูลจริงจาก GET /api/v1/admin/courses — ปุ่มเผยแพร่ยังไม่เชื่อมต่อ PATCH /api/v1/admin/courses/{id})",
};

/**
 * หน้ารายละเอียดยังไม่มี GET /admin/courses/{id} ในสเปก §3.8 —
 * หน้าจึงดึงข้อมูลจาก list endpoint แล้วหาหลักสูตรตาม id โดย**ไล่ตาม cursor**
 * จนครบทุกหน้า (gate r5: เดิมอ่านเฉพาะ 100 แถวแรก หลักสูตรที่อยู่หลังหน้าแรก
 * ได้ 404 ผิด) · cap 20 หน้ากัน loop ไม่รู้จบ (ผิดปกติ — ถือว่าไม่พบ)
 */
const DETAIL_LIST_LIMIT = 100;
const DETAIL_MAX_PAGES = 20;

type CourseDetailResult =
  | { ok: true; course: AdminCourse | null }
  | { ok: false; kind: AdminDataErrorKind };

async function findCourseById(id: string): Promise<CourseDetailResult> {
  let cursor: string | undefined;
  for (let page = 0; page < DETAIL_MAX_PAGES; page += 1) {
    const result = await getAdminCourses({ limit: DETAIL_LIST_LIMIT, cursor });
    if (!result.ok) {
      return result;
    }
    const hit = result.data.data.find((item) => item.id === id);
    if (hit !== undefined) {
      return { ok: true, course: hit };
    }
    cursor = result.data.page.nextCursor ?? undefined;
    if (cursor === undefined) {
      return { ok: true, course: null }; // ไล่ครบทุกหน้าแล้วไม่เจอ = ไม่มีจริง
    }
  }
  return { ok: true, course: null }; // เกิน cap (ผิดปกติ) — ถือว่าไม่พบ ไม่ loop ต่อ
}

/** ปุ่มเผยแพร่ยังไม่เชื่อมต่อ — PATCH /admin/courses/{id} อยู่นอกขอบเขต C-8 Phase 1 */
const PUBLISH_NEXT_NOTE =
  "ยังไม่เชื่อมต่อ API — เชื่อมต่อในเฟสถัดไป: PATCH /api/v1/admin/courses/{id} (เปลี่ยนสถานะเผยแพร่ พร้อมบันทึก audit COURSE_PUBLISH)";

export default async function AdminCourseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sessionResult = await getAdminStaffSession();
  const detail = await findCourseById(id);
  if (!detail.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">
          รายละเอียดหลักสูตร
        </h1>
        <div className="mt-4">
          <AdminDataState kind={detail.kind} retryHref="/admin/courses" />
        </div>
      </div>
    );
  }
  if (detail.course === null) {
    notFound();
  }
  const course = detail.course;
  const primaryRole =
    sessionResult.ok && sessionResult.staff !== null
      ? adminPrimaryRole(sessionResult.staff.roles)
      : "staff:viewer";
  const canPublish = adminCanWrite(primaryRole);
  const categories = await getAdminCategories();
  const categoryName =
    (categories.ok
      ? categories.data.find((category) => category.id === course.categoryId)?.nameTh
      : undefined) ?? "—";

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
        รหัสหลักสูตร {course.code} · เวอร์ชัน {course.version} · สร้างเมื่อ {formatThaiDate(course.createdAt)}
      </p>

      <div className="mt-5">
        <CourseFormSkeleton course={course} categoryName={categoryName} />
      </div>

      <section
        aria-labelledby="publish-actions-heading"
        className="mt-4 rounded-[14px] border border-mist-200 bg-white p-5 shadow-card sm:p-6"
      >
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
            โหมดดูอย่างเดียว — บทบาทของท่านไม่มีสิทธิ์เผยแพร่/ยกเลิกการเผยแพร่
            (course:publish เฉพาะ staff:content/super_admin ตาม RBAC §2.1)
          </p>
        )}
      </section>
    </div>
  );
}
