/**
 * unit tests — exam-admin.server (D-7)
 * ครอบ: happy path ของ loader · envelope §1.2 { data, page } · 401/403 → forbidden ·
 * 5xx / JSON พัง / แถวผิดรูป → fail-closed kind "server"
 * วิธี: mock @/lib/config + next/headers + global fetch (ตามแบบ fixtures/admin.test.ts)
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("server-only", () => ({}));

// gate r2: origin ต้องมาจาก config เท่านั้น — mock getConfig กันแตะ env จริง
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ publicBaseUrl: "http://bff-origin.test.local" }),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "session=abc; other=1" }),
}));

import {
  getAdminAssessments,
  getAdminQuestionBanks,
  getEligibleAttempts,
} from "./exam-admin.server";

/** ตอบ response แบบ JSON ตาม envelope */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** แถวชุดข้อสอบจำลอง (AdminAssessmentResource ของ BFF) */
function makeAssessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "as-1",
    code: "EXM-LP1-FINAL",
    title: "ข้อสอบปลายหลักสูตร",
    description: null,
    courseId: "c-101",
    isFinal: true,
    status: "draft",
    createdBy: "u-staff",
    createdAt: "2026-09-01T03:00:00Z",
    rules: null,
    ...overrides,
  };
}

/** แถวคลังข้อสอบจำลอง (QuestionBankResource ของ BFF) */
function makeBank(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "qb-1",
    code: "QB-LP1",
    name: "คลังข้อสอบชุดที่ 1",
    description: null,
    courseId: null,
    categoryId: null,
    isActive: true,
    questionCount: 12,
    createdAt: "2026-09-01T03:00:00Z",
    ...overrides,
  };
}

/** แถวคิวผู้มีสิทธิ์รับใบจำลอง (EligibleAttemptResource ของ BFF) */
function makeEligible(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: "at-1",
    enrollmentId: "en-1",
    userId: "u-9",
    courseId: "c-101",
    holderName: "สมชาย ใจดี",
    scorePct: 86,
    submittedAt: "2026-09-05T06:30:00Z",
    ...overrides,
  };
}

/** ตั้ง fetch จำลองคืน 1 response เดียว — คืน Mock เพื่อตรวจ URL/option ที่ถูกเรียก */
function stubFetchOnce(status: number, body: unknown): Mock {
  const mock = vi.fn().mockResolvedValue(jsonResponse(status, body));
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("getAdminAssessments", () => {
  it("200 พร้อมแถวครบ → ok พร้อม data/page ตรง envelope §1.2", async () => {
    const fetchMock = stubFetchOnce(200, {
      data: [makeAssessment()],
      page: { nextCursor: "cur-2", hasMore: true },
    });
    const result = await getAdminAssessments({ status: "draft", cursor: "cur-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data).toHaveLength(1);
      expect(result.data.data[0]?.code).toBe("EXM-LP1-FINAL");
      expect(result.data.page).toEqual({ nextCursor: "cur-2", hasMore: true });
    }
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/admin/assessments");
    expect(url).toContain("status=draft");
    expect(url).toContain("cursor=cur-1");
    expect(url).toContain("limit=20");
  });

  it("ส่ง cookie ของ request เดิมและ header x-ltc-bff-internal ขึ้น BFF", async () => {
    const fetchMock = stubFetchOnce(200, {
      data: [],
      page: { nextCursor: null, hasMore: false },
    });
    await getAdminAssessments();
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
    const headerBag = new Headers(init.headers);
    expect(headerBag.get("cookie")).toBe("session=abc; other=1");
    expect(headerBag.get("x-ltc-bff-internal")).toBe("1");
    expect(init.cache).toBe("no-store");
  });

  it("403 → forbidden (หน้าแสดงแผงไม่มีสิทธิ์ ไม่ crash)", async () => {
    stubFetchOnce(403, { error: { code: "ERR-RBAC-001", message: "no" } });
    const result = await getAdminAssessments();
    expect(result).toEqual({ ok: false, kind: "forbidden" });
  });

  it("500 → fail-closed kind server", async () => {
    stubFetchOnce(500, { error: { code: "ERR-SYS-001", message: "x" } });
    const result = await getAdminAssessments();
    expect(result).toEqual({ ok: false, kind: "server" });
  });

  it("แถวใดผิดรูป → ทั้งหน้า fail-closed (แถว drift)", async () => {
    stubFetchOnce(200, {
      data: [makeAssessment(), makeAssessment({ id: "as-2", status: "กลางคืน" })],
      page: { nextCursor: null, hasMore: false },
    });
    const result = await getAdminAssessments();
    expect(result).toEqual({ ok: false, kind: "server" });
  });

  it("envelope ไม่มี page → fail-closed (contract ผิดรูป)", async () => {
    stubFetchOnce(200, { data: [makeAssessment()] });
    const result = await getAdminAssessments();
    expect(result).toEqual({ ok: false, kind: "server" });
  });
});

describe("getAdminQuestionBanks", () => {
  it("200 พร้อมแถวครบ → ok พร้อมจำนวนข้อตาม resource", async () => {
    const fetchMock = stubFetchOnce(200, {
      data: [makeBank()],
      page: { nextCursor: null, hasMore: false },
    });
    const result = await getAdminQuestionBanks();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data[0]?.questionCount).toBe(12);
      expect(result.data.data[0]?.isActive).toBe(true);
    }
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/admin/question-banks");
  });

  it("แถวที่ isActive ผิด type → ทั้งหน้า fail-closed", async () => {
    stubFetchOnce(200, {
      data: [makeBank({ isActive: "true" })],
      page: { nextCursor: null, hasMore: false },
    });
    const result = await getAdminQuestionBanks();
    expect(result).toEqual({ ok: false, kind: "server" });
  });
});

describe("getEligibleAttempts", () => {
  it("200 → ok พร้อมคิวทั้งแถว (holderName ค่าว่างได้, scorePct null ได้)", async () => {
    stubFetchOnce(200, {
      data: [makeEligible({ holderName: "", scorePct: null })],
      page: { nextCursor: "q2", hasMore: true },
    });
    const result = await getEligibleAttempts();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data[0]?.holderName).toBe("");
      expect(result.data.data[0]?.scorePct).toBeNull();
      expect(result.data.page).toEqual({ nextCursor: "q2", hasMore: true });
    }
  });

  it("scorePct ผิด type (string) → fail-closed (แยก null จริงออกจาก type ผิด)", async () => {
    stubFetchOnce(200, {
      data: [makeEligible({ scorePct: "86" })],
      page: { nextCursor: null, hasMore: false },
    });
    const result = await getEligibleAttempts();
    expect(result).toEqual({ ok: false, kind: "server" });
  });

  it("เรียก path eligible ถูกต้องพร้อม limit เริ่มต้น", async () => {
    const fetchMock = stubFetchOnce(200, {
      data: [],
      page: { nextCursor: null, hasMore: false },
    });
    await getEligibleAttempts();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/admin/certificates/eligible");
    expect(url).toContain("limit=20");
  });

  it("network ล่ม (fetch ยิง throw) → fail-closed kind server (BFF ล่ม = ไม่แสดง)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const result = await getEligibleAttempts();
    expect(result).toEqual({ ok: false, kind: "server" });
  });
});
