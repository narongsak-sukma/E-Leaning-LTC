import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { formatThaiDateTime } from "@/lib/exam-admin.view";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import {
  getAdminLicenseApplications,
  isLicenseStatus,
  LICENSE_PAGE_SIZE,
  LICENSE_STATUS_FILTER_OPTIONS,
  type AdminLicenseApplicationRow,
} from "@/components/admin/license/data";
// ปุ่มตัดสินเป็น client component — licenseStatusViewOf เป็น pure helper ที่หน้า
// server เรียน SSR ต้องมาจากโมดูลไม่มี "use client" (โมดูล client ห้ามเรียกจาก
// server — SSR ล่มทุกคำขอแม้ BFF 200 — e2e-15 t4)
import { LicenseDecisionActions } from "@/components/admin/license/LicenseDecisionActions";
import { licenseStatusViewOf } from "@/components/admin/license/license-status";

export const metadata: Metadata = {
  title: "คำขอใบอนุญาตทนายความ · หลังบ้าน",
  description:
    "รายการคำขอผูกเลขที่ใบอนุญาต พร้อมอนุมัติ/ปฏิเสธ (GET/PATCH /api/v1/admin/license-applications)",
};

/** ตรวจ searchParams แบบ multi-value — ใช้ค่าแรก (string | string[] | undefined) */
function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** สร้าง href ของหน้ารายการ — รักษา status/cursor ที่เลือกไว้ (URL = state จริง) */
function buildLicenseHref(options: { status?: string; cursor?: string }): string {
  const search = new URLSearchParams();
  if (options.status !== undefined && options.status !== "all" && options.status.length > 0) {
    search.set("status", options.status);
  }
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/license-applications?${query}` : "/admin/license-applications";
}

export default async function AdminLicenseApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawStatus = firstParam(params["status"]);
  const cursor = firstParam(params["cursor"]);
  const filter = isLicenseStatus(rawStatus) ? rawStatus : "all";

  const session = await getAdminStaffSession();
  if (session.ok === false) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คำขอใบอนุญาตทนายความ</h1>
        <div className="mt-4">
          <AdminDataState kind="server" retryHref="/admin/license-applications" />
        </div>
      </div>
    );
  }
  if (session.staff === null) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คำขอใบอนุญาตทนายความ</h1>
        <div className="mt-4">
          <AdminDataState kind="forbidden" retryHref="/admin/license-applications" />
        </div>
      </div>
    );
  }
  const callerRoles: readonly string[] = session.staff.roles;
  const canDecide =
    callerRoles.includes("super_admin") || callerRoles.includes("staff:registrar");

  const result = await getAdminLicenseApplications({
    status: filter === "all" ? undefined : filter,
    cursor,
    limit: LICENSE_PAGE_SIZE,
  });
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คำขอใบอนุญาตทนายความ</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/license-applications" />
        </div>
      </div>
    );
  }
  const { data: rows, page } = result.data;

  const columns: Array<DataTableColumn<AdminLicenseApplicationRow>> = [
    {
      id: "applicant",
      header: "ผู้ขอ",
      render: (row) => (
        <div>
          <p className="font-semibold text-ink-900">{row.displayName}</p>
          {row.email ? <p className="text-xs text-ink-500">{row.email}</p> : null}
        </div>
      ),
    },
    {
      id: "licenseNo",
      header: "เลขที่ใบอนุญาต",
      render: (row) => <span className="font-semibold text-ink-900">{row.licenseNo}</span>,
    },
    {
      id: "status",
      header: "สถานะ",
      render: (row) => {
        const view = licenseStatusViewOf(row.status);
        return <StatusBadge tone={view.tone} label={view.label} />;
      },
    },
    {
      // เหตุผลการปฏิเสธ (BFF ส่งมาในแถว — reason) — registrar เห็นเหตุผลที่ตัดสิน
      // ไว้ต่อคำขอนั้น ๆ (e2e-15 t7) · แถวที่ไม่ใช่ rejected แสดง "—"
      id: "reason",
      header: "เหตุผล (ปฏิเสธ)",
      render: (row) =>
        row.status === "rejected" && row.reason !== null ? (
          <span className="max-w-[16rem] inline-block truncate text-ink-600" title={row.reason}>
            {row.reason}
          </span>
        ) : (
          <span className="text-ink-400">—</span>
        ),
    },
    {
      id: "submitted",
      header: "ยื่นเมื่อ",
      render: (row) => (
        <span className="whitespace-nowrap text-ink-600">{formatThaiDateTime(row.submittedAt)}</span>
      ),
    },
    {
      id: "evidence",
      header: "หลักฐาน",
      render: (row) =>
        row.evidenceUrl ? (
          <a
            href={row.evidenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-brand-600 hover:underline"
          >
            เปิดหลักฐาน
          </a>
        ) : (
          <span className="text-ink-400">—</span>
        ),
    },
    {
      id: "actions",
      header: "การจัดการ",
      render: (row) => (
        <LicenseDecisionActions
          applicationId={row.id}
          applicantName={row.displayName}
          status={row.status}
          canDecide={canDecide}
        />
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">คำขอใบอนุญาตทนายความ</h1>
      <p className="mt-1 text-sm text-ink-500">
        ตรวจคำขอผูกเลขที่ใบอนุญาต — อนุมัติแล้วระบบจะออกใบยืนยันสถานะทนายและมอบบทบาทให้อัตโนมัติ
        (GET /api/v1/admin/license-applications)
      </p>

      <nav aria-label="กรองตามสถานะคำขอ" className="mt-4">
        <ul className="flex flex-wrap gap-2">
          {LICENSE_STATUS_FILTER_OPTIONS.map((option) => {
            const active = option.value === filter;
            return (
              <li key={option.value}>
                <Link
                  href={buildLicenseHref({ status: option.value })}
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

      <div className="mt-4">
        <DataTable
          caption="ตารางคำขอใบอนุญาต (ข้อมูลจาก BFF — อัปเดตสดทุกครั้งที่เปิดหน้า)"
          columns={columns}
          rows={rows}
          getKey={(row) => row.id}
          emptyTitle="ยังไม่มีคำขอตามสถานะที่เลือก"
          emptyHint="ลองเปลี่ยนสถานะที่ต้องการดู แล้วลองใหม่อีกครั้ง"
        />
      </div>

      <p className="mt-3 text-sm text-ink-500">
        หน้านี้แสดง {rows.length} คำขอ (หน้าละ {LICENSE_PAGE_SIZE})
        {page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>
      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildLicenseHref({ status: filter, cursor: page.nextCursor })}
          className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          โหลดเพิ่ม
        </Link>
      ) : null}
    </div>
  );
}
