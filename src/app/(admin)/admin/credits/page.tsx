import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { AdminDataState } from "@/components/admin/AdminDataState";
import { CreditAdjustForm } from "@/components/admin/credit/CreditAdjustForm";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import {
  listCreditLedger,
  listCreditRules,
  ledgerEntryTone,
  ledgerEntryTypeThai,
  formatCreditDateTimeThai,
  formatSignedCredit,
  type CreditLedgerRowParsed,
} from "@/lib/api/admin-credit";
import { ApiError } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import { hasPermission } from "@/lib/rbac";

export const metadata: Metadata = {
  title: "บัญชีเครดิต · หลังบ้าน",
  description:
    "บัญชี credit รายบุคคล (ledger) และการปรับ credit ด้วยมือ (+/−) โดยเจ้าหน้าที่ — บันทึกทุกรายการพร้อมเหตุผล (Wave E Phase 3 · Credit Bank)",
};

/**
 * หน้าบัญชีเครดิต (Wave E Phase 3 · Credit Bank) — ledger รายบุคคล + ปรับ credit มือ
 * - gating อ่าน: credit_ledger:view (staff:viewer / staff:registrar / super_admin —
 *   BFF role-scope ซ้ำ ตัด lawyer/instructor ที่ถือ permission เดียวกัน)
 * - ฟอร์มปรับ: credit_adjustment:create (staff:registrar / super_admin) — datalist
 *   ประเภท credit มาจากกฎที่ใช้งานจริง (โหลดฝั่งนี้ · ไม่ใช่ชั้นความปลอดภัย)
 * - ledger: GET form ?user=<uuid> → GET /api/v1/admin/credits/{userId} (keyset ·
 *   "โหลดเพิ่ม" ด้วย cursor) — URL = state จริง
 * - คอลัมน์ ledger ไม่มี PII (id/ประเภท/จำนวน/เหตุผล/created_by uuid) — หน้าไม่ log เอง
 */

/** รูปแบบ uuid ของพารามิเตอร์ ?user — ผิดรูป = ยังไม่โหลด (fail-closed) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** class ของ badge ประเภทรายการตาม tone */
function entryToneClassOf(tone: "success" | "danger" | "neutral" | "warning"): string {
  if (tone === "success") {
    return "bg-green-50 text-green-800";
  }
  if (tone === "warning") {
    return "bg-amber-50 text-amber-800";
  }
  if (tone === "danger") {
    return "bg-red-50 text-red-700";
  }
  return "bg-mist-100 text-ink-600";
}

/** href ของหน้า — รักษา user + cursor (URL = state จริง) */
function buildCreditsHref(options: {
  readonly user?: string | undefined;
  readonly cursor?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (options.user !== undefined && options.user.length > 0) {
    search.set("user", options.user);
  }
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/credits?${query}` : "/admin/credits";
}

export default async function AdminCreditsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  /* ?user=<uuid> + cursor — ผิดรูป uuid = ยังไม่โหลด (แสดงคำแนะนำแทน) */
  const userRaw = params["user"];
  const userValue = (Array.isArray(userRaw) ? userRaw[0] : userRaw) ?? "";
  const user = UUID_RE.test(userValue) ? userValue : null;
  const userInvalid = userValue.length > 0 && user === null;
  const cursorRaw = params["cursor"];
  const cursorValue = (Array.isArray(cursorRaw) ? cursorRaw[0] : cursorRaw) ?? "";
  const cursor = cursorValue.length > 0 ? cursorValue : undefined;

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — BFF ตัดสินซ้ำเสมอ */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canView = hasPermission(roles, "credit_ledger:view");
  const canAdjust = hasPermission(roles, "credit_adjustment:create");

  const cookieHeader = (await headers()).get("cookie");
  const callOptions = {
    origin: getConfig().publicBaseUrl,
    ...(cookieHeader !== null ? { cookieHeader } : {}),
  };

  /* กฎที่ใช้งาน → ตัวเลือกประเภท credit ของฟอร์มปรับ (โหลดเมื่อมีสิทธิ์ปรับเท่านั้น) */
  let creditTypeOptions: readonly string[] = [];
  if (canAdjust) {
    try {
      const activeRules = await listCreditRules({ status: "active", limit: 100 }, callOptions);
      creditTypeOptions = [...new Set(activeRules.data.map((rule) => rule.creditType))];
    } catch {
      // โหลดตัวเลือกไม่ได้ = ยังพิมพ์ประเภทเองได้ (credit_type เป็น config ไม่ใช่ enum)
      creditTypeOptions = [];
    }
  }

  /* ledger ของผู้ใช้ที่ระบุ — โหลดเมื่อ uuid ถูกต้อง */
  let ledger: Awaited<ReturnType<typeof listCreditLedger>> | null = null;
  let errorKind: "server" | "forbidden" | null = null;
  if (canView && user !== null) {
    try {
      ledger = await listCreditLedger(user, { cursor, limit: 20 }, callOptions);
    } catch (error: unknown) {
      errorKind = error instanceof ApiError && error.status === 403 ? "forbidden" : "server";
    }
  }

  const columns: Array<DataTableColumn<CreditLedgerRowParsed>> = [
    {
      id: "at",
      header: "เวลา",
      render: (row) => (
        <span className="whitespace-nowrap text-ink-600">
          {formatCreditDateTimeThai(row.createdAt)}
        </span>
      ),
    },
    {
      id: "type",
      header: "ประเภทรายการ",
      render: (row) => (
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${entryToneClassOf(ledgerEntryTone(row.entryType))}`}
        >
          {ledgerEntryTypeThai(row.entryType)}
        </span>
      ),
    },
    {
      id: "creditType",
      header: "ประเภท credit",
      render: (row) => <span className="text-ink-900">{row.creditType}</span>,
    },
    {
      id: "amount",
      header: "จำนวน",
      render: (row) => (
        <span
          className={`whitespace-nowrap font-semibold ${row.amount > 0 ? "text-green-700" : "text-red-700"}`}
        >
          {formatSignedCredit(row.amount)}
        </span>
      ),
    },
    {
      id: "source",
      header: "ต้นทาง",
      render: (row) => <span className="text-ink-600">{row.sourceType}</span>,
    },
    {
      id: "reason",
      header: "เหตุผล",
      render: (row) => <span className="text-ink-600">{row.reason ?? "—"}</span>,
    },
    {
      id: "by",
      header: "โดย",
      render: (row) => (
        <span className="whitespace-nowrap font-mono text-xs text-ink-500">{row.createdBy ?? "ระบบ"}</span>
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">บัญชีเครดิต</h1>
      <p className="mt-1 text-sm text-ink-500">
        ทุกรายการเป็น append-only — แก้ย้อนหลังไม่ได้ แก้ด้วยรายการปรับใหม่เสมอ
      </p>

      {canView ? (
        <>
          {canAdjust ? (
            <div className="mt-6">
              <CreditAdjustForm creditTypeOptions={creditTypeOptions} />
            </div>
          ) : null}

          {/* ค้น ledger — GET form (URL = state) */}
          <section className="mt-8">
            <h2 className="font-heading text-base font-semibold text-ink-900">
              บัญชี credit รายบุคคล
            </h2>
            <form method="get" action="/admin/credits" className="mt-3 flex flex-wrap items-end gap-3">
              <fieldset className="flex flex-wrap items-end gap-3">
                <legend className="sr-only">ค้นบัญชี credit ของผู้ใช้</legend>
                <div>
                  <label htmlFor="credit-ledger-user" className="block text-sm font-medium text-ink-700">
                    uuid ของผู้ใช้
                  </label>
                  <input
                    id="credit-ledger-user"
                    name="user"
                    type="text"
                    defaultValue={userValue}
                    maxLength={64}
                    placeholder="เช่น 00000000-0000-4000-8000-000000000001"
                    className="mt-1 w-80 rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="rounded-[10px] bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-brand-700"
                >
                  ดูบัญชี
                </button>
              </fieldset>
            </form>
            {userInvalid ? (
              <p className="mt-3 rounded-[10px] bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
                รูปแบบ uuid ไม่ถูกต้อง — คัดลอก uuid จากระบบทะเบียนผู้ใช้แล้ววางอีกครั้ง
              </p>
            ) : null}

            {user !== null && ledger !== null ? (
              <>
                <p className="mt-4 text-sm text-ink-500">
                  บัญชีของ <span className="font-mono text-xs text-ink-700">{user}</span> — พบ{" "}
                  {ledger.data.length} รายการในหน้านี้
                </p>
                <div className="mt-3">
                  <DataTable
                    caption="ตารางบัญชี credit (เรียงใหม่ล่าสุดก่อน — แถวผิดรูปจะไม่ถูกแสดง)"
                    columns={columns}
                    rows={ledger.data}
                    getKey={(row) => row.id}
                    emptyTitle="ยังไม่มีรายการ credit"
                    emptyHint="รายการจะเกิดเมื่อผู้ใช้สอบผ่าน (ได้รับ credit) หรือมีการปรับโดยเจ้าหน้าที่"
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {ledger.hasMore && ledger.nextCursor !== null ? (
                    <Link
                      href={buildCreditsHref({ user, cursor: ledger.nextCursor })}
                      className="inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
                    >
                      โหลดเพิ่ม
                    </Link>
                  ) : null}
                  {cursor !== undefined ? (
                    <Link
                      href={buildCreditsHref({ user })}
                      className="inline-flex rounded-[10px] border border-mist-300 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-ink-700 hover:bg-mist-100"
                    >
                      กลับไปหน้าแรก
                    </Link>
                  ) : null}
                </div>
              </>
            ) : errorKind !== null ? (
              <div className="mt-3">
                <AdminDataState kind={errorKind} retryHref={buildCreditsHref({ user: user ?? undefined, cursor })} />
              </div>
            ) : user !== null && !canView ? null : user === null ? (
              <p className="mt-3 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
                ระบุ uuid ของผู้ใช้เพื่อเปิดบัญชี credit — uuid ได้จากระบบทะเบียนผู้ใช้หรือคำขอใช้สิทธิ์
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <p className="mt-5 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
          คุณไม่มีสิทธิ์ดูบัญชี credit — แสดงเฉพาะเจ้าหน้าที่และผู้ดูแลระบบ
        </p>
      )}
    </div>
  );
}
