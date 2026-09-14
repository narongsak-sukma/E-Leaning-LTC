import type { Metadata } from "next";
import Link from "next/link";

import { AdminDataState } from "@/components/admin/AdminDataState";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import {
  QUESTION_TYPE_LABEL_TH,
  formatThaiDateTime,
  firstSearchParam,
} from "@/lib/exam-admin.view";

import { EditQuestionModal } from "./EditQuestionModal";
import { StatusConfirm } from "./StatusConfirm";
import {
  BANK_POOL_HINT_TH,
  QUESTION_STATUS_LABEL_TH,
  QUESTION_STATUS_TONE,
  canEditQuestionBank,
  canToggleQuestionStatus,
  truncateQuestionTextTh,
  type BankQuestionRow,
} from "./bank-detail.view";
import {
  loadAdminBankQuestions,
  loadAdminQuestionBank,
  type BankDetailFailure,
} from "./bank-detail.server";

export const metadata: Metadata = {
  title: "จัดการคลังข้อสอบ · หลังบ้านสอบ",
  description:
    "รายละเอียดคลังข้อสอบ (GET /api/v1/admin/question-banks/{id}) — ตารางข้อสอบ · แก้ข้อรายข้อ · เปิด/ปลดข้อสอบ",
};

/** href ของรายการข้อ — รักษา cursor ที่เลือกไว้ */
function buildBankQuestionsHref(bankId: string, cursor: string): string {
  const search = new URLSearchParams();
  search.set("cursor", cursor);
  return `/admin/question-banks/${bankId}?${search.toString()}`;
}

/** แผงแสดงผลเมื่อโหลดล้ม — ไม่มีสิทธิ์/ระบบขัดข้อง ใช้แผงกลาง ไม่พบ = แผงเฉพาะ (ต่างจากคลังว่าง) */
function DetailFailurePanel({ result, bankId }: {
  readonly result: BankDetailFailure;
  readonly bankId: string;
}) {
  if (result.kind === "not-found") {
    return (
      <div
        className="rounded-[14px] border border-mist-200 bg-white p-10 text-center shadow-card"
        role="status"
      >
        <p className="font-heading text-base font-semibold text-ink-900">ไม่พบคลังข้อสอบ</p>
        <p className="mt-1 text-sm text-ink-500">
          คลังอาจถูกลบ หรือไม่อยู่ในสิทธิ์การเข้าถึงของคุณ
        </p>
        <Link
          href="/admin/question-banks"
          className="mt-4 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          กลับไปยังรายการคลังข้อสอบ
        </Link>
      </div>
    );
  }
  const kind = result.kind === "forbidden" ? "forbidden" : "server";
  return (
    <div className="mt-4">
      <AdminDataState kind={kind} retryHref={`/admin/question-banks/${bankId}`} />
    </div>
  );
}

export default async function AdminQuestionBankDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const cursor = firstSearchParam((await searchParams)["cursor"]);

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — การตัดสินจริงอยู่ที่ BFF เสมอ */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canEdit = canEditQuestionBank(roles);
  const canToggle = canToggleQuestionStatus(roles);

  const bankResult = await loadAdminQuestionBank(id);
  if (!bankResult.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คลังข้อสอบ</h1>
        <DetailFailurePanel result={bankResult} bankId={id} />
      </div>
    );
  }
  const bank = bankResult.data;

  const questionsResult = await loadAdminBankQuestions(id, { cursor });
  if (!questionsResult.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">
          {bank.code} · {bank.name}
        </h1>
        <DetailFailurePanel result={questionsResult} bankId={id} />
      </div>
    );
  }
  const { data: rows, page } = questionsResult.data;

  const columns: Array<DataTableColumn<BankQuestionRow>> = [
    {
      id: "question",
      header: "โจทย์",
      render: (question) => (
        <span className="text-ink-900">{truncateQuestionTextTh(question.questionText)}</span>
      ),
    },
    {
      id: "type",
      header: "ประเภท",
      render: (question) => <span>{QUESTION_TYPE_LABEL_TH[question.type]}</span>,
    },
    {
      id: "points",
      header: "คะแนน",
      align: "end",
      render: (question) => <span className="tabular-nums">{question.points}</span>,
    },
    {
      id: "status",
      header: "สถานะข้อสอบ",
      render: (question) => (
        <StatusBadge
          label={QUESTION_STATUS_LABEL_TH[question.status]}
          tone={QUESTION_STATUS_TONE[question.status]}
          withDot={question.status === "active"}
        />
      ),
    },
    {
      id: "version",
      header: "เวอร์ชัน",
      align: "end",
      render: (question) => <span className="tabular-nums">v{question.version}</span>,
    },
    {
      id: "actions",
      header: "การกระทำ",
      render: (question) => (
        <div className="flex items-center gap-3 whitespace-nowrap">
          <EditQuestionModal bankId={id} qid={question.id} canEdit={canEdit} />
          <StatusConfirm bankId={id} qid={question.id} status={question.status} canToggle={canToggle} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <Link
        href="/admin/question-banks"
        className="text-sm font-semibold text-brand-700 hover:underline"
      >
        ← รายการคลังข้อสอบ
      </Link>
      <h1 className="mt-2 font-heading text-xl font-bold text-ink-900 sm:text-2xl">
        {bank.code} · {bank.name}
      </h1>
      <p className="mt-1 text-sm text-ink-500">
        รายละเอียดคลังข้อสอบ (GET /api/v1/admin/question-banks/{id} — ข้อมูลจาก BFF · แถวผิดรูปจะไม่ถูกแสดง)
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <StatusBadge
          label={bank.isActive ? "เปิดใช้งาน" : "ปิดใช้งาน"}
          tone={bank.isActive ? "success" : "neutral"}
          withDot={bank.isActive}
        />
        <span className="text-sm text-ink-600">
          {bank.questionCount} ข้อ · สร้างเมื่อ {formatThaiDateTime(bank.createdAt)}
        </span>
      </div>
      <p className="mt-2 rounded-[10px] bg-mist-50 p-3 text-sm text-ink-600">
        {BANK_POOL_HINT_TH}
      </p>
      {bank.description !== null ? (
        <p className="mt-2 text-sm text-ink-600">{bank.description}</p>
      ) : null}

      <div className="mt-4">
        <DataTable
          caption="ตารางข้อสอบในคลัง (แถวไม่มีเฉลย — ข้อมูลจาก BFF)"
          columns={columns}
          rows={rows}
          getKey={(question) => question.id}
          emptyTitle="ยังไม่มีข้อสอบในคลังนี้"
          emptyHint="ข้อสอบเริ่มต้นสถานะ “ร่าง” — เปิดใช้งานเมื่อเรียบเรียงเสร็จ"
        />
      </div>

      <p className="mt-3 text-sm text-ink-500">
        หน้านี้แสดง {rows.length} ข้อสอบ
        {page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>
      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildBankQuestionsHref(id, page.nextCursor)}
          className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          หน้าถัดไป
        </Link>
      ) : null}
    </div>
  );
}
