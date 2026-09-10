import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { CourseStatusBadge } from "@/components/admin/StatusBadge";
import {
  adminCategories,
  adminCourses,
  formatThaiDate,
  isCourseStatus,
  type AdminCourse,
} from "@/lib/fixtures/admin";

export const metadata: Metadata = {
  title: "หลักสูตร · หลังบ้านจัดการเนื้อหา",
  description:
    "รายการหลักสูตรทุกสถานะสำหรับเจ้าหน้าที่ (โครงหน้าจอ — ข้อมูลจำลอง ยังไม่เชื่อมต่อ GET /api/v1/admin/courses)",
};

const FILTER_OPTIONS = [
  { value: "all", label: "ทั้งหมด" },
  { value: "draft", label: "ร่าง" },
  { value: "pending_review", label: "รอตรวจ" },
  { value: "published", label: "เผยแพร่แล้ว" },
  { value: "archived", label: "เก็บเข้าคลัง" },
] as const;

type CourseFilter = (typeof FILTER_OPTIONS)[number]["value"];

export default async function AdminCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { status } = await searchParams;
  const filter: CourseFilter = isCourseStatus(status) ? status : "all";
  const rows =
    filter === "all" ? adminCourses : adminCourses.filter((course) => course.status === filter);
  const categoryNameById = new Map(adminCategories.map((category) => [category.id, category.nameTh]));

  const columns: Array<DataTableColumn<AdminCourse>> = [
    {
      id: "code",
      header: "รหัส",
      render: (course) => (
        <span className="font-semibold text-ink-900">{course.code}</span>
      ),
    },
    {
      id: "title",
      header: "ชื่อหลักสูตร",
      render: (course) => (
        <div>
          <p className="font-semibold text-ink-900">{course.titleTh}</p>
          {course.titleEn ? (
            <p className="text-xs text-ink-500">{course.titleEn}</p>
          ) : null}
        </div>
      ),
    },
    {
      id: "category",
      header: "หมวด",
      render: (course) => <span>{categoryNameById.get(course.categoryId) ?? "—"}</span>,
    },
    {
      id: "status",
      header: "สถานะ",
      render: (course) => <CourseStatusBadge status={course.status} />,
    },
    {
      id: "updated",
      header: "อัปเดต",
      align: "end",
      render: (course) => (
        <span className="whitespace-nowrap text-ink-600">{formatThaiDate(course.updatedAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "การจัดการ",
      render: (course) => (
        <Link
          href={`/admin/courses/${course.id}`}
          aria-label={`ดูรายละเอียดหลักสูตร ${course.titleTh}`}
          className="font-semibold text-brand-600 hover:underline"
        >
          ดูรายละเอียด
        </Link>
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">หลักสูตร</h1>
      <p className="mt-1 text-sm text-ink-500">
        รายการหลักสูตรทุกสถานะ (GET /api/v1/admin/courses — เชื่อมต่อในเฟสถัดไป)
      </p>

      <p className="mt-4 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
        การสร้าง/แก้ไขเนื้อหาหลักสูตร (authoring) เลื่อนออกนอก Wave C ตาม D25-O3 —
        ปัจจุบันสร้างหลักสูตรด้วย seed และจะเปิดหน้าจอจัดการในเฟสถัดไป
      </p>

      <nav aria-label="กรองตามสถานะหลักสูตร" className="mt-5">
        <ul className="flex flex-wrap gap-2">
          {FILTER_OPTIONS.map((option) => {
            const active = option.value === filter;
            const href =
              option.value === "all"
                ? "/admin/courses"
                : `/admin/courses?status=${option.value}`;
            return (
              <li key={option.value}>
                <Link
                  href={href}
                  aria-current={active ? "true" : undefined}
                  className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold ${
                    active
                      ? "bg-brand-600 text-white"
                      : "border border-brand-600 bg-white text-brand-700 hover:bg-brand-50"
                  }`}
                >
                  {option.label}
                  <span className="sr-only">สถานะ</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-4">
        <DataTable
          caption="ตารางหลักสูตร (ข้อมูลจำลอง)"
          columns={columns}
          rows={rows}
          getKey={(course) => course.id}
          emptyTitle="ยังไม่มีหลักสูตรตามเงื่อนไขที่เลือก"
          emptyHint="ลองเลือกสถานะอื่นเพื่อดูรายการหลักสูตร"
        />
      </div>
      <p className="mt-3 text-sm text-ink-500">
        แสดง {rows.length} จาก {adminCourses.length} หลักสูตร (ข้อมูลจำลอง)
      </p>
    </div>
  );
}
