/**
 * unit tests — audit/data (Wave E Phase 5 · lane F)
 * parse fail-closed + isJsonValue + buildAuditQuery/buildAuditHref + loader error mapping
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "anonic";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svcic";

import {
  buildAuditHref,
  buildAuditQuery,
  getAdminAuditLogs,
  isJsonValue,
  parseAdminAuditRow,
  parseAdminAuditLogsPage,
} from "./data";

/** แถวตาม wire จริงของ route (AuditLogResource — ผู้กระทำ = actorUserId uuid) */
const ROW = {
  id: "00000000-0000-4000-8000-0000000000bb",
  occurredAt: "2026-08-30T02:00:00Z",
  action: "LICENSE_VERIFY",
  actorUserId: "00000000-0000-4000-8000-0000000000aa",
  entityType: "license_application",
  entityId: "00000000-0000-4000-8000-0000000000cc",
  context: { reason: "เอกสารครบ" },
};

/** view ของหน้า — parser map actorUserId (wire) → actor (แสดงผล) */
const ROW_VIEW = {
  id: ROW.id,
  occurredAt: ROW.occurredAt,
  action: ROW.action,
  actor: ROW.actorUserId,
  entityType: ROW.entityType,
  entityId: ROW.entityId,
  context: ROW.context,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stubBff(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> => jsonResponse(status, body)),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.headers.mockReset();
  mocks.headers.mockResolvedValue({ get: () => "sb-auth=token123" });
});

describe("parseAdminAuditRow", () => {
  it("row ok -> view (actorUserId ของ wire → actor ของหน้า)", () => {
    expect(parseAdminAuditRow(ROW)).toEqual(ROW_VIEW);
  });

  it("row drift -> null", () => {
    expect(parseAdminAuditRow(null)).toBeNull();
    expect(parseAdminAuditRow({ ...ROW, id: "" })).toBeNull();
    expect(parseAdminAuditRow({ ...ROW, occurredAt: 5 })).toBeNull();
    expect(parseAdminAuditRow({ ...ROW, action: undefined })).toBeNull();
    expect(parseAdminAuditRow({ ...ROW, actorUserId: 9 })).toBeNull();
  });

  it("wire เดิมที่ส่ง actor (BFF ไม่เคยส่ง) -> null — กัน regression", () => {
    const legacyWire = { ...ROW } as Record<string, unknown>;
    delete legacyWire["actorUserId"];
    legacyWire["actor"] = "somchai";
    expect(parseAdminAuditRow(legacyWire)).toBeNull();
  });

  it("context must be JSON value", () => {
    expect(parseAdminAuditRow({ ...ROW, context: undefined })).toBeNull();
  });
});

describe("isJsonValue", () => {
  it("json or not", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("x")).toBe(true);
    expect(isJsonValue(5)).toBe(true);
    expect(isJsonValue(true)).toBe(true);
    expect(isJsonValue(["a"])).toBe(true);
    expect(isJsonValue({ a: 1 })).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
  });
});

describe("parseAdminAuditLogsPage", () => {
  it("page ok, one bad row fails whole page", () => {
    const page = { nextCursor: "c2", hasMore: true };
    expect(parseAdminAuditLogsPage({ data: [ROW], page })).toEqual({ data: [ROW_VIEW], page });
    expect(parseAdminAuditLogsPage({ data: [ROW, { ...ROW, id: 7 }], page })).toBeNull();
    expect(parseAdminAuditLogsPage({ data: [ROW] })).toBeNull();
    expect(parseAdminAuditLogsPage({ data: [ROW], page: { hasMore: "yes" } })).toBeNull();
  });
});

describe("buildAuditQuery / buildAuditHref", () => {
  it("query trims all fields", () => {
    const query = buildAuditQuery({
      action: "  LICENSE  ",
      actor: " somchai ",
      entityType: " course ",
      from: " 2026-08-01 ",
      to: " 2026-08-31 ",
      cursor: " c9 ",
    });
    expect(query).toEqual({
      action: "LICENSE",
      actor: "somchai",
      entityType: "course",
      from: "2026-08-01",
      to: "2026-08-31",
      cursor: "c9",
    });
  });

  it("href attaches only non-empty values", () => {
    const href = buildAuditHref(buildAuditQuery({ action: "LICENSE", from: "2026-08-01" }));
    expect(href).toContain("action=LICENSE");
    expect(href).toContain("from=2026-08-01");
    expect(href).not.toContain("actor=");
    expect(href.startsWith("/admin/audit?")).toBe(true);
    expect(buildAuditHref(buildAuditQuery({}))).toBe("/admin/audit");
  });
});

describe("getAdminAuditLogs", () => {
  it("200 ok + params", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        capturedUrl = String(input);
        return jsonResponse(200, { data: [ROW], page: { nextCursor: null, hasMore: false } });
      }),
    );
    const query = buildAuditQuery({ action: "LICENSE", from: "2026-08-01", to: "2026-08-31" });
    const result = await getAdminAuditLogs(query);
    expect(result).toEqual({
      ok: true,
      data: { data: [ROW_VIEW], page: { nextCursor: null, hasMore: false } },
    });
    expect(capturedUrl).toContain("/api/v1/admin/audit-logs?");
    expect(capturedUrl).toContain("action=LICENSE");
    expect(capturedUrl).toContain("from=2026-08-01");
    expect(capturedUrl).toContain(`limit=20`);
  });

  it("401/403 -> forbidden, else server", async () => {
    stubBff(401, { error: { code: "ERR-AUTH-001", message: "x" } });
    expect(await getAdminAuditLogs(buildAuditQuery({}))).toEqual({ ok: false, kind: "forbidden" });
    stubBff(403, { error: { code: "ERR-RBAC-001", message: "x" } });
    expect(await getAdminAuditLogs(buildAuditQuery({}))).toEqual({ ok: false, kind: "forbidden" });
    stubBff(500, { error: { code: "HTTP_500", message: "x" } });
    expect(await getAdminAuditLogs(buildAuditQuery({}))).toEqual({ ok: false, kind: "server" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await getAdminAuditLogs(buildAuditQuery({}))).toEqual({ ok: false, kind: "server" });
    stubBff(200, { data: [{ ...ROW, context: () => 1 }], page: { nextCursor: null, hasMore: false } });
    expect(await getAdminAuditLogs(buildAuditQuery({}))).toEqual({ ok: false, kind: "server" });
  });
});
