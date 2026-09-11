import type { Metadata } from "next";
import Link from "next/link";

import { AdminDataState } from "@/components/admin/AdminDataState";
import {
  CertificateManagePanel,
  IssueCertificateButton,
} from "@/components/admin/CertificateActions";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { getAdminCourses, getAdminStaffSession } from "@/lib/fixtures/admin";
import { getEligibleAttempts } from "@/lib/exam-admin.server";
import {
  canIssueCertificate,
  canRevokeCertificate,
  firstSearchParam,
  formatThaiDateTime,
  type ExamAdminEligibleAttempt,
} from "@/lib/exam-admin.view";

export const metadata: Metadata = {
  title: "ประกาศนียบัตร · หลังบ้านสอบ",
  description:
    "คิวผู้มีสิทธิ์รับประกาศนียบัตรและการจัดการใบ — ออกใบ เพิกถอน และออกใบแทน",
};

/**
 * หน้าทะเบียนประกาศนียบัตร — คิวผู้มีสิทธิ์รับใบ + แผงจัดการใบที่ออกแล้ว
 * - คิว: GET /api/v1/admin/certificates/eligible (สิทธิ์ certificate:issue — SoD T9)
 * - ออกใบ: ปุ่มต่อแถว → POST /api/v1/admin/certificates
 * - เพิกถอน/ออกใบแทน: แผงรับ uuid ของใบ (ยังไม่มี endpoint รายการใบ — ธงให้ lead)
 * - การแสดงชื่อผู้เรียนถูกบันทึก audit ที่ BFF อยู่แล้ว — หน้าไม่ log เอง
 */

/** href ของหน้ารายการคิว — รักษา cursor ที่เลือกไว้ (URL = state จริง) */
function buildCertificatesHref(options: { cursor?: string }): string {
  const search = new URLSearchParams();
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/certificates?${query}` : "/admin/certificates";
}

export default async function AdminCertificatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const cursor = firstSearchParam(params["cursor"]);

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — การตัดสินจริงอยู่ที่ BFF เสมอ (SoD T9) */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canIssue = canIssueCertificate(roles);
  const canRevoke = canRevokeCertificate(roles);

  /* คิวผู้มีสิทธิ์รับใบ — โหลดเมื่อมีสิทธิ์ออกใบเท่านั้น (ข้อมูลผู้เรียน = PII) */
  const queue = canIssue ? await getEligibleAttempts({ cursor }) : null;
  if (queue !== null && !queue.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">
          ประกาศนียบัตร
        </h1>
        <div className="mt-4">
          <AdminDataState kind={queue.kind} retryHref="/admin/certificates" />
        </div>
      </div>
    );
  }
  const queueRows = queue !== null && queue.ok ? queue.data.data : [];
  const queuePage = queue !== null && queue.ok ? queue.data.page : null;

  /* แผนชื่อหลักสูตรสำหรับคอลัมน์หลักสูตร — โหลดเมื่อมีคิวเท่านั้น (ไม่ใช่ชั้นความปลอดภัย) */
  const courses = queueRows.length > 0 ? await getAdminCourses({ limit: 100 }) : null;
  const courseTitleById =
    courses !== null && courses.ok
      ? new Map(courses.data.data.map((course) => [course.id, course.titleTh]))
      : new Map<string, string>();

  const columns: Array<DataTableColumn<ExamAdminEligibleAttempt>> = [
    {
      id: "holder",
      header: "ผู้มีสิทธิ์รับใบ",
      render: (attempt) => (
        <span className="font-semibold text-ink-900">
          {attempt.holderName.length > 0 ? attempt.holderName : "(ยังไม่ระบุชื่อ)"}
        </span>
      ),
    },
    {
      id: "course",
      header: "หลักสูตร",
      render: (attempt) => <span>{courseTitleById.get(attempt.courseId) ?? "—"}</span>,
    },
    {
      id: "score",
      header: "คะแนน (%)",
      render: (attempt) => <span>{attempt.scorePct === null ? "—" : attempt.scorePct}</span>,
    },
    {
      id: "submitted",
      header: "ส่งเมื่อ",
      render: (attempt) => (
        <span className="whitespace-nowrap text-ink-600">
          {formatThaiDateTime(attempt.submittedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "การจัดการ",
      render: (attempt) => (
        <IssueCertificateButton
          enrollmentId={attempt.enrollmentId}
          holderName={attempt.holderName}
          courseTitle={courseTitleById.get(attempt.courseId) ?? "—"}
          canIssue={canIssue}
        />
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ประกาศนียบัตร</h1>
      <p className="mt-1 text-sm text-ink-500">
        คิวผู้ผ่านเกณฑ์รอออกใบ และการจัดการใบที่ออกแล้ว (ทะเบียนประกาศนียบัตร)
      </p>

      {canIssue ? (
        <section className="mt-6">
          <h2 className="font-heading text-base font-semibold text-ink-900">
            คิวผู้มีสิทธิ์รับประกาศนียบัตร
          </h2>
          <div className="mt-3">
            <DataTable
              caption="ตารางคิวผู้มีสิทธิ์รับใบ (ข้อมูลจาก BFF — แถวผิดรูปจะไม่ถูกแสดง)"
              columns={columns}
              rows={queueRows}
              getKey={(attempt) => attempt.attemptId}
              emptyTitle="ยังไม่มีผู้ผ่านเกณฑ์รอออกใบ"
              emptyHint="ผู้เรียนที่สอบผ่านเกณฑ์และยังไม่มีใบ valid จะปรากฏในคิวนี้"
            />
          </div>
          <p className="mt-3 text-sm text-ink-500">
            หน้านี้แสดง {queueRows.length} รายการ
            {queuePage !== null && queuePage.hasMore ? " — ยังมีรายการต่อ" : ""}
          </p>
          {queuePage !== null && queuePage.hasMore && queuePage.nextCursor !== null ? (
            <Link
              href={buildCertificatesHref({ cursor: queuePage.nextCursor })}
              className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
            >
              หน้าถัดไป
            </Link>
          ) : null}
        </section>
      ) : (
        <p className="mt-5 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
          คุณไม่มีสิทธิ์ออกประกาศนียบัตร — คิวจะแสดงเฉพาะผู้รับผิดชอบทะเบียน
        </p>
      )}

      <div className="mt-6">
        <CertificateManagePanel canRevoke={canRevoke} />
      </div>
    </div>
  );
}
