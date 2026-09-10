/**
 * unit tests — POST /api/v1/auth/logout (gate r4 MAJOR-1)
 *
 * จุดที่เคยรั่ว: route เดิมเช็ค getUser ก่อน — auth server ล่ม (5xx/network) ทำให้
 * getUser คืน null → route ตอบ 401 โดยไม่ได้เรียก signOut เลย → UI เห็น 401 แล้ว
 * เดินหน้าไป /login เหมือนออกสำเร็จ ทั้งที่ session ยังใช้ได้อยู่
 * แบบใหม่: เรียก signOut ตรง — สำเร็จ/session ตายชัด → 204 · upstream ล้ม → 503
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("@/lib/supabase/ssr", () => ({
  createSupabaseSsrClient: vi.fn(async () => ({ auth: { signOut } })),
}));

import { POST } from "./route";

afterEach(() => {
  signOut.mockReset();
});

describe("POST /api/v1/auth/logout", () => {
  it("signOut สำเร็จ → 204 (scope local)", async () => {
    signOut.mockResolvedValue({ error: null });
    const res = await POST();
    expect(res.status).toBe(204);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("ไม่มี session เหลือ (AuthSessionMissingError) → 204 idempotent", async () => {
    signOut.mockResolvedValue({ error: { name: "AuthSessionMissingError" } });
    const res = await POST();
    expect(res.status).toBe(204);
  });

  it("auth server ยืนยัน session ใช้ไม่ได้ (401) → 204 — ไม่มีอะไรให้เพิกถอน", async () => {
    signOut.mockResolvedValue({ error: { name: "AuthSessionMissingError", status: 401 } });
    const res = await POST();
    expect(res.status).toBe(204);
  });

  it("auth server ล่ม (503) → 503 ERR-SYS-002 — ห้ามตอบ 204/401 (session ยังไม่ถูกเพิกถอน)", async () => {
    signOut.mockResolvedValue({ error: { name: "AuthRetryableFetchError", status: 503 } });
    const res = await POST();
    expect(res.status).toBe(503);
    expect(signOut).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("network ล้มทั้งที่ไม่มี status → 503 ERR-SYS-002 (fail-visible)", async () => {
    signOut.mockResolvedValue({ error: { name: "AuthRetryableFetchError" } });
    const res = await POST();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});
