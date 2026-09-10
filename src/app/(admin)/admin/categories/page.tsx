import type { Metadata } from "next";
import { CategoryFormModal } from "@/components/admin/CategoryFormModal";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { StatusBadge } from "@/components/admin/StatusBadge";
import {
  adminCategories,
  adminFixtureStaff,
  countCoursesInCategory,
  type AdminCategory,
} from "@/lib/fixtures/admin";

export const metadata: Metadata = {
  title: "หมวดหลักสูตร · หลังบ้านจัดการเนื้อหา",
  description:
    "บริหารหมวดหลักสูตรแบบแม่-ลูก ลึก 2 ระดับ (โครงหน้าจอ — ข้อมูลจำลอง ยังไม่เชื่อมต่อ /api/v1/admin/categories)",
};

export default function AdminCategoriesPage() {
  const canCreate =
    adminFixtureStaff.role === "staff:content" || adminFixtureStaff.role === "super_admin";

  const rows = [...adminCategories]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.nameTh.localeCompare(b.nameTh, "th"));

  const columns: Array<DataTableColumn<AdminCategory>> = [
    {
      id: "name",
      header: "หมวดหลักสูตร",
      render: (category) =>
        category.parentId === null ? (
          <span className="font-semibold text-ink-900">{category.nameTh}</span>
        ) : (
          <span className="ms-6 flex items-center gap-1.5 text-ink-700">
            <span aria-hidden="true" className="text-ink-400">└</span>
            {category.nameTh}
          </span>
        ),
    },
    {
      id: "slug",
      header: "รหัสหมวด (slug)",
      render: (category) => <span className="text-ink-600">{category.slug}</span>,
    },
    {
      id: "courses",
      header: "หลักสูตรที่ใช้",
      align: "end",
      render: (category) => <span>{countCoursesInCategory(category.id)}</span>,
    },
    {
      id: "sort",
      header: "ลำดับ",
      align: "end",
      render: (category) => <span>{category.sortOrder}</span>,
    },
    {
      id: "status",
      header: "สถานะ",
      render: (category) => (
        <StatusBadge
          label={category.isActive ? "ใช้งาน" : "ปิดใช้งาน"}
          tone={category.isActive ? "success" : "neutral"}
          withDot={category.isActive}
        />
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">
            หมวดหลักสูตร
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            จัดกลุ่มหลักสูตรแบบแม่-ลูก ลึก 2 ระดับ (GET /api/v1/admin/categories — เชื่อมต่อในเฟสถัดไป)
          </p>
        </div>
        <CategoryFormModal
          parentOptions={rows.filter((category) => category.parentId === null)}
          canCreate={canCreate}
        />
      </div>

      <div className="mt-4">
        <DataTable
          caption="ตารางหมวดหลักสูตร (ข้อมูลจำลอง)"
          columns={columns}
          rows={rows}
          getKey={(category) => category.id}
          emptyTitle="ยังไม่มีหมวดหลักสูตร"
          emptyHint="กดปุ่ม เพิ่มหมวด เพื่อเริ่มสร้างหมวดแรก"
        />
      </div>
      {!canCreate ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-500">
          โหมดดูอย่างเดียว (staff:viewer) — ไม่มีสิทธิ์เพิ่มหมวดหลักสูตร
          (POST /api/v1/admin/categories เฉพาะ staff:content/super_admin ตาม RBAC §2)
        </p>
      ) : null}
    </div>
  );
}
