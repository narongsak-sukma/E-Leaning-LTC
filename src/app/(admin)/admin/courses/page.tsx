import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { CourseStatusBadge } from "@/components/admin/StatusBadge";
import { AdminDataState } from "@/components/admin/AdminDataState";
import {
  ADMIN_COURSES_PAGE_SIZE,
  formatThaiDate,
  getAdminCategories,
  getAdminCourses,
  isCourseStatus,
  type AdminCourse,
} from "@/lib/fixtures/admin";

export const metadata: Metadata = {
  title: "หลักสูตร · หลังบ้านจัดการเนื้อหา",
  description:
    "รายการหลักสูตรทุกสถานะสำหรับเจ้าหน้าที่ (เชื่อม GET /api/v1/admin/courses จริงแล้ว — Phase 1)",
};

const FILTER_OPTIONS = [
  { value: "all", label: "ทั้งหมด" },
  { value: "draft", label: "ร่าง" },
  { value: "pending_review", label: "รอตรวจ" },
  { value: "published", label: "เผยแพร่แล้ว" },
  { value: "archived", label: "เก็บเข้าคลัง" },
] as const;

type CourseFilter = (typeof FILTER_OPTIONS)[number]["value"];

/** ตรวจ searchParams แบบ multi-value — ใช้ค่าแรก (string | string[] | undefined) */
function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** สร้าง href ของหน้ารายการ — รักษา status/q/cursor ที่เลือกไว้ (URL = state จริง) */
function buildCoursesHref(options: {
  status?: CourseFilter;
  q?: string;
  cursor?: string;
}): string {
  const search = new URLSearchParams();
  if (options.status !== undefined && options.status !== "all") {
    search.set("status", options.status);
  }
  if (options.q !== undefined && options.q.length > 0) {
    search.set("q", options.q);
  }
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/courses?${query}` : "/admin/courses";
}

export default async function AdminCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawStatus = firstParam(params["status"]);
  const q = firstParam(params["q"]) ?? "";
  const cursor = firstParam(params["cursor"]);
  const filter: CourseFilter = isCourseStatus(rawStatus) ? rawStatus : "all";

  const result = await getAdminCourses({
    q: q.length > 0 ? q : undefined,
    status: filter === "all" ? undefined : filter,
    cursor,
    limit: ADMIN_COURSES_PAGE_SIZE,
  });
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">หลักสูตร</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/courses" />
        </div>
      </div>
  );
  }
  const { data: rows, page } = result.data;
  const categories = await getAdminCategories();
  const categoryNameById = categories.ok
    ? new Map(categories.data.map((category) => [category.id, category.nameTh]))
    : undefined;

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
      render: (course) => <span>{categoryNameById?.get(course.categoryId) ?? "—"}</span>,
    },
    {
      id: "status",
      header: "สถานะ",
      render: (course) => <CourseStatusBadge status={course.status} />,
    },
    {
      id: "created",
      header: "สร้างเมื่อ",
      align: "end",
      render: (course) => (
        <span className="whitespace-nowrap text-ink-600">{formatThaiDate(course.createdAt)}</span>
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
        รายการหลักสูตรทุกสถานะ (GET /api/v1/admin/courses — ข้อมูลจริงจาก BFF)
      </p>

      <p className="mt-4 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
        การสร้าง/แก้ไขเนื้อหาหลักสูตร (authoring) เลื่อนออกนอก Wave C ตาม D25-O3 —
        ปัจจุบันสร้างหลักสูตรด้วย seed และจะเปิดหน้าจอจัดการในเฟสถัดไป
      </p>

      <form
        action="/admin/courses"
        method="get"
        role="search"
        className="mt-5 flex flex-wrap items-center gap-2"
      >
        {filter !== "all" ? (
          <input type="hidden" name="status" value={filter} />
        ) : null}
        <label htmlFor="course-search" className="sr-only">
          ค้นหาหลักสูตรจากรหัสหรือชื่อ
        </label>
        <input
          id="course-search"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="ค้นหาจากรหัสหรือชื่อหลักสูตร"
          className="w-full max-w-sm rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400"
        />
        <button
          type="submit"
          className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
        >
          ค้นหา
        </button>
        {q.length > 0 ? (
          <Link
            href={buildCoursesHref({ status: filter })}
            className="text-sm text-brand-600 hover:underline"
          >
            ล้างการค้นหา
          </Link>
        ) : null}
      </form>

      <nav aria-label="กรองตามสถานะหลักสูตร" className="mt-4">
        <ul className="flex flex-wrap gap-2">
          {FILTER_OPTIONS.map((option) => {
            const active = option.value === filter;
            return (
              <li key={option.value}>
                <Link
                  href={buildCoursesHref({ status: option.value, q })}
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
          caption="ตารางหลักสูตร (ข้อมูลจาก BFF — อัปเดตสดทุกครั้งที่เปิดหน้า)"
          columns={columns}
          rows={rows}
          getKey={(course) => course.id}
          emptyTitle="ยังไม่มีหลักสูตรตามเงื่อนไขที่เลือก"
          emptyHint="ลองเปลี่ยนสถานะหรือล้างคำค้นหา แล้วลองใหม่อีกครั้ง"
        />
      </div>

      <p className="mt-3 text-sm text-ink-500">
        หน้านี้แสดง {rows.length} หลักสูตร (สูงสุด {ADMIN_COURSES_PAGE_SIZE} หน้าละ)
        {page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>
      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildCoursesHref({ status: filter, q, cursor: page.nextCursor })}
          className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          หน้าถัดไป
        </Link>
      ) : null}
    </div>
  );
}



