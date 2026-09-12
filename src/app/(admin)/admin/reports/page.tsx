import type { Metadata } from "next";
import Link from "next/link";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import { REPORT_CARDS } from "@/components/admin/reports/catalog";

export const metadata: Metadata = {
  title: "ศูนย์รายงาน · หลังบ้าน",
  description:
    "รวมรายงานและการส่งออก CSV ตามสิทธิ์ของบทบาท (GET /api/v1/admin/reports/{type}/export · มอนิเตอร์/สถิติข้อสอบ)",
};

/** pure — การ์ดที่บทบาทของ session มีสิทธิ์เห็น (สิทธิ์จริงตัดสินที่ BFF เสมอ) */
export function cardsForRoles(roles: readonly string[]): typeof REPORT_CARDS {
  return REPORT_CARDS.filter((card) =>
    roles.some((role) => card.roles.includes(role)),
  );
}

export default async function AdminReportsPage() {
  const session = await getAdminStaffSession();
  if (session.ok === false) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ศูนย์รายงาน</h1>
        <div className="mt-4">
          <AdminDataState kind="server" retryHref="/admin/reports" />
        </div>
      </div>
    );
  }
  if (session.staff === null) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ศูนย์รายงาน</h1>
        <div className="mt-4">
          <AdminDataState kind="forbidden" retryHref="/admin/reports" />
        </div>
      </div>
    );
  }
  const roles: readonly string[] = session.staff.roles;
  const cards = cardsForRoles(roles);
  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ศูนย์รายงาน</h1>
      <p className="mt-1 text-sm text-ink-500">
        รวมรายงานและส่งออก CSV — การส่งออกถูกบันทึก audit ADMIN_EXPORT ทุกครั้ง
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {(roles.includes("staff:exam") || roles.includes("super_admin")) ? (
          <div className="rounded-[10px] border border-mist-200 bg-white p-5 shadow-card">
            <h2 className="font-heading text-base font-semibold text-ink-900">มอนิเตอร์การสอบสด</h2>
            <p className="mt-1 text-sm text-ink-500">
              จำนวนที่กำลังสอบ/ค้างเกินเวลา แยกตามชุดข้อสอบ/หลักสูตร (staff:exam · super_admin)
            </p>
            <Link
              href="/admin/exams/monitoring"
              className="mt-3 inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
            >
              เปิดหน้ามอนิเตอร์ →
            </Link>
          </div>
        ) : null}
        {(roles.includes("staff:exam") || roles.includes("staff:viewer") || roles.includes("super_admin")) ? (
          <div className="rounded-[10px] border border-mist-200 bg-white p-5 shadow-card">
            <h2 className="font-heading text-base font-semibold text-ink-900">สถิติผลสอบ</h2>
            <p className="mt-1 text-sm text-ink-500">
              จำนวนสอบ/ผ่าน/เรท/คะแนนเฉลี่ย ต่อชุดข้อสอบ (staff:exam · staff:viewer · super_admin)
            </p>
            <Link
              href="/admin/exams/statistics"
              className="mt-3 inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
            >
              เปิดหน้าสถิติ →
            </Link>
          </div>
        ) : null}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <div key={card.type} className="rounded-[10px] border border-mist-200 bg-white p-5 shadow-card">
            <h2 className="font-heading text-base font-semibold text-ink-900">{card.titleTh}</h2>
            <p className="mt-1 text-sm text-ink-500">{card.descriptionTh}</p>
            <a
              href={card.exportPath}
              className="mt-3 inline-flex rounded-[10px] bg-brand-600 px-4 py-2 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700"
            >
              ส่งออก CSV
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
