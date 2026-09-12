import type { Metadata } from "next";
import Link from "next/link";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import {
  dashboardRangeValid,
  defaultDashboardRange,
  getAdminDashboard,
  isIsoDate,
  type DashboardStats,
} from "@/components/admin/dashboard/data";

export const metadata: Metadata = {
  title: "แดชบอร์ดผู้ดูแล · หลังบ้าน",
  description:
    "ตัวเลขสรุปตามช่วงวันที่ (GET /api/v1/admin/dashboard — RPC admin_dashboard_stats · แสดงตามสิทธิ์บทบาทที่ถือ)",
};

/** การ์ด KPI เดี่ยว — ค่า null = บทบาทไม่มีสิทธิ์ดูตัวเลขนั้น (แสดง —) */
function KpiCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-[10px] border border-mist-200 bg-white p-5 shadow-card">
      <p className="text-sm text-ink-500">{label}</p>
      <p className="font-heading text-3xl font-bold text-ink-900">
        {value === null ? "—" : String(value)}
      </p>
    </div>
  );
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawFrom = Array.isArray(params["from"]) ? params["from"][0] : params["from"];
  const rawTo = Array.isArray(params["to"]) ? params["to"][0] : params["to"];
  const fallback = defaultDashboardRange(new Date());
  const range = {
    from: isIsoDate(rawFrom) ? rawFrom : fallback.from,
    to: isIsoDate(rawTo) ? rawTo : fallback.to,
  };

  const session = await getAdminStaffSession();
  if (session.ok === false) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">แดชบอร์ดผู้ดูแล</h1>
        <div className="mt-4">
          <AdminDataState kind="server" retryHref="/admin/dashboard" />
        </div>
      </div>
    );
  }
  if (session.staff === null) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">แดชบอร์ดผู้ดูแล</h1>
        <div className="mt-4">
          <AdminDataState kind="forbidden" retryHref="/admin/dashboard" />
        </div>
      </div>
    );
  }
  if (dashboardRangeValid(range) === false) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">แดชบอร์ดผู้ดูแล</h1>
        <p className="mt-1 text-sm text-danger-600">
          ช่วงวันที่ไม่ถูกต้อง — from/to ต้องเป็น ISO (YYYY-MM-DD) หรือ from มากกว่า to
        </p>
        <Link
          href="/admin/dashboard"
          className="mt-3 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          ใช้ช่วง 30 วันล่าสุด
        </Link>
      </div>
    );
  }

  const result = await getAdminDashboard(range);
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">แดชบอร์ดผู้ดูแล</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/dashboard" />
        </div>
      </div>
    );
  }
  const stats: DashboardStats = result.data;

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">แดชบอร์ดผู้ดูแล</h1>
      <p className="mt-1 text-sm text-ink-500">
        ตัวเลขสรุปของช่วง {range.from} ถึง {range.to} (default 30 วันล่าสุด — แสดงตามสิทธิ์บทบาทที่ถือ)
      </p>

      <form
        action="/admin/dashboard"
        method="get"
        className="mt-5 flex flex-wrap items-end gap-2"
      >
        <div>
          <label htmlFor="dash-from" className="block text-sm font-medium text-ink-700">
            จากวันที่
          </label>
          <input
            id="dash-from"
            type="date"
            name="from"
            defaultValue={range.from}
            className="mt-1 w-full max-w-48 rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="dash-to" className="block text-sm font-medium text-ink-700">
            ถึงวันที่
          </label>
          <input
            id="dash-to"
            type="date"
            name="to"
            defaultValue={range.to}
            className="mt-1 w-full max-w-48 rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700"
        >
          ใช้ช่วงวันที่
        </button>
        <Link href="/admin/dashboard" className="text-sm text-brand-600 hover:underline">
          ใช้ช่วง 30 วันล่าสุด
        </Link>
      </form>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="ผู้ใช้ใหม่" value={stats.usersNew} />
        <KpiCard label="ผู้ใช้รวม" value={stats.usersTotal} />
        <KpiCard label="การลงทะเบียนใหม่" value={stats.enrollmentsNew} />
        <KpiCard label="ครั้งที่สอบ" value={stats.examAttempts} />
        <KpiCard label="สอบผ่าน" value={stats.examPassed} />
        <KpiCard label="อัตราผ่าน (%)" value={stats.examPassRatePct} />
        <KpiCard label="ใบประกาศฯ ที่ออก" value={stats.certificatesIssued} />
        <KpiCard label="เครดิตกฎหมายที่ออก" value={stats.creditsIssued} />
      </div>
    </div>
  );
}
