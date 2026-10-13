/**
 * DCR-TEST-HARNESS-PORTABILITY จุด 3 — เทสทิศลบของ inspect path (binding ตาม
 * pm consent รอบ 1): ผล docker inspect ที่เบี้ยว/ไม่ผ่าน KEY=VALUE ต้อง throw
 * ห้ามตีความเป็น "ไม่มี override" แบบเงียบ — qa พิสูจน์แล้วว่า template รูป bare
 * {{.}} ตอบ rc=0 กับบรรทัดเดียวเบี้ยว จน PGRST_DB_POOL* จริงนับได้ 0 = ผ่านเงียบ
 * ในเคส fail-closed · ฟังก์ชันที่ under test เป็นบริสุทธิ์ (ไม่แตะ docker) จึงรันได้
 * ทั้งใน suite integration และแยกเดี่ยว
 */
import { describe, expect, it } from "vitest";

import { parseRestEnvInspect, postgrestPoolBoundFromEnv } from "./test-io";

const NL = String.fromCharCode(10);
const joinLines = (lines: string[]): string => lines.join(NL);

// ตัวอย่างผล inspect ที่ครบถูกต้อง (มี tripwire PGRST_DB_URI · ไม่มี PGRST_DB_POOL*)
const HEALTHY = [
  "PGRST_DB_URI=postgres://app:pw@db:5432/postgres",
  "PGRST_DB_SCHEMAS=public",
  "PATH=/usr/local/bin:/usr/bin",
  "PGRST_DB_AGGREGATES_ENABLED=false",
];

describe("parseRestEnvInspect — loud-fail ทุกทิศ (ทิศลบ binding)", () => {
  it("stdout ว่าง → throw (ห้ามตีความเป็น 0)", () => {
    expect(() => parseRestEnvInspect("")).toThrow();
  });

  it("stdout เป็น whitespace ล้วน → throw (ห้ามตีความเป็น 0)", () => {
    expect(() => parseRestEnvInspect("   " + NL + NL + "  ")).toThrow();
  });

  it("มีบรรทัดเบี้ยวไม่ผ่านรูป KEY=VALUE → throw ทั้งผล", () => {
    expect(() => parseRestEnvInspect(joinLines([...HEALTHY, "not-a-kv-line"]))).toThrow();
  });

  it("template ผิดรูป bare {{.}} (Go render เป็น [a b c] บรรทัดเดียว) → throw ไม่ใช่นับ 0 แบบเงียบ", () => {
    const mangled = "[" + HEALTHY.join(" ") + "]";
    expect(() => parseRestEnvInspect(mangled + NL)).toThrow();
  });

  it("value ที่มี '=' ซ้อน (URI มี query string) ถือว่าถูกต้อง", () => {
    const env = parseRestEnvInspect(joinLines(["PGRST_DB_URI=postgres://a@b/c?x=1"]));
    expect(env.get("PGRST_DB_URI")).toBe("postgres://a@b/c?x=1");
  });

  it("ผลครบถูกต้อง (println ปิดท้าย newline) → parse ได้ครบทุกคีย์", () => {
    const env = parseRestEnvInspect(joinLines(HEALTHY) + NL);
    expect(env.size).toBe(HEALTHY.length);
  });
});

describe("postgrestPoolBoundFromEnv — tripwire + fail-closed (ทิศลบ binding)", () => {
  it("ไม่เห็น PGRST_DB_URI (อ่านผิดตัว/ผิด container) → throw", () => {
    expect(() => postgrestPoolBoundFromEnv(new Map([["PATH", "/usr/bin"]]))).toThrow();
  });

  it("มี PGRST_DB_POOL* แม้ตัวเดียว → throw (fail-closed)", () => {
    expect(() =>
      postgrestPoolBoundFromEnv(
        new Map([
          ["PGRST_DB_URI", "postgres://x"],
          ["PGRST_DB_POOL_MAX_SIZE", "5"],
        ]),
      ),
    ).toThrow();
  });

  it("อ่านครบถูกต้อง + นับ PGRST_DB_POOL* ได้ 0 → คืน 10_000 (green path เดิม — ห้ามแก้เป็น throw)", () => {
    expect(postgrestPoolBoundFromEnv(parseRestEnvInspect(joinLines(HEALTHY)))).toBe(10_000);
  });
});
