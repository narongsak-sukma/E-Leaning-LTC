import type { Metadata } from "next";
import Link from "next/link";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { formatThaiDateTime } from "@/lib/exam-admin.view";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import {
  AUDIT_PAGE_SIZE,
  buildAuditHref,
  buildAuditQuery,
  getAdminAuditLogs,
  type AdminAuditRow,
} from "@/components/admin/audit/data";

export const metadata: Metadata = {
  title: "บันทึกการตรวจสอบ · หลังบ้าน",
  description:
    "อ่านอย่างเดียว — ค้นบันทึกตรวจสอบด้วย action/ผู้กระทำ/ชนิดรายการ/ช่วงเวลา (GET /api/v1/admin/audit-logs — keyset)",
};

/** แถวของตาราง — แสดง occurred_at · action · actor · entity · บริบทแบบกางได้ (ไม่มี before/after/hash) */
function AuditRowItem({ row }: { row: AdminAuditRow }) {
  return (
    <li className="rounded-[10px] border border-mist-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="whitespace-nowrap font-medium text-ink-900">
          {formatThaiDateTime(row.occurredAt)}
        </span>
        <span className="inline-flex items-center rounded-full bg-mist-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-700">
          {row.action}
        </span>
        <span className="text-sm text-ink-600">
          โดย {row.actor ?? "ระบบ"}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-600">
        รายการ: {row.entityType ?? "—"}
        {row.entityId ? <span className="text-ink-400"> · {row.entityId}</span> : null}
      </p>
      {row.context !== null ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-semibold text-brand-600 hover:underline">
            ดูบริบท
            <span className="sr-only">ของรายการ {row.id}</span>
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-[10px] bg-mist-100 p-3 text-xs text-ink-700">
            {JSON.stringify(row.context, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawAction = Array.isArray(params["action"]) ? params["action"][0] : params["action"];
  const rawActor = Array.isArray(params["actor"]) ? params["actor"][0] : params["actor"];
  const rawType = Array.isArray(params["entityType"]) ? params["entityType"][0] : params["entityType"];
  const rawFrom = Array.isArray(params["from"]) ? params["from"][0] : params["from"];
  const rawTo = Array.isArray(params["to"]) ? params["to"][0] : params["to"];
  const rawCursor = Array.isArray(params["cursor"]) ? params["cursor"][0] : params["cursor"];
  const query = buildAuditQuery({
    action: rawAction,
    actor: rawActor,
    entityType: rawType,
    from: rawFrom,
    to: rawTo,
    cursor: rawCursor,
  });

  const session = await getAdminStaffSession();
  if (session.ok === false) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">บันทึกการตรวจสอบ</h1>
        <div className="mt-4">
          <AdminDataState kind="server" retryHref="/admin/audit" />
        </div>
      </div>
    );
  }
  if (session.staff === null) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">บันทึกการตรวจสอบ</h1>
        <div className="mt-4">
          <AdminDataState kind="forbidden" retryHref="/admin/audit" />
        </div>
      </div>
    );
  }

  const result = await getAdminAuditLogs(query);
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">บันทึกการตรวจสอบ</h1>
        <div className="mt-4">
          {/* kind จากชั้นข้อมูล (401/403 = forbidden — เช่น registrar ที่ไม่มี
              audit_log:view · เดิม hardcode "server" ทำ 403 แสดงแผง "ระบบล่ม"
              ผิดความจริง — แบบแผนเดียวกับ dashboard/users/courses) */}
          <AdminDataState kind={result.kind} retryHref="/admin/audit" />
        </div>
      </div>
    );
  }
  const { data: rows, page } = result.data;

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">บันทึกการตรวจสอบ</h1>
      <p className="mt-1 text-sm text-ink-500">
        อ่านอย่างเดียว — ทุกการเปิดหน้านี้ถูกบันทึกเป็น AUDIT_READ ตามนโยบาย
        (GET /api/v1/admin/audit-logs)
      </p>

      <form
        action="/admin/audit"
        method="get"
        role="search"
        className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <div>
          <label htmlFor="audit-action" className="block text-sm font-medium text-ink-700">
            action (คำนำหน้า)
          </label>
          <input
            id="audit-action"
            type="search"
            name="action"
            defaultValue={query.action}
            placeholder="เช่น LICENSE"
            className="mt-1 w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="audit-actor" className="block text-sm font-medium text-ink-700">
            ผู้กระทำ
          </label>
          <input
            id="audit-actor"
            type="search"
            name="actor"
            defaultValue={query.actor}
            className="mt-1 w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="audit-type" className="block text-sm font-medium text-ink-700">
            ชนิดรายการ
          </label>
          <input
            id="audit-type"
            type="search"
            name="entityType"
            defaultValue={query.entityType}
            className="mt-1 w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="audit-from" className="block text-sm font-medium text-ink-700">
            จากวันที่
          </label>
          <input
            id="audit-from"
            type="date"
            name="from"
            defaultValue={query.from}
            className="mt-1 w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="audit-to" className="block text-sm font-medium text-ink-700">
            ถึงวันที่
          </label>
          <input
            id="audit-to"
            type="date"
            name="to"
            defaultValue={query.to}
            className="mt-1 w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
          <button
            type="submit"
            className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
          >
            ใช้ตัวกรอง
          </button>
          <Link
            href="/admin/audit"
            className="rounded-[10px] border border-brand-600 bg-white px-[18px] py-2.5 font-heading text-base font-semibold text-brand-700 hover:bg-brand-50"
          >
            ล้างตัวกรอง
          </Link>
        </div>
      </form>

      <p className="mt-4 text-sm text-ink-500">
        พบ {rows.length} รายการ (หน้าละ {AUDIT_PAGE_SIZE}){page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>

      <ul className="mt-2 space-y-3">
        {rows.map((row) => (
          <AuditRowItem key={row.id} row={row} />
        ))}
      </ul>

      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildAuditHref({ ...query, cursor: page.nextCursor })}
          className="mt-4 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          โหลดเพิ่ม
        </Link>
      ) : null}
    </div>
  );
}
