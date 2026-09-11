/**
 * MyCertificatesView — มุมมองรายการ "ประกาศนียบัตรของฉัน" (Wave D-6)
 *
 * - Server Component (ไม่มี "use client") — ข้อมูลทั้งหมดมาเป็น props จากหน้า RSC
 *   (โหลดผ่าน certificates.server.ts — cookie forward ตามแบบ learning.server.ts)
 * - ปุ่มดาวน์โหลด PDF = <a href=GET /api/v1/certificates/{id}/pdf download> — id เป็น
 *   **uuid ของใบ** (ไม่ใช่ cert_no — ดู contract ใน pdf/route.ts) · ดาวน์โหลดผ่าน browser
 *   ปกติ (browser navigation ไป endpoint owner เท่านั้น — ไม่ fetch อ่านเป็น text)
 * - ลิงก์ตรวจสาธารณะต่อใบ → /verify/<cert_no> (พิมพ์มือช่องทาง D10)
 * - ข้อความไทยทั้งหมด · ไม่มี holder_name/PII ใด ๆ (ไม่มีใน contract ของ D-2 อยู่แล้ว)
 */
import Link from "next/link";

import {
  certificatePdfApiUrl,
  certificateStatusThai,
  certificateStatusTone,
  formatIssuedAtThai,
  publicVerifyPageUrl,
} from "@/lib/fixtures/certificates";
import type { MyCertificateResourceParsed } from "@/lib/schemas/v1/certificate";
import type { MyCertificatesPageData } from "@/lib/fixtures/certificates.server";

/** สถานะ "ยังไม่เข้าสู่ระบบ" — แผงไทย + ปุ่มไปหน้าเข้าสู่ระบบ (next กลับมาหน้าเดิม) */
function UnauthenticatedPanel() {
  return (
    <section
      aria-labelledby="cert-unauth-heading"
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
    >
      <h2 id="cert-unauth-heading" className="font-heading text-lg font-bold text-ink-900">
        กรุณาเข้าสู่ระบบ
      </h2>
      <p className="mt-2 text-sm text-ink-600">
        หน้านี้แสดงประกาศนียบัตรของผู้ใช้ที่เข้าสู่ระบบแล้วเท่านั้น
      </p>
      <Link
        href="/login?next=%2Fmy%2Fcertificates"
        className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
      >
        ไปหน้าเข้าสู่ระบบ
      </Link>
    </section>
  );
}

/** สถานะระบบขัดข้อง — fail-closed ภาษาไทย (ไม่แสดง error ดิบ/stack) */
function ErrorPanel() {
  return (
    <div
      role="alert"
      className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center"
    >
      <p className="font-heading text-base font-semibold text-danger-700">
        โหลดข้อมูลประกาศนียบัตรของท่านไม่สำเร็จ
      </p>
      <p className="mt-1 text-sm text-danger-600">
        กรุณารีเฟรชหน้าเว็บเพื่อลองใหม่อีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
      </p>
    </div>
  );
}

/** สถานะว่าง — ยังไม่มีใบ — ชวนไปหน้าหลักสูตรของฉัน */
function EmptyPanel() {
  return (
    <section
      aria-labelledby="cert-empty-heading"
      className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
    >
      <h2 id="cert-empty-heading" className="font-heading text-lg font-bold text-ink-900">
        ยังไม่มีประกาศนียบัตร
      </h2>
      <p className="mt-2 text-sm text-ink-600">
        ประกาศนียบัตรจะปรากฏในหน้านี้หลังท่านสอบผ่านหลักสูตร
        และเจ้าหน้าที่สภาทนายความฯ ออกใบให้เรียบร้อยแล้ว
      </p>
      <Link
        href="/my/courses"
        className="mt-4 inline-flex rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
      >
        ไปหน้าหลักสูตรของฉัน
      </Link>
    </section>
  );
}

/** แผงรายการใบ — การ์ดต่อใบ + ปุ่มดาวน์โหลด PDF + ลิงก์ตรวจสาธารณะ */
function CertificateListPanel({
  certificates,
  hasMore,
}: {
  certificates: readonly MyCertificateResourceParsed[];
  hasMore: boolean;
}) {
  return (
    <section aria-labelledby="cert-list-heading" className="mt-6">
      <h2 id="cert-list-heading" className="font-heading text-lg font-bold text-ink-900">
        ประกาศนียบัตรของท่าน
      </h2>
      <ul className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        {certificates.map((certificate) => {
          return (
            <li
              key={certificate.id}
              className="flex flex-col rounded-[14px] border border-mist-200 bg-white p-5 shadow-card"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-brand-600">{certificate.cert_no}</p>
                <CertificateStatusBadge status={certificate.status} />
              </div>
              <h3 className="mt-1 font-heading text-base font-bold text-ink-900">
                {certificate.course_title}
              </h3>
              <p className="mt-1 text-sm text-ink-600">
                ออกให้เมื่อ {formatIssuedAtThai(certificate.issued_at)}
              </p>
              <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
                <a
                  href={certificatePdfApiUrl(certificate.id)}
                  download
                  className="inline-flex items-center gap-2 rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
                >
                  ดาวน์โหลด PDF
                </a>
                <Link
                  href={publicVerifyPageUrl(certificate.cert_no)}
                  className="text-sm font-semibold text-brand-700 hover:text-brand-800 hover:underline"
                >
                  ตรวจสอบสาธารณะ (/verify)
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <p
          role="note"
          className="mt-4 rounded-[10px] border border-gold-200 bg-gold-50 px-4 py-3 text-sm text-ink-700"
        >
          แสดงเฉพาะรายการล่าสุด — หากต้องการดูรายการที่เหลือ กรุณาติดต่อเจ้าหน้าที่
        </p>
      ) : null}
    </section>
  );
}

/** ป้ายสถานะ — ข้อความไทย + โทนสีตาม DESIGN-SYSTEM §5.6 */
function CertificateStatusBadge({
  status,
}: {
  status: MyCertificateResourceParsed["status"];
}) {
  const tone = certificateStatusTone(status);
  const label = certificateStatusThai(status);
  const toneClass =
    tone === "success"
      ? "bg-success-50 text-success-600"
      : tone === "danger"
        ? "bg-danger-50 text-danger-600"
        : "bg-warning-50 text-warning-600";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold ${toneClass}`}
    >
      <span
        aria-hidden="true"
        className={
          tone === "success"
            ? "bg-success-600"
            : tone === "danger"
              ? "bg-danger-600"
              : "bg-warning-600"
        }
      />
      {label}
    </span>
  );
}

export function MyCertificatesView({ data }: { data: MyCertificatesPageData }) {
  if (data.kind === "unauthenticated") {
    return <UnauthenticatedPanel />;
  }
  if (data.kind === "error") {
    return <ErrorPanel />;
  }
  if (data.kind === "empty") {
    return <EmptyPanel />;
  }
  return <CertificateListPanel certificates={data.certificates} hasMore={data.hasMore} />;
}
