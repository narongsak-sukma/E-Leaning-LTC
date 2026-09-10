/**
 * response.test — unit test ของ src/lib/api/response.ts (API-SPECIFICATION §1.1–§1.3)
 */
import { describe, expect, it } from "vitest";
import type { NextResponse } from "next/server";
import { AppError, errorDefinition } from "../errors";
import {
  jsonOk,
  jsonCreated,
  jsonNoContent,
  jsonError,
  jsonErrorResponse,
} from "./response";
async function bodyOf(res: NextResponse): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("jsonOk / jsonCreated / jsonNoContent", () => {
  it("jsonOk → 200 { data } + content-type charset + x-request-id", async () => {
    const res = jsonOk({ id: "a" }, { requestId: "req-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(await bodyOf(res)).toEqual({ data: { id: "a" } });
  });

  it("jsonCreated → 201", async () => {
    const res = jsonCreated({ id: "b" });
    expect(res.status).toBe(201);
    expect(await bodyOf(res)).toEqual({ data: { id: "b" } });
  });

  it("jsonNoContent → 204 ไม่มี body แต่ยังมี x-request-id", async () => {
    const res = jsonNoContent({ requestId: "req-2" });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-request-id")).toBe("req-2");
  });
});

describe("jsonError — envelope ตาม API-SPECIFICATION §1.3", () => {
  it("รับ ErrorCode → status/ข้อความไทยจากทะเบียน + request_id ใน details", async () => {
    const res = jsonError("ERR-ASM-004", { requestId: "req-3" });
    expect(res.status).toBe(422);
    expect(res.headers.get("x-request-id")).toBe("req-3");
    const body = await bodyOf(res);
    expect(body).toEqual({
      error: {
        code: "ERR-ASM-004",
        message: errorDefinition("ERR-ASM-004").message,
        details: { request_id: "req-3" },
      },
    });
  });

  it("รับ AppError (ไม่มี requestId) → ไม่มี request_id ใน details", async () => {
    const res = jsonError(new AppError("ERR-NF-001"));
    expect(res.status).toBe(404);
    const body = await bodyOf(res);
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("ERR-NF-001");
    expect(err["details"]).toEqual({});
  });

  it("details.retry_after_sec → ตั้ง header Retry-After (ปัดขึ้น >= 1)", async () => {
    const res = jsonError("ERR-RATE-001", {
      details: { retry_after_sec: 1.4 },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
  });

  it("ERR-SYS-001 ให้ข้อความทะเบียนเสมอ (ไม่ leak รายละเอียด)", async () => {
    const res = jsonError(new AppError("ERR-SYS-001"));
    const body = await bodyOf(res);
    const err = body["error"] as Record<string, unknown>;
    expect(err["message"]).toBe(errorDefinition("ERR-SYS-001").message);
  });

  it("AppError ที่มี details เสริม → คงไว้ใน body พร้อม request_id", async () => {
    const res = jsonError(new AppError("ERR-RBAC-001", { details: { permission: "course:publish" } }), {
      requestId: "req-4",
    });
    const body = await bodyOf(res);
    const err = body["error"] as Record<string, unknown>;
    expect(err["details"]).toEqual({ permission: "course:publish", request_id: "req-4" });
  });
});

describe("jsonErrorResponse — catch-all ของ handler", () => {
  it("AppError → ส่งตรงตาม code", async () => {
    const res = jsonErrorResponse(new AppError("ERR-LRN-001"), { requestId: "req-5" });
    expect(res.status).toBe(403);
    expect(((await bodyOf(res))["error"] as Record<string, unknown>)["code"]).toBe("ERR-LRN-001");
  });

  it("unknown → ERR-SYS-001 500 แบบ opaque", async () => {
    const res = jsonErrorResponse(new Error("secret SQL"));
    expect(res.status).toBe(500);
    expect(((await bodyOf(res))["error"] as Record<string, unknown>)["code"]).toBe("ERR-SYS-001");
  });
});
