import type { Metadata } from "next";
import Link from "next/link";

import { AdminDataState } from "@/components/admin/AdminDataState";
import {
  CertificateRowActions,
  IssueCertificateButton,
} from "@/components/admin/CertificateActions";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { getAdminCourses, getAdminStaffSession } from "@/lib/fixtures/admin";
import { getAdminCertificates, getEligibleAttempts } from "@/lib/exam-admin.server";
import {
  canIssueCertificate,
  canRevokeCertificate,
  CERT_STATUS_LABEL_TH,
  CERT_STATUS_OPTIONS,
  CERT_STATUS_TONE,
  firstSearchParam,
  formatThaiDateTime,
  isExamAdminCertificateStatus,
  type ExamAdminCertificateRow,
  type ExamAdminEligibleAttempt,
} from "@/lib/exam-admin.view";

export const metadata: Metadata = {
  title: "ประกาศนียบัตร · หลังบ้านสอบ",
  description:
    "คิวผู้มีสิทธิ์รับประกาศนียบัตร ทะเบียนใบที่ออกแล้ว และการจัดการใบ — ออกใบ เพิกถอน และออกใบแทน",
};

/**
 * หน้าทะเบียนประกาศนียบัตร (Wave E · PB-20) — คิวผู้มีสิทธิ์รับใบ + ทะเบียนใบที่ออกแล้ว
 * - คิว: GET /api/v1/admin/certificates/eligible (สิทธิ์ certificate:issue — SoD T9)
 * - ออกใบ: ปุ่มต่อแถว → POST /api/v1/admin/certificates (พฤติกรรมเดิมคงเดิม)
 * - ทะเบียน + ค้นหา: GET /api/v1/admin/certificates (D55-2 — staff:registrar/
 *   super_admin · แสดง snapshot ผู้ถือ/หลักสูตร · BFF เขียน audit PII_ACCESS ทุกครั้ง
 *   ที่เปิดดู) — URL = state จริง (เงื่อนไขค้นหา + cursor อยู่ใน query string)
 * - เพิกถอน/ออกใบแทน: ปุ่มต่อแถวของตารางทะเบียน (ใช้ id ของแถว — แทนแผงรับ uuid เดิม)
 * - การแสดงชื่อผู้เรียนถูกบันทึก audit ที่ BFF อยู่แล้ว — หน้าไม่ log เอง
 */

/** class ของ badge สถานะใบตาม tone (ภาษาเดียวกับ badge ของ repo) */
function statusToneClassOf(tone: "success" | "danger" | "neutral"): string {
  if (tone === "success") {
    return "bg-green-50 text-green-800";
  }
  if (tone === "danger") {
    return "bg-red-50 text-red-700";
  }
  return "bg-mist-100 text-ink-600";
}

/**
 * href ของหน้า — รักษาเงื่อนไขค้นหา + cursor ที่เลือกไว้ (URL = state จริง · แบบ eligible)
 * cursor สองตัวแยกกัน: คิวใช้ `cursor` (เดิม) · ทะเบียนใช้ `cert_cursor`
 * เพื่อไม่ให้การเลื่อนหน้าของตารางใดตารางหนึ่งรบกวนอีกตาราง
 */
function buildCertificatesHref(options: {
  queueCursor?: string | undefined;
  registryCursor?: string | undefined;
  certNo?: string | undefined;
  verifyCode?: string | undefined;
  status?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (options.queueCursor !== undefined && options.queueCursor.length > 0) {
    search.set("cursor", options.queueCursor);
  }
  if (options.registryCursor !== undefined && options.registryCursor.length > 0) {
    search.set("cert_cursor", options.registryCursor);
  }
  if (options.certNo !== undefined && options.certNo.length > 0) {
    search.set("cert_no", options.certNo);
  }
  if (options.verifyCode !== undefined && options.verifyCode.length > 0) {
    search.set("verify_code", options.verifyCode);
  }
  if (options.status !== undefined && options.status.length > 0) {
    search.set("status", options.status);
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

  /* เงื่อนไขค้นหา + ตำแหน่งหน้า (URL = state) — ค่าแปลกปลอม = ไม่ระบุ (fail-closed) */
  const queueCursor = firstSearchParam(params["cursor"]);
  const registryCursor = firstSearchParam(params["cert_cursor"]);
  const certNo = firstSearchParam(params["cert_no"]) ?? "";
  const verifyCode = firstSearchParam(params["verify_code"]) ?? "";
  const statusRaw = firstSearchParam(params["status"]);
  const status = isExamAdminCertificateStatus(statusRaw) ? statusRaw : undefined;

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — การตัดสินจริงอยู่ที่ BFF เสมอ (SoD T9) */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canIssue = canIssueCertificate(roles);
  const canRevoke = canRevokeCertificate(roles);

  /* คิวผู้มีสิทธิ์รับใบ — โหลดเมื่อมีสิทธิ์ออกใบเท่านั้น (ข้อมูลผู้เรียน = PII) */
  const queue = canIssue ? await getEligibleAttempts({ cursor: queueCursor }) : null;
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

  /* ทะเบียนใบที่ออกแล้ว — โหลดเมื่อมีบทบาทอ่านทะเบียน (D55-2 · BFF ตัดสินจริงเสมอ) */
  const registry = canRevoke
    ? await getAdminCertificates({
        certNo,
        verifyCode,
        status,
        cursor: registryCursor,
      })
    : null;
  const registryRows = registry !== null && registry.ok ? registry.data.data : [];
  const registryPage = registry !== null && registry.ok ? registry.data.page : null;

  const registryColumns: Array<DataTableColumn<ExamAdminCertificateRow>> = [
    {
      id: "certNo",
      header: "เลขที่ใบ",
      render: (row) => <span className="font-semibold whitespace-nowrap text-ink-900">{row.certNo}</span>,
    },
    {
      id: "holder",
      header: "ผู้ถือใบ (snapshot)",
      render: (row) => (
        <span className="font-semibold text-ink-900">
          {row.holderName.length > 0 ? row.holderName : "(ยังไม่ระบุชื่อ)"}
        </span>
      ),
    },
    {
      id: "course",
      header: "หลักสูตร (snapshot)",
      render: (row) => <span>{row.courseTitle}</span>,
    },
    {
      id: "status",
      header: "สถานะ",
      render: (row) => (
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusToneClassOf(CERT_STATUS_TONE[row.status])}`}
        >
          {CERT_STATUS_LABEL_TH[row.status]}
        </span>
      ),
    },
    {
      id: "issued",
      header: "วันที่ออก",
      render: (row) => (
        <span className="whitespace-nowrap text-ink-600">{formatThaiDateTime(row.issuedAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "การจัดการ",
      render: (row) => (
        <CertificateRowActions
          certificateId={row.id}
          certNo={row.certNo}
          status={row.status}
          canManage={canRevoke}
        />
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ประกาศนียบัตร</h1>
      <p className="mt-1 text-sm text-ink-500">
        คิวผู้ผ่านเกณฑ์รอออกใบ และทะเบียนประกาศนียบัตรที่ออกแล้ว
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
              href={buildCertificatesHref({
                queueCursor: queuePage.nextCursor,
                certNo,
                verifyCode,
                status,
              })}
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

      <section className="mt-8">
        <h2 className="font-heading text-base font-semibold text-ink-900">
          ทะเบียนประกาศนียบัตรที่ออกแล้ว
        </h2>

        {canRevoke ? (
          registry !== null && registry.ok ? (
            <>
              {/* ค้นหา — GET form (URL = state) · ค่าว่าง = ไม่ระบุ (BFF ตัดช่องว่างก่อนตรวจ) */}
              <form method="get" action="/admin/certificates" className="mt-3 space-y-3">
                {queueCursor !== null ? (
                  <input type="hidden" name="cursor" value={queueCursor} />
                ) : null}
                <fieldset className="flex flex-wrap items-end gap-3">
                  <legend className="sr-only">ค้นหาทะเบียนประกาศนียบัตร</legend>
                  <div>
                    <label
                      htmlFor="cert-search-cert-no"
                      className="block text-sm font-medium text-ink-700"
                    >
                      เลขที่ใบ (นำหน้า)
                    </label>
                    <input
                      id="cert-search-cert-no"
                      name="cert_no"
                      type="text"
                      defaultValue={certNo}
                      maxLength={64}
                      className="mt-1 w-56 rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="cert-search-verify-code"
                      className="block text-sm font-medium text-ink-700"
                    >
                      รหัสตรวจสอบ (ตรงตัว)
                    </label>
                    <input
                      id="cert-search-verify-code"
                      name="verify_code"
                      type="text"
                      defaultValue={verifyCode}
                      maxLength={64}
                      className="mt-1 w-56 rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="cert-search-status"
                      className="block text-sm font-medium text-ink-700"
                    >
                      สถานะ
                    </label>
                    <select
                      id="cert-search-status"
                      name="status"
                      defaultValue={status ?? ""}
                      className="mt-1 w-48 rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    >
                      {CERT_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="submit"
                    className="rounded-[10px] bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-brand-700"
                  >
                    ค้นหา
                  </button>
                </fieldset>
              </form>

              <div className="mt-3">
                <DataTable
                  caption="ตารางทะเบียนประกาศนียบัตร (snapshot ของวันออกใบ — แถวผิดรูปจะไม่ถูกแสดง)"
                  columns={registryColumns}
                  rows={registryRows}
                  getKey={(row) => row.id}
                  emptyTitle="ยังไม่มีใบที่ตรงเงื่อนไข"
                  emptyHint="ลองปรับเงื่อนไขค้นหา หรือใบที่เพิ่งออกจะปรากฏในทะเบียนนี้ทันที"
                />
              </div>
              <p className="mt-3 text-sm text-ink-500">
                หน้านี้แสดง {registryRows.length} ใบ
                {registryPage !== null && registryPage.hasMore ? " — ยังมีรายการต่อ" : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {registryPage !== null &&
                registryPage.hasMore &&
                registryPage.nextCursor !== null ? (
                  <Link
                    href={buildCertificatesHref({
                      queueCursor,
                      registryCursor: registryPage.nextCursor,
                      certNo,
                      verifyCode,
                      status,
                    })}
                    className="inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
                  >
                    หน้าถัดไปของทะเบียน
                  </Link>
                ) : null}
                {registryCursor !== null ? (
                  <Link
                    href={buildCertificatesHref({ queueCursor, certNo, verifyCode, status })}
                    className="inline-flex rounded-[10px] border border-mist-300 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-ink-700 hover:bg-mist-100"
                  >
                    กลับไปหน้าแรกของทะเบียน
                  </Link>
                ) : null}
              </div>
            </>
          ) : registry === null ? null : (
            <div className="mt-3">
              <AdminDataState
                kind={registry.kind}
                retryHref={buildCertificatesHref({
                  registryCursor,
                  certNo,
                  verifyCode,
                  status,
                })}
              />
            </div>
          )
        ) : (
          <p className="mt-3 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
            คุณไม่มีสิทธิ์ดูทะเบียนประกาศนียบัตร — แสดงเฉพาะผู้รับผิดชอบทะเบียนและผู้ดูแลระบบ
          </p>
        )}
      </section>
    </div>
  );
}
