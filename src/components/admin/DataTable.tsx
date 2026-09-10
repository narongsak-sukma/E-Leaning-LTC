import type { ReactNode } from "react";

/**
 * ตารางข้อมูลหลังบ้าน — DESIGN-SYSTEM §5.5 (Table) + §5.12 (Empty State)
 * - หัวตาราง พื้น mist-100 / ตัวอักษร ink-500 น้ำหนัก 600
 * - แถว: เส้นใต้ mist-200, hover brand-50
 * - คลอบด้วย overflow-x-auto + tabIndex 0 (เลื่อนด้วยคีย์บอร์ดได้ — §8 หน้า 08)
 */

export type DataTableColumn<T> = {
  id: string;
  header: string;
  align?: "start" | "end" | undefined;
  render: (row: T) => ReactNode;
};

type DataTableProps<T> = {
  caption: string;
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  getKey: (row: T) => string;
  emptyTitle: string;
  emptyHint?: string | undefined;
};

export function DataTable<T>({
  caption,
  columns,
  rows,
  getKey,
  emptyTitle,
  emptyHint,
}: DataTableProps<T>) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-[14px] border border-mist-200 bg-white p-10 text-center shadow-card"
        role="status"
      >
        <p className="font-heading text-base font-semibold text-ink-900">{emptyTitle}</p>
        {emptyHint ? <p className="mt-1 text-sm text-ink-500">{emptyHint}</p> : null}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-mist-200 bg-white shadow-card">
      <div className="overflow-x-auto" tabIndex={0} aria-label={caption}>
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-mist-100">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={`px-4 py-3 text-sm font-semibold text-ink-500 ${
                    column.align === "end" ? "text-right" : "text-left"
                  }`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={getKey(row)} className="border-t border-mist-200 hover:bg-brand-50">
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={`px-4 py-3 align-top text-ink-700 ${
                      column.align === "end" ? "text-right tabular-nums" : "text-left"
                    }`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
