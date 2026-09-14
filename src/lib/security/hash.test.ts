/**
 * hash.test — unit ของ src/lib/security/hash.ts (Wave G P2 · D76)
 *
 * userAgentHashOf — สกัดจาก certificates/[code]/route.ts แบบคงพฤติกรรมเดิมเป๊ะ:
 * - ไม่มี header user-agent → null (ไม่ hash ค่าว่าง)
 * - UA ช่องว่างล้วน → null (trim แล้วว่าง = ถือว่าไม่มี — r9-O1)
 * - UA มีข้อความ → sha256(trimmed + salt) hex64 · salt = IP_HASH_SALT ?? SUPABASE_ANON_KEY
 *   (ค่า env ทดสอบ = "stub-anon-key")
 * - ค่าเดิม hash ซ้ำได้ (deterministic) · ค่าต่างกัน hash ต่างกัน
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

import { userAgentHashOf } from "./hash";

/** request จำลองที่มี/ไม่มี header ตามที่ให้ */
function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/", { headers });
}

/** sha256(ค่า + salt) ตรงสูตร PB-13 (salt จาก env ทดสอบ stub-anon-key) */
function expectedHash(value: string): string {
  return createHash("sha256").update(value + "stub-anon-key").digest("hex");
}

describe("userAgentHashOf — สกัดจาก certificates route (D76 · คงพฤติกรรมเดิมเป๊ะ)", () => {
  it("UA มีข้อความ → sha256(trimmed + salt) hex64", () => {
    const ua = "Mozilla/5.0 (hash-unit-test)";
    const hash = userAgentHashOf(requestWith({ "user-agent": `  ${ua}  ` }));
    expect(hash).toBe(expectedHash(ua)); // trim ก่อน hash
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ไม่มี header user-agent → null", () => {
    expect(userAgentHashOf(requestWith({}))).toBeNull();
  });

  it("UA ช่องว่างล้วน → null (ไม่ hash ค่าว่าง — r9-O1)", () => {
    expect(userAgentHashOf(requestWith({ "user-agent": "   " }))).toBeNull();
  });

  it("deterministic — UA เดิม hash ซ้ำได้เท่ากัน · UA ต่างกัน hash ต่างกัน", () => {
    const a = userAgentHashOf(requestWith({ "user-agent": "AgentA/1.0" }));
    const b = userAgentHashOf(requestWith({ "user-agent": "AgentA/1.0" }));
    const c = userAgentHashOf(requestWith({ "user-agent": "AgentB/2.0" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
