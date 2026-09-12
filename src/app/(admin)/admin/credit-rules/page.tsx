import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { AdminDataState } from "@/components/admin/AdminDataState";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { CreditRuleCreateModal } from "@/components/admin/credit/CreditRuleCreateModal";
import { CreditRuleRowActions } from "@/components/admin/credit/CreditRuleRowActions";
import {
  formatRuleCredits,
  ruleCourseScopeThai,
  ruleWindowThai,
} from "@/components/admin/credit/credit.view";
import {
  CREDIT_RULE_STATUSES,
  creditRuleStatusThai,
  creditRuleStatusTone,
  listCreditRules,
  type CreditRuleParsed,
  type CreditRuleStatusValue,
} from "@/lib/api/admin-credit";
import { ApiError } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import { getAdminStaffSession } from "@/lib/fixtures/admin";
import { hasPermission } from "@/lib/rbac";

export const metadata: Metadata = {
  title: "กฎเครดิต · หลังบ้าน",
  description:
    "กฎการได้ credit (lifecycle ร่าง→ใช้งาน→ปลดระวัง) — สร้างกฎใหม่ เผยแพร่ และปลดระวัง (Wave E Phase 3 · Credit Bank)",
};

/**
 * หน้ากฎเครดิต (Wave E Phase 3 · Credit Bank) — ทะเบียนกฎ + lifecycle เท่านั้น
 * - อ่านผ่าน GET /api/v1/admin/credit-rules (keyset) — ข้อมูลผ่าน delegate
 *   lib/api/admin-credit (zod ขาออก fail-closed เหมือน BFF)
 * - สิทธิ์แสดงผลจาก /api/v1/me จริง — การตัดสินจริงอยู่ที่ BFF เสมอ:
 *   credit_rule:view = เห็นตาราง · credit_rule:create = ปุ่มสร้างกฎ ·
 *   credit_rule:update = ปุ่มเผยแพร่/ปลดระวังต่อแถว
 * - แก้เนื้อหากฎไม่มีใน UI โดยเจตนา (semantic immutability — แก้ = สร้างฉบับใหม่)
 * - URL = state จริง (filter status + cursor อยู่ใน query string · GET form)
 */

/** class ของ badge สถานะกฎตาม tone — ภาษาเดียวกับ badge ของ repo */
function statusToneClassOf(tone: "success" | "warning" | "danger"): string {
  if (tone === "success") {
    return "bg-green-50 text-green-800";
  }
  if (tone === "warning") {
    return "bg-amber-50 text-amber-800";
  }
  return "bg-red-50 text-red-700";
}

function isCreditRuleStatus(value: string | undefined): value is CreditRuleStatusValue {
  return value !== undefined && (CREDIT_RULE_STATUSES as readonly string[]).includes(value);
}

/** href ของหน้า — รักษา filter + cursor (URL = state จริง) */
function buildRulesHref(options: {
  readonly status?: CreditRuleStatusValue | undefined;
  readonly cursor?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (options.status !== undefined) {
    search.set("status", options.status);
  }
  if (options.cursor !== undefined && options.cursor.length > 0) {
    search.set("cursor", options.cursor);
  }
  const query = search.toString();
  return query.length > 0 ? `/admin/credit-rules?${query}` : "/admin/credit-rules";
}

export default async function AdminCreditRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  /* เงื่อนไข filter + ตำแหน่งหน้า — ค่าแปลกปลอม = ไม่ระบุ (fail-closed) */
  const statusRaw = params["status"];
  const statusValue = Array.isArray(statusRaw) ? statusRaw[0] : statusRaw;
  const status = isCreditRuleStatus(statusValue) ? statusValue : undefined;
  const cursorRaw = params["cursor"];
  const cursorValue = (Array.isArray(cursorRaw) ? cursorRaw[0] : cursorRaw) ?? "";
  const cursor = cursorValue.length > 0 ? cursorValue : undefined;

  /* สิทธิ์แสดงผลจาก /api/v1/me จริง — BFF ตัดสินซ้ำเสมอ */
  const session = await getAdminStaffSession();
  const roles = session.ok && session.staff !== null ? session.staff.roles : [];
  const canCreate = hasPermission(roles, "credit_rule:create");
  const canUpdate = hasPermission(roles, "credit_rule:update");
  const canView = hasPermission(roles, "credit_rule:view") || canCreate || canUpdate;

  /* โหลดรายการกฎ — เมื่อมีสิทธิ์อ่านเท่านั้น (ผ่าน delegate เดียวกับที่ client ใช้) */
  const cookieHeader = (await headers()).get("cookie");
  let rules: Awaited<ReturnType<typeof listCreditRules>> | null = null;
  let errorKind: "server" | "forbidden" | null = null;
  if (canView) {
    try {
      rules = await listCreditRules(
        { status, cursor, limit: 20 },
        {
          origin: getConfig().publicBaseUrl,
          ...(cookieHeader !== null ? { cookieHeader } : {}),
        },
      );
    } catch (error: unknown) {
      errorKind =
        error instanceof ApiError && error.status === 403 ? "forbidden" : "server";
    }
  }

  const columns: Array<DataTableColumn<CreditRuleParsed>> = [
    {
      id: "code",
      header: "รหัสกฎ",
      render: (rule) => (
        <span className="font-semibold whitespace-nowrap text-ink-900">{rule.code}</span>
      ),
    },
    {
      id: "name",
      header: "ชื่อกฎ / ประเภท credit",
      render: (rule) => (
        <span>
          <span className="font-medium text-ink-900">{rule.name}</span>
          <span className="mt-0.5 block text-xs text-ink-500">{rule.creditType}</span>
        </span>
      ),
    },
    {
      id: "scope",
      header: "ขอบเขต",
      render: (rule) => (
        <span className="text-ink-600">{ruleCourseScopeThai(rule.courseId)}</span>
      ),
    },
    {
      id: "window",
      header: "ช่วงมีผล",
      render: (rule) => (
        <span className="whitespace-nowrap text-ink-600">{ruleWindowThai(rule)}</span>
      ),
    },
    {
      id: "credits",
      header: "จำนวน credit",
      render: (rule) => (
        <span className="whitespace-nowrap font-semibold text-ink-900">
          {formatRuleCredits(rule.credits)}
        </span>
      ),
    },
    {
      id: "status",
      header: "สถานะ",
      render: (rule) => (
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusToneClassOf(creditRuleStatusTone(rule.status))}`}
        >
          {creditRuleStatusThai(rule.status)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "การกระทำ",
      render: (rule) => (
        <CreditRuleRowActions
          ruleId={rule.id}
          code={rule.code}
          status={rule.status}
          canUpdate={canUpdate}
        />
      ),
    },
  ];

  return (
    <div>
      <h1 className="font-heading text-xl font-bold text-ink-900 sm:text-2xl">กฎเครดิต</h1>
      <p className="mt-1 text-sm text-ink-500">
        กฎการได้ credit ของการสอบผ่าน — แก้เนื้อหากฎไม่ได้ แก้ด้วยการสร้างฉบับใหม่เสมอ
        (เผยแพร่จากฉบับร่าง และปลดระวังเมื่อเลิกใช้)
      </p>

      {canView ? (
        <section className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-heading text-base font-semibold text-ink-900">ทะเบียนกฎเครดิต</h2>
            {canCreate ? <CreditRuleCreateModal /> : null}
          </div>

          {/* filter — GET form (URL = state) · ค่าว่าง = ไม่ระบุ (BFF ตัดช่องว่างก่อนตรวจ) */}
          <form method="get" action="/admin/credit-rules" className="mt-3 flex flex-wrap items-end gap-3">
            <fieldset className="flex flex-wrap items-end gap-3">
              <legend className="sr-only">กรองกฎเครดิตตามสถานะ</legend>
              <div>
                <label htmlFor="credit-rule-status" className="block text-sm font-medium text-ink-700">
                  สถานะ
                </label>
                <select
                  id="credit-rule-status"
                  name="status"
                  defaultValue={status ?? ""}
                  className="mt-1 w-48 rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                >
                  <option value="">ทุกสถานะ</option>
                  {CREDIT_RULE_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {creditRuleStatusThai(value)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="rounded-[10px] bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-card hover:bg-brand-700"
              >
                กรอง
              </button>
            </fieldset>
          </form>

          {rules !== null ? (
            <>
              <div className="mt-3">
                <DataTable
                  caption="ตารางกฎเครดิต (ข้อมูลจาก BFF — แถวผิดรูปจะไม่ถูกแสดง)"
                  columns={columns}
                  rows={rules.data}
                  getKey={(rule) => rule.id}
                  emptyTitle="ยังไม่มีกฎเครดิตที่ตรงเงื่อนไข"
                  emptyHint={
                    canCreate
                      ? "สร้างกฎแรกด้วยปุ่ม “สร้างกฎเครดิต” — กฎใหม่เริ่มที่สถานะฉบับร่าง"
                      : "กฎที่เผยแพร่แล้วจะปรากฏในทะเบียนนี้"
                  }
                />
              </div>
              <p className="mt-3 text-sm text-ink-500">
                หน้านี้แสดง {rules.data.length} กฎ
                {rules.hasMore ? " — ยังมีรายการต่อ" : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {rules.hasMore && rules.nextCursor !== null ? (
                  <Link
                    href={buildRulesHref({ status, cursor: rules.nextCursor })}
                    className="inline-flex rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
                  >
                    หน้าถัดไป
                  </Link>
                ) : null}
                {cursor !== undefined ? (
                  <Link
                    href={buildRulesHref({ status })}
                    className="inline-flex rounded-[10px] border border-mist-300 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-ink-700 hover:bg-mist-100"
                  >
                    กลับไปหน้าแรก
                  </Link>
                ) : null}
              </div>
            </>
          ) : errorKind !== null ? (
            <div className="mt-3">
              <AdminDataState kind={errorKind} retryHref={buildRulesHref({ status })} />
            </div>
          ) : null}
        </section>
      ) : (
        <p className="mt-5 rounded-[10px] bg-mist-100 px-3 py-2 text-sm leading-relaxed text-ink-600">
          คุณไม่มีสิทธิ์ดูกฎเครดิต — แสดงเฉพาะเจ้าหน้าที่ทะเบียนและผู้ดูแลระบบ
        </p>
      )}
    </div>
  );
}
