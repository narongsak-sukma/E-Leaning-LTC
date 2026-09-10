/**
 * pagination.test — unit test ของ src/lib/api/pagination.ts (API-SPECIFICATION §1.2)
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { AppError } from "../errors";
import { encodeCursor, decodeCursor, buildPage } from "./pagination";

const SECRET = "test-secret-key-for-cursors";

/** เซ็น payload เองเพื่อสร้าง cursor ปลอมที่ลายเซ็นถูกต้อง (ทดสอบชั้น validate ถัดจาก signature) */
function signBody(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

interface Row {
  readonly id: string;
  readonly createdAt: string;
}

const ROWS: readonly Row[] = [
  { id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-09-01T00:00:01Z" },
  { id: "00000000-0000-4000-8000-000000000002", createdAt: "2026-09-01T00:00:02Z" },
  { id: "00000000-0000-4000-8000-000000000003", createdAt: "2026-09-01T00:00:03Z" },
];

describe("encodeCursor / decodeCursor", () => {
  it("roundtrip ได้ค่า (sortKey, id) เดิม", () => {
    const cursor = encodeCursor({ sortKey: ROWS[1]!.createdAt, id: ROWS[1]!.id }, { secret: SECRET });
    expect(decodeCursor(cursor, { secret: SECRET })).toEqual({
      sortKey: "2026-09-01T00:00:02Z",
      id: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("cursor ถูกแก้ payload → ERR-VAL-001 (bad_signature)", () => {
    const cursor = encodeCursor({ sortKey: "2026-01-01T00:00:00Z", id: ROWS[0]!.id }, { secret: SECRET });
    const parts = cursor.split(".");
    const tampered = Buffer.from(JSON.stringify({ k: "2030-01-01T00:00:00Z", i: ROWS[0]!.id })).toString("base64url");
    const evil = tampered + "." + parts[1];
    const err = (() => {
      try {
        decodeCursor(evil, { secret: SECRET });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-VAL-001");
  });

  it("cursor ที่ไม่ใช่รูปแบบ . คั่น → ERR-VAL-001", () => {
    const err = (() => {
      try {
        decodeCursor("not-a-cursor", { secret: SECRET });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AppError).code).toBe("ERR-VAL-001");
  });

  it("id ไม่ใช่ UUID → ERR-VAL-001", () => {
    const forged = (() => {
      const body = Buffer.from(JSON.stringify({ k: "2026-01-01T00:00:00Z", i: "nope" })).toString("base64url");
      const sig = signBody(body);
      return body + "." + sig;
    })();
    const err = (() => {
      try {
        decodeCursor(forged, { secret: SECRET });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AppError).code).toBe("ERR-VAL-001");
  });
});

describe("buildPage — envelope { data, page } ตาม §1.2", () => {
  const limit = 2;
  const page1 = buildPage({
    rows: ROWS,
    limit,
    sortKeyOf: (r) => r.createdAt,
    idOf: (r) => r.id,
    cursorOptions: { secret: SECRET },
  });
  it("rows > limit → hasMore=true + nextCursor ชี้แถวสุดท้ายของหน้า", () => {
    expect(page1.page.hasMore).toBe(true);
    expect(page1.data).toHaveLength(2);
    expect(decodeCursor(page1.page.nextCursor!, { secret: SECRET })).toEqual({
      sortKey: "2026-09-01T00:00:02Z",
      id: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("rows == limit (หน้าสุดท้ายพอดี) → hasMore=false + nextCursor=null", () => {
    const page = buildPage({
      rows: ROWS.slice(0, 2),
      limit: 2,
      sortKeyOf: (r) => r.createdAt,
      idOf: (r) => r.id,
      cursorOptions: { secret: SECRET },
    });
    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });

  it("nextCursor ของหน้า 1 ใช้ต่อได้จริง (decode แล้วได้ตำแหน่งแถวสุดท้ายของหน้าก่อน)", () => {
    const decoded = decodeCursor(page1.page.nextCursor!, { secret: SECRET });
    expect(decoded.sortKey).toBe("2026-09-01T00:00:02Z");
    expect(decoded.id).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("data และ page อยู่ชุดกันเป็น envelope เดียว (§1.2)", () => {
    expect(Object.keys(page1).sort()).toEqual(["data", "page"]);
    expect(Object.keys(page1.page).sort()).toEqual(["hasMore", "nextCursor"]);
  });
});
