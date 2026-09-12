import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { AdminDataState } from "@/components/admin/AdminDataState";
import { formatThaiDate, getAdminStaffSession } from "@/lib/fixtures/admin";
import {
  ADMIN_USERS_PAGE_SIZE,
  getAdminUsers,
  isUserStatus,
  USER_STATUS_FILTER_OPTIONS,
  type AdminUserRow,
} from "@/components/admin/users/data";
import {
  canCreateStaffUser,
  canDisableUser,
  canManageRoles,
  CreateStaffButton,
  roleLabelOf,
  roleOptionsForCaller,
  UserRowActions,
  userStatusViewOf,
} from "@/components/admin/users/UserActions";

export const metadata: Metadata = {
  title: "ผู้ใช้และบทบาท · หลังบ้าน",
  description:
    "ค้นหา กรองสถานะ ปิด/เปิดใช้งานบัญชี และมอบ/ถอดบทบาทของผู้ใช้ (GET/PATCH /api/v1/admin/users · POST/DELETE /api/v1/admin/users/{id}/roles)",
};

/** ตรวจ searchParams แบบ multi-value — ใช้ค่าแรก (แบบแผน admin/courses) */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** href ของหน้ารายการ — รักษา q/status/cursor ที่เลือกไว้ (URL = state จริง) */
function buildUsersHref(options: {
  status?: string;
  q?: string;
  cursor?: string;
}): string {
  const search = new URLSearchParams();
  if (options.status !== undefined && options.status !== "all" && options.status.length > 0) {
    search.set("status", options.status);
  }
  if (options.q !== undefined && options.q.length > 0) {
    search.set("q", options.q);
  }
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/users?${query}` : "/admin/users";
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawStatus = firstParam(params["status"]);
  const q = firstParam(params["q"]) ?? "";
  const cursor = firstParam(params["cursor"]);
  const filter = isUserStatus(rawStatus) ? rawStatus : "all";

  const session = await getAdminStaffSession();
  if (session.ok === false) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ผู้ใช้และบทบาท</h1>
        <div className="mt-4">
          <AdminDataState kind="server" retryHref="/admin/users" />
        </div>
      </div>
    );
  }
  if (session.staff === null) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ผู้ใช้และบทบาท</h1>
        <div className="mt-4">
          <AdminDataState kind="forbidden" retryHref="/admin/users" />
        </div>
      </div>
    );
  }
  const callerRoles: readonly string[] = session.staff.roles;

  const result = await getAdminUsers({
    q: q.length > 0 ? q : undefined,
    status: filter === "all" ? undefined : filter,
    cursor,
    limit: ADMIN_USERS_PAGE_SIZE,
  });
  if (!result.ok) {
    return (
      <div>
        <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ผู้ใช้และบทบาท</h1>
        <div className="mt-4">
          <AdminDataState kind={result.kind} retryHref="/admin/users" />
        </div>
      </div>
    );
  }
  const { data: rows, page } = result.data;

  const canDisable = canDisableUser(callerRoles);
  const canManageRolesFlag = canManageRoles(callerRoles);
  const callerRoleOptions = roleOptionsForCaller(callerRoles);

  const columns: Array<DataTableColumn<AdminUserRow>> = [
    {
      id: "displayName",
      header: "ชื่อ-นามสกุล",
      render: (user) => (
        <div>
          <p className="font-semibold text-ink-900">{user.displayName}</p>
          <p className="text-xs text-ink-500">{user.email}</p>
        </div>
      ),
    },
    {
      id: "roles",
      header: "บทบาท",
      render: (user) => (
        <div className="flex flex-wrap gap-1">
          {user.roles.length === 0 ? (
            <span className="text-ink-400">—</span>
          ) : (
            user.roles.map((role) => (
              <span
                key={role}
                className="inline-flex items-center rounded-full bg-mist-100 px-2 py-0.5 text-xs font-medium text-ink-600"
              >
                {roleLabelOf(role)}
              </span>
            ))
          )}
        </div>
      ),
    },
    {
      id: "status",
      header: "สถานะ",
      render: (user) => {
        const view = userStatusViewOf(user.status);
        return <StatusBadge tone={view.tone} label={view.label} />;
      },
    },
    {
      id: "createdAt",
      header: "สมัครเมื่อ",
      render: (user) => (
        <span className="whitespace-nowrap text-ink-600">{formatThaiDate(user.createdAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "การจัดการ",
      render: (user) => (
        <UserRowActions
          userId={user.id}
          displayName={user.displayName}
          status={user.status}
          roles={user.roles}
          canDisable={canDisable}
          canManageRoles={canManageRolesFlag}
          callerRoleOptions={callerRoleOptions}
        />
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">ผู้ใช้และบทบาท</h1>
          <p className="mt-1 text-sm text-ink-500">
            ค้นหาและจัดการบัญชีผู้ใช้ (GET /api/v1/admin/users — ข้อมูลจริงจาก BFF)
          </p>
        </div>
        {canCreateStaffUser(callerRoles) ? (
          <CreateStaffButton callerRoleOptions={callerRoleOptions} />
        ) : null}
      </div>

      <form
        action="/admin/users"
        method="get"
        role="search"
        className="mt-5 flex flex-wrap items-center gap-2"
      >
        {filter !== "all" ? (
          <input type="hidden" name="status" value={filter} />
        ) : null}
        <label htmlFor="user-search" className="sr-only">
          ค้นหาผู้ใช้จากชื่อหรืออีเมล
        </label>
        <input
          id="user-search"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="ค้นหาจากชื่อหรืออีเมล"
          className="w-full max-w-sm rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400"
        />
        <button
          type="submit"
          className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
        >
          ค้นหา
        </button>
        {q.length > 0 ? (
          <Link href={buildUsersHref({ status: filter })} className="text-sm text-brand-600 hover:underline">
            ล้างการค้นหา
          </Link>
        ) : null}
      </form>

      <nav aria-label="กรองตามสถานะบัญชี" className="mt-4">
        <ul className="flex flex-wrap gap-2">
          {USER_STATUS_FILTER_OPTIONS.map((option) => {
            const active = option.value === filter;
            return (
              <li key={option.value}>
                <Link
                  href={buildUsersHref({ status: option.value, q })}
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
          caption="ตารางผู้ใช้ (ข้อมูลจาก BFF — อัปเดตสดทุกครั้งที่เปิดหน้า)"
          columns={columns}
          rows={rows}
          getKey={(user) => user.id}
          emptyTitle="ยังไม่มีผู้ใช้ตามเงื่อนไขที่เลือก"
          emptyHint="ลองเปลี่ยนสถานะหรือล้างคำค้นหา แล้วลองใหม่อีกครั้ง"
        />
      </div>

      <p className="mt-3 text-sm text-ink-500">
        หน้านี้แสดง {rows.length} บัญชี (หน้าละ {ADMIN_USERS_PAGE_SIZE})
        {page.hasMore ? " — ยังมีรายการต่อ" : ""}
      </p>
      {page.hasMore && page.nextCursor !== null ? (
        <Link
          href={buildUsersHref({ status: filter, q, cursor: page.nextCursor })}
          className="mt-2 inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          โหลดเพิ่ม
        </Link>
      ) : null}
    </div>
  );
}
