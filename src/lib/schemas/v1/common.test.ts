/**
 * common.test — unit test ของ src/lib/schemas/v1/common.ts (API-SPECIFICATION §4 #12)
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import { PageQuery, parsePageQuery } from "./common";

describe("PageQuery (API-SPECIFICATION §4 #12)", () => {
  it("default limit = 20 เมื่อไม่ส่ง", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 20 });
  });

  it("limit ผ่าน coercion จาก string (query string จริง)", () => {
    expect(PageQuery.parse({ limit: "50" })).toEqual({ limit: 50, cursor: undefined });
  });

  it("ขอบเขต limit: 0 ไม่ผ่าน / 101 ไม่ผ่าน / 1 และ 100 ผ่าน (default 20, max 100 ตาม §1.2)", () => {
    expect(PageQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: "1" }).success).toBe(true);
    expect(PageQuery.safeParse({ limit: "100" }).success).toBe(true);
  });

  it("key แปลกปลอมถูกปฏิเสธ (.strict() ตาม doc §4 #12)", () => {
    expect(PageQuery.safeParse({ limit: "10", foo: "bar" }).success).toBe(false);
  });

  it("cursor > 512 ตัวอักษร ไม่ผ่าน", () => {
    expect(PageQuery.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
  });
});

describe("parsePageQuery — URLSearchParams → parsed query", () => {
  it("แปลง ?limit=5&cursor=abc ได้ตรงตัว", () => {
    expect(parsePageQuery(new URLSearchParams("limit=5&cursor=abc"))).toEqual({
      limit: 5,
      cursor: "abc",
    });
  });

  it("ไม่มี param → { limit: 20 } (default ตาม doc)", () => {
    expect(parsePageQuery(new URLSearchParams(""))).toEqual({ limit: 20 });
  });

  it("limit ไม่ใช่เลข → throw ERR-VAL-001 (400) พร้อม fields", () => {
    const err = (() => {
      try {
        parsePageQuery(new URLSearchParams("limit=abc"));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ERR-VAL-001");
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).details).toEqual({ fields: ["limit"] });
  });

  it("key แปลกปลอม → ERR-VAL-001 ระบุ field", () => {
    const err = (() => {
      try {
        parsePageQuery(new URLSearchParams("sort=desc"));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as AppError).details).toEqual({ fields: ["query"] });
  });
});
