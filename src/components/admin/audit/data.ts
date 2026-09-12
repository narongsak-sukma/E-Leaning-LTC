/**
 * audit/data — ชั้นข้อมูลหน้า /admin/audit (Wave E Phase 5 · lane F)
 *
 * - เรียก GET /api/v1/admin/audit-logs (API-SPECIFICATION §3.8 แถว 227 — RPC
 *   admin_list_audit_logs 0036: filter action/actor/entity_type/entity_id/ช่วงเวลา + keyset ·
 *   staff:viewer/super_admin · อ่านอย่างเดียว — ไม่มี endpoint แก้/ลบ)
 * - query params ฝั่ง BFF: action (prefix), actor, entityType, entityId, from, to, cursor, limit
 *   (สมมติฐานสัญญา — ตรวจซ้ำเมื่อ lane B ส่งมอบ route จริง; บันทึกใน .omc/handoffs แล้ว)
 * - แถวผิดรูป = fail-closed ทั้งหน้า · 401/403 → "forbidden" · อื่น ๆ → "server"
 */
import "server-only";
import { headers } from "next/headers";
import { ApiError, fetchJson } from "@/lib/api/transport";
import { getConfig } from "@/lib/config";
import type { AdminDataErrorKind, AdminResult } from "@/lib/fixtures/admin";

/** ขนาดหน้าของบันทึกการตรวจสอบ — default 20 เพดาน 100 ตาม RPC จริง (0036) */
export const AUDIT_PAGE_SIZE = 20;

/** แถวบันทึกการตรวจสอบ (camelCase ตาม convention resource) — ไม่มี before/after/hash ตามสัญญา */
export type AdminAuditRow = {
  id: string;
  occurredAt: string;
  action: string;
  /** ผู้กระทำ (BFF แปลง uuid → ชื่อ/รหัสแสดง) — null = ระบบ/ไม่ระบุ */
  actor: string | null;
  entityType: string | null;
  entityId: string | null;
  /** บริบท (jsonb จาก audit_logs) — แสดง preview แบบ expandable ในหน้า */
  context: unknown;
};

/** ผลหน้า keyset — รูปร่างเดียวกับหน้ารายการอื่น */
export type AdminAuditLogsPage = {
  data: readonly AdminAuditRow[];
  page: { nextCursor: string | null; hasMore: boolean };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** อ่าน string ที่อนุญาต null — type อื่น = undefined (contract ผิดรูป) */
function nullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** pure — ค่า JSON ที่อนุญาต (null/primitive/array/record) — ใช้กับบริบท jsonb */
export function isJsonValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" || Array.isArray(value) || isRecord(value);
}

/** pure — แถวผ่าน contract → view · ผิดรูป → null (fail-closed) */
export function parseAdminAuditRow(raw: unknown): AdminAuditRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = requiredString(raw, "id");
  const occurredAt = requiredString(raw, "occurredAt");
  const action = requiredString(raw, "action");
  const actor = nullableString(raw, "actor");
  const entityType = nullableString(raw, "entityType");
  const entityId = nullableString(raw, "entityId");
  const context = raw["context"];
  if (
    id === null ||
    occurredAt === null ||
    action === null ||
    actor === undefined ||
    entityType === undefined ||
    entityId === undefined ||
    context === undefined
  ) {
    return null;
  }
  if (isJsonValue(context) === false) {
    return null;
  }
  return { id, occurredAt, action, actor, entityType, entityId, context };
}

/** แตก { data: [...], page: { nextCursor, hasMore } } — ผิดรูป = null (fail-closed) */
export function parseAdminAuditLogsPage(body: unknown): AdminAuditLogsPage | null {
  if (!isRecord(body)) {
    return null;
  }
  const items = body["data"];
  const rawPage = body["page"];
  if (!Array.isArray(items) || !isRecord(rawPage)) {
    return null;
  }
  const data: AdminAuditRow[] = [];
  for (const item of items) {
    const row = parseAdminAuditRow(item);
    if (row === null) {
      return null;
    }
    data.push(row);
  }
  const nextCursor = nullableString(rawPage, "nextCursor");
  const hasMore = rawPage["hasMore"];
  if (nextCursor === undefined || typeof hasMore !== "boolean") {
    return null;
  }
  return {
    data,
    page: { nextCursor, hasMore },
  };
}

/** เงื่อนไขกรองของหน้า — ค่าที่ผ่านการตรวจแล้วจาก URL */
export type AuditQuery = {
  action: string;
  actor: string;
  entityType: string;
  from: string;
  to: string;
  cursor: string;
};

/** pure — ตัดช่องว่างหัว/ท้ายของทุกช่องกรอง (ค่าที่ไม่มี = "") */
export function buildAuditQuery(raw: {
  action?: string | undefined;
  actor?: string | undefined;
  entityType?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
}): AuditQuery {
  return {
    action: raw.action?.trim() ?? "",
    actor: raw.actor?.trim() ?? "",
    entityType: raw.entityType?.trim() ?? "",
    from: raw.from?.trim() ?? "",
    to: raw.to?.trim() ?? "",
    cursor: raw.cursor?.trim() ?? "",
  };
}

/** pure — href ของหน้ารายการ — แนบเฉพาะช่องที่มีค่า (URL = state จริง) */
export function buildAuditHref(query: AuditQuery): string {
  const search = new URLSearchParams();
  if (query.action.length > 0) {
    search.set("action", query.action);
  }
  if (query.actor.length > 0) {
    search.set("actor", query.actor);
  }
  if (query.entityType.length > 0) {
    search.set("entityType", query.entityType);
  }
  if (query.from.length > 0) {
    search.set("from", query.from);
  }
  if (query.to.length > 0) {
    search.set("to", query.to);
  }
  if (query.cursor.length > 0) {
    search.set("cursor", query.cursor);
  }
  const qs = search.toString();
  return qs.length > 0 ? `/admin/audit?${qs}` : "/admin/audit";
}

/** GET /api/v1/admin/audit-logs — อ่านอย่างเดียว (staff:viewer, super_admin) */
export async function getAdminAuditLogs(query: AuditQuery): Promise<AdminResult<AdminAuditLogsPage>> {
  const parameters: Record<string, string> = {};
  if (query.action.length > 0) {
    parameters["action"] = query.action;
  }
  if (query.actor.length > 0) {
    parameters["actor"] = query.actor;
  }
  if (query.entityType.length > 0) {
    parameters["entityType"] = query.entityType;
  }
  if (query.from.length > 0) {
    parameters["from"] = query.from;
  }
  if (query.to.length > 0) {
    parameters["to"] = query.to;
  }
  if (query.cursor.length > 0) {
    parameters["cursor"] = query.cursor;
  }
  parameters["limit"] = String(AUDIT_PAGE_SIZE);
  const search = new URLSearchParams(parameters);
  const headerBag = await headers();
  try {
    const result = await fetchJson(
      `/api/v1/admin/audit-logs?${search.toString()}`,
      { method: "GET" },
      {
        origin: getConfig().publicBaseUrl,
        cookieHeader: headerBag.get("cookie") ?? "",
      },
    );
    const parsed = parseAdminAuditLogsPage(result.body);
    if (parsed === null) {
      return { ok: false, kind: "server" };
    }
    return { ok: true, data: parsed };
  } catch (error: unknown) {
    const kind: AdminDataErrorKind =
      error instanceof ApiError && (error.status === 401 || error.status === 403)
        ? "forbidden"
        : "server";
    return { ok: false, kind };
  }
}
