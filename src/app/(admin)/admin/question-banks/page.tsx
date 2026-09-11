import type { Metadata } from "next";
import Link from "next/link";

import { AdminDataState } from "@/components/admin/AdminDataState";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { QuestionBankFormModal } from "@/components/admin/QuestionBankFormModal";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { getAdminCategories, getAdminCourses, getAdminStaffSession } from "@/lib/fixtures/admin";
import { getAdminQuestionBanks } from "@/lib/exam-admin.server";
import {
  canCreateQuestionBank,
  firstSearchParam,
  formatThaiDateTime,
  type ExamAdminQuestionBank,
} from "@/lib/exam-admin.view";

export const metadata: Metadata = {
  title: "คลังข้อสอบ · หลังบ้านสอบ",
  description:
    "รายการคลังข้อสอบ (GET /api/v1/admin/question-banks) — สร้างคลังพร้อมแนบข้อสอบได้จากหน้านี้",
};

/** href ของหน้ารายการ — รักษา cursor ที่เลือกไว้ */
function buildQuestionBanksHref(options: { cursor?: string }): string {
  const search = new URLSearchParams();
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/question-banks?${query}` : "/admin/question-banks";
}

export default async function AdminQuestionBanksPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const cursor = firstSearchParam(params["cursor"]);

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — การตัดสินจริงอยู่ที่ BFF เสมอ */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canCreate = canCreateQuestionBank(roles);

  const result = await getAdminQuestionBanks({ cursor });
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คลังข้อสอบ</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/question-banks" />
        </div>
      </div>
    );
  }
  const { data: rows, page } = result.data;

  /* ตัวเลือกหลักสูตร/หมวดของฟอร์มสร้าง — โหลดเมื่อจะสร้างได้เท่านั้น */
  const courseOptions = canCreate ? await getAdminCourses({ limit: 100 }) : null;
  const categoryOptions = canCreate ? await getAdminCategories() : null;
  const bankCourseOptions = courseOptions?.ok
    ? courseOptions.data.data.map((course) => ({
        id: course.id,
        label: `${course.code} · ${course.titleTh}`,
      }))
    : [];
  const bankCategoryOptions = categoryOptions?.ok
    ? categoryOptions.data.map((category) => ({
        id: category.id,
        label: category.nameTh,
      }))
    : [];

  const columns: Array<DataTableColumn<ExamAdminQuestionBank>> = [
    {
      id: "code",
      header: "รหัสคลัง",
      render: (bank) => <span className="font-semibold text-ink-900">{bank.code}</span>,
    },
    {
      id: "name",
      header: "ชื่อคลังข้อสอบ",
      render: (bank) => <span className="text-ink-900">{bank.name}</span>,
    },
    {
      id: "questionCount",
      header: "จำนวนข้อสอบ",
      render: (bank) => <span>{bank.questionCount} ข้อ</span>,
    },
    {
      id: "isActive",
      header: "สถานะการใช้งาน",
      render: (bank) => (
        <StatusBadge
          label={bank.isActive ? "เปิดใช้งาน" : "ปิดใช้งาน"}
          tone={bank.isActive ? "success" : "neutral"}
          withDot={bank.isActive}
        />
      ),
    },
    {
      id: "created",
      header: "สร้างเมื่อ",
      align: "end",
      render: (bank) => (
        <span className="whitespace-nowrap text-ink-600">
          {formatThaiDateTime(bank.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คลังข้อสอบ</h1>
      <p className="mt-1 text-sm text-ink-500">
        รายการคลังข้อสอบ (GET /api/v1/admin/question-banks — ข้อมูลจาก BFF · จำนวนข้อนับฝั่งฐานข้อมูล)
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-600">
          คลังข้อสอบรวบรวมโจทย์ของหลักสูตร/หมวดที่เกี่ยวข้อง — เนื้อหาข้อสอบและเฉลยจัดการในขั้นตอนเรียบเรียงข้อสอบของผู้ดูแลข้อสอบ
        </p>
        <QuestionBankFormModal
          courseOptions={bankCourseOptions}
          categoryOptions={bankCategoryOptions}
          canCreate={canCreate}
        />
      </div>

      <div className="mt-4">
        <DataTable
          caption="ตารางคลังข้อสอบ (ข้อมูลจาก BFF — แถวผิดรูปจะไม่ถูกแสดง)"
          columns={columns}
          rows={rows}
          getKey={(bank) => bank.id}
          emptyTitle="ยังไม่มีคลังข้อสอบ"
          emptyHint="สร้างคลังข้อสอบใหม่ด้วยปุ่มด้านบน"
        />
      </div>

      <p className="mt-3 text-sm text-ink-500">
        หน้านี้แสดง {rows.length} คลังข้อสอบ
        {page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>
      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildQuestionBanksHref({ cursor: page.nextCursor })}
          className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          หน้าถัดไป
        </Link>
      ) : null}
    </div>
  );
}
