import type { Metadata } from "next";
import Link from "next/link";

import { AdminDataState } from "@/components/admin/AdminDataState";
import { AssessmentFormModal } from "@/components/admin/AssessmentFormModal";
import { AssessmentRulesVersionModal } from "@/components/admin/AssessmentRulesVersionModal";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { getAdminCourses, getAdminStaffSession } from "@/lib/fixtures/admin";
import { getAdminAssessments } from "@/lib/exam-admin.server";
import {
  ASSESSMENT_STATUS_LABEL_TH,
  ASSESSMENT_STATUS_TONE,
  assessmentKindLabel,
  assessmentRulesSummaryLine,
  canCreateAssessment,
  canWriteAssessmentRules,
  firstSearchParam,
  formatThaiDateTime,
  isExamAdminAssessmentStatus,
  type ExamAdminAssessment,
} from "@/lib/exam-admin.view";

export const metadata: Metadata = {
  title: "ชุดข้อสอบ · หลังบ้านสอบ",
  description:
    "รายการชุดข้อสอบและกติกาการสอบ (GET /api/v1/admin/assessments) — สร้างชุดข้อสอบใหม่ได้จากหน้านี้",
};

/** ชิปกรองสถานะ — ทั้งหมด + 4 สถานะจริงของ enum assessment_status */
const STATUS_FILTERS = [
  { value: "all", label: "ทั้งหมด" },
  { value: "draft", label: ASSESSMENT_STATUS_LABEL_TH.draft },
  { value: "published", label: ASSESSMENT_STATUS_LABEL_TH.published },
  { value: "closed", label: ASSESSMENT_STATUS_LABEL_TH.closed },
  { value: "archived", label: ASSESSMENT_STATUS_LABEL_TH.archived },
] as const;

/** href ของหน้ารายการ — รักษา status/cursor ที่เลือกไว้ (URL = state จริง) */
function buildAssessmentsHref(options: {
  status?: string | undefined;
  cursor?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (options.status !== undefined && options.status !== "all" && options.status.length > 0) {
    search.set("status", options.status);
  }
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/assessments?${query}` : "/admin/assessments";
}

export default async function AdminAssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawStatus = firstSearchParam(params["status"]);
  const cursor = firstSearchParam(params["cursor"]);
  const status = isExamAdminAssessmentStatus(rawStatus) ? rawStatus : undefined;

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — การตัดสินจริงอยู่ที่ BFF เสมอ */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canCreate = canCreateAssessment(roles);
  const allowRules = canWriteAssessmentRules(roles);

  const result = await getAdminAssessments({
    status,
    cursor,
  });
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ชุดข้อสอบ</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/assessments" />
        </div>
      </div>
    );
  }
  const { data: rows, page } = result.data;

  /* ตัวเลือกหลักสูตรของฟอร์มสร้าง — โหลดเมื่อจะสร้างได้เท่านั้น */
  const courseOptions = canCreate
    ? await (async () => {
        const courses = await getAdminCourses({ limit: 100 });
        return courses.ok
          ? courses.data.data.map((course) => ({
              id: course.id,
              label: `${course.code} · ${course.titleTh}`,
            }))
          : [];
      })()
    : [];

  const columns: Array<DataTableColumn<ExamAdminAssessment>> = [
    {
      id: "code",
      header: "รหัส",
      render: (assessment) => (
        <span className="font-semibold text-ink-900">{assessment.code}</span>
      ),
    },
    {
      id: "title",
      header: "ชื่อชุดข้อสอบ",
      render: (assessment) => <span className="text-ink-900">{assessment.title}</span>,
    },
    {
      id: "kind",
      header: "ประเภท",
      render: (assessment) => <span>{assessmentKindLabel(assessment.isFinal)}</span>,
    },
    {
      id: "status",
      header: "สถานะ",
      render: (assessment) => (
        <StatusBadge
          label={ASSESSMENT_STATUS_LABEL_TH[assessment.status]}
          tone={ASSESSMENT_STATUS_TONE[assessment.status]}
        />
      ),
    },
    {
      id: "rules",
      header: "กติกา (เวอร์ชันล่าสุด)",
      render: (assessment) => (
        <span className="text-ink-600">{assessmentRulesSummaryLine(assessment.rules)}</span>
      ),
    },
    {
      id: "created",
      header: "สร้างเมื่อ",
      align: "end",
      render: (assessment) => (
        <span className="whitespace-nowrap text-ink-600">
          {formatThaiDateTime(assessment.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ชุดข้อสอบ</h1>
      <p className="mt-1 text-sm text-ink-500">
        รายการชุดข้อสอบทุกสถานะ (GET /api/v1/admin/assessments — ข้อมูลจาก BFF)
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="กรองตามสถานะชุดข้อสอบ">
          <ul className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((option) => {
              const active =
                option.value === "all" ? status === undefined : option.value === status;
              return (
                <li key={option.value}>
                  <Link
                    href={buildAssessmentsHref({ status: option.value })}
                    aria-current={active ? "true" : undefined}
                    className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold ${
                      active
                        ? "bg-brand-600 text-white"
                        : "border border-brand-600 bg-white text-brand-700 hover:bg-brand-50"
                    }`}
                  >
                    {option.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <AssessmentFormModal
          courseOptions={courseOptions}
          canCreate={canCreate}
          allowRules={allowRules}
        />
        {/* เพิ่มกติกา version ใหม่ (Wave G P3 D87) — เขียนกติกาได้เฉพาะ staff:exam/super_admin */}
        {allowRules ? (
          <AssessmentRulesVersionModal
            assessmentOptions={rows.map((assessment) => ({
              id: assessment.id,
              label: `${assessment.code} · ${assessment.title}`,
              currentVersion: assessment.rules?.version ?? null,
              // กติกาล่าสุดทั้งแถว — โมดัลใช้ prefill ฟอร์มและส่งต่อ selection เดิม
              currentRules:
                assessment.rules === null
                  ? null
                  : {
                      version: assessment.rules.version,
                      timeLimitMinutes: assessment.rules.timeLimitMinutes,
                      questionCount: assessment.rules.questionCount,
                      passPct: assessment.rules.passPct,
                      maxAttempts: assessment.rules.maxAttempts,
                      cooldownMinutes: assessment.rules.cooldownMinutes,
                      shuffleQuestions: assessment.rules.shuffleQuestions,
                      shuffleOptions: assessment.rules.shuffleOptions,
                      requireCourseComplete: assessment.rules.requireCourseComplete,
                      selection: assessment.rules.selection,
                      proctoringMode: assessment.rules.proctoringMode,
                      examReviewMode: assessment.rules.examReviewMode,
                    },
            }))}
            allowRules={allowRules}
          />
        ) : null}
      </div>

      <div className="mt-4">
        <DataTable
          caption="ตารางชุดข้อสอบ (ข้อมูลจาก BFF — แถวผิดรูปจะไม่ถูกแสดง)"
          columns={columns}
          rows={rows}
          getKey={(assessment) => assessment.id}
          emptyTitle="ยังไม่มีชุดข้อสอบตามเงื่อนไขที่เลือก"
          emptyHint="สร้างชุดข้อสอบใหม่ด้วยปุ่มด้านบน หรือเปลี่ยนตัวกรองสถานะ"
        />
      </div>

      <p className="mt-3 text-sm text-ink-500">
        หน้านี้แสดง {rows.length} ชุดข้อสอบ
        {page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>
      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildAssessmentsHref({ status: status, cursor: page.nextCursor })}
          className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          หน้าถัดไป
        </Link>
      ) : null}
    </div>
  );
}
