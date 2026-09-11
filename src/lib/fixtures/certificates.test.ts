/**
 * certificates.test — unit test ของ data layer UI ประกาศนียบัตร (Wave D-6)
 *
 * - mapping สถานะไทย (certificate/verification) — ครบทุก enum
 * - ผลตรวจสาธารณะ: 200-always (valid/revoked/superseded/not_found) · parse ผิดสัญญา → fail-closed
 * - GET /me/certificates: envelope { data, page } · แถว drift → ERR-SYS-001
 * - URL builders (encode รหัสก่อนฝัง path)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  certificatePdfApiUrl,
  certificateStatusThai,
  certificateStatusTone,
  formatIssuedAtThai,
  getMyCertificates,
  myCertificatesApiUrl,
  publicVerifyPageUrl,
  verificationDetailThai,
  verificationHeadingThai,
  verifyCertificate,
  verifyCertificateApiUrl,
} from "./certificates";

const ORIGIN = { origin: "http://test.local" };
const UUID_CERT = "00000000-0000-4000-8000-0000000000c1";
const ISO = "2026-09-10T03:00:00+07:00";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** stub fetch + จับ request ล่าสุด (url + headers) ไว้ตรวจ path/header ที่ส่งออก */
function stubFetch(handler: (url: string, init: RequestInit) => Response): {
  lastUrl: () => string;
  lastHeaders: () => Headers;
} {
  let lastUrl = "";
  let lastHeaders = new Headers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(input instanceof URL ? input.href : input);
      lastHeaders = new Headers(init?.headers);
      return handler(lastUrl, init ?? {});
    }),
  );
  return {
    lastUrl: () => lastUrl,
    lastHeaders: () => lastHeaders,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("ทะเบียนข้อความไทยของสถานะประกาศนียบัตร", () => {
  it("certificateStatusThai ครบ 3 สถานะ (valid/revoked/superseded)", () => {
    expect(certificateStatusThai("valid")).toBe("ใช้งานได้");
    expect(certificateStatusThai("revoked")).toBe("ถูกเพิกถอน");
    expect(certificateStatusThai("superseded").length).toBeGreaterThan(0);
    expect(certificateStatusThai("superseded")).toContain("แทนที่");
  });

  it("certificateStatusTone ครบ 3 สถานะ", () => {
    expect(certificateStatusTone("valid")).toBe("success");
    expect(certificateStatusTone("revoked")).toBe("danger");
    expect(certificateStatusTone("superseded")).toBe("warning");
  });

  it("verificationHeadingThai/verificationDetailThai ครบ 4 สถานะ รวม not_found", () => {
    for (const status of ["valid", "revoked", "superseded", "not_found"] as const) {
      expect(verificationHeadingThai(status).length).toBeGreaterThan(0);
      expect(verificationDetailThai(status).length).toBeGreaterThan(0);
    }
  });

  it("formatIssuedAtThai แสดงปีพุทธศักราช (DS §9)", () => {
    const text = formatIssuedAtThai(ISO);
    expect(text).toContain("2569"); // 2026 CE = 2569 BE
    expect(text).toContain("กันยายน");
  });
});

describe("URL builders", () => {
  it("verifyCertificateApiUrl ฝัง code ที่ encode แล้ว", () => {
    expect(verifyCertificateApiUrl("LTC-2026-123456")).toBe(
      "/api/v1/certificates/LTC-2026-123456",
    );
    expect(verifyCertificateApiUrl("abc def")).toBe("/api/v1/certificates/abc%20def");
  });

  it("certificatePdfApiUrl ใช้ id (uuid) ของใบ", () => {
    expect(certificatePdfApiUrl(UUID_CERT)).toBe(`/api/v1/certificates/${UUID_CERT}/pdf`);
  });

  it("publicVerifyPageUrl สร้างลิงก์ /verify/<code>", () => {
    expect(publicVerifyPageUrl("LTC-2026-123456")).toBe("/verify/LTC-2026-123456");
  });

  it("myCertificatesApiUrl ขอ limit=100 (สูงสุดตาม §1.2)", () => {
    expect(myCertificatesApiUrl()).toBe("/api/v1/me/certificates?limit=100");
  });
});

describe("verifyCertificate — ผลตรวจสาธารณะ 200-always", () => {
  it("200 valid → คืน 4 ฟิลด์ตามสัญญา", async () => {
    const stub = stubFetch(() =>
      jsonResponse(200, {
        code: "LTC-2026-123456",
        course_title: "หลักสูตรจริยธรรมทนายความ",
        issued_at: ISO,
        status: "valid",
      }),
    );
    const result = await verifyCertificate("LTC-2026-123456", ORIGIN);
    expect(result).toEqual({
      code: "LTC-2026-123456",
      course_title: "หลักสูตรจริยธรรมทนายความ",
      issued_at: ISO,
      status: "valid",
    });
    expect(stub.lastUrl()).toBe("http://test.local/api/v1/certificates/LTC-2026-123456");
  });

  it("200 not_found → course_title/issued_at เป็น null พอดี (โครง 4 ฟิลด์เดิม)", async () => {
    stubFetch(() =>
      jsonResponse(200, { code: "", course_title: null, issued_at: null, status: "not_found" }),
    );
    const result = await verifyCertificate("unknown-code", ORIGIN);
    expect(result.status).toBe("not_found");
    expect(result.course_title).toBeNull();
    expect(result.issued_at).toBeNull();
  });

  it("200 revoked → parse ผ่าน", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        code: "LTC-2025-000001",
        course_title: "หลักสูตร A",
        issued_at: ISO,
        status: "revoked",
      }),
    );
    const result = await verifyCertificate("LTC-2025-000001", ORIGIN);
    expect(result.status).toBe("revoked");
  });

  it("200 superseded → parse ผ่าน", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        code: "LTC-2025-000002",
        course_title: "หลักสูตร B",
        issued_at: ISO,
        status: "superseded",
      }),
    );
    const result = await verifyCertificate("LTC-2025-000002", ORIGIN);
    expect(result.status).toBe("superseded");
  });

  it("429 ERR-RATE-001 → ApiError พร้อม code จาก envelope", async () => {
    stubFetch(() =>
      jsonResponse(429, {
        error: { code: "ERR-RATE-001", message: "too many requests" },
      }),
    );
    await expect(verifyCertificate("LTC-2026-123456", ORIGIN)).rejects.toMatchObject({
      name: "ApiError",
      code: "ERR-RATE-001",
      status: 429,
    });
  });

  it("503 ERR-SYS-002 → ApiError", async () => {
    stubFetch(() =>
      jsonResponse(503, { error: { code: "ERR-SYS-002", message: "unavailable" } }),
    );
    await expect(verifyCertificate("x", ORIGIN)).rejects.toMatchObject({
      code: "ERR-SYS-002",
      status: 503,
    });
  });

  it("network ล่ม → ApiError status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(verifyCertificate("x", ORIGIN)).rejects.toMatchObject({
      code: "ERR-SYS-001",
      status: 0,
    });
  });

  it("contract drift — ฟิลด์เกิน (เช่น PII รั่วเข้ามา) → fail-closed ERR-SYS-001", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        code: "LTC-2026-123456",
        course_title: "หลักสูตร A",
        issued_at: ISO,
        status: "valid",
        holder_name: "สมชาย ใจดี", // สมมติ BFF รั่ว — UI ต้องไม่แสดงผล
      }),
    );
    await expect(verifyCertificate("LTC-2026-2026", ORIGIN)).rejects.toMatchObject({
      code: "ERR-SYS-001",
    });
  });

  it("contract drift — ฟิลด์ขาด → fail-closed", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        code: "LTC-2026-123456",
        course_title: "หลักสูตร A",
        issued_at: ISO,
      }),
    );
    await expect(verifyCertificate("x", ORIGIN)).rejects.toMatchObject({
      code: "ERR-SYS-001",
    });
  });

  it("contract drift — status นอก enum → fail-closed", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        code: "x",
        course_title: "y",
        issued_at: ISO,
        status: "weird",
      }),
    );
    await expect(verifyCertificate("x", ORIGIN)).rejects.toMatchObject({
      code: "ERR-SYS-001",
    });
  });
});

describe("getMyCertificates — รายการใบของตัวเอง", () => {
  const ROW = {
    id: UUID_CERT,
    cert_no: "LTC-2026-123456",
    course_title: "หลักสูตรจริยธรรมทนายความ",
    issued_at: ISO,
    status: "valid",
  };

  it("200 + แถวผ่าน → certificates + hasMore ตาม envelope", async () => {
    stubFetch(() =>
      jsonResponse(200, { data: [ROW], page: { nextCursor: "abc", hasMore: true } }),
    );
    const result = await getMyCertificates(ORIGIN);
    expect(result.certificates).toHaveLength(1);
    expect(result.certificates[0]?.cert_no).toBe("LTC-2026-123456");
    expect(result.hasMore).toBe(true);
  });

  it("page หาย → hasMore=false (แต่ data ต้องเป็น array เท่านั้น)", async () => {
    stubFetch(() => jsonResponse(200, { data: [] }));
    const result = await getMyCertificates(ORIGIN);
    expect(result.certificates).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("401 ERR-AUTH-001 → ApiError (loader ของหน้า map เป็นสถานะยังไม่เข้าสู่ระบบ)", async () => {
    stubFetch(() =>
      jsonResponse(401, { error: { code: "ERR-AUTH-001", message: "unauthenticated" } }),
    );
    await expect(getMyCertificates(ORIGIN)).rejects.toMatchObject({
      code: "ERR-AUTH-001",
      status: 401,
    });
  });

  it("data ไม่ใช่ array → fail-closed ERR-SYS-001", async () => {
    stubFetch(() => jsonResponse(200, { data: { id: UUID_CERT } }));
    await expect(getMyCertificates(ORIGIN)).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });

  it("แถว drift (คีย์เกิน strict) → fail-closed ทั้งหน้า ERR-SYS-001", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        data: [{ ...ROW, revoked_at: "2026-09-11T00:00:00Z" }],
        page: { hasMore: false },
      }),
    );
    await expect(getMyCertificates(ORIGIN)).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });

  it("เรียก path ถูกต้อง (limit=100)", async () => {
    const stub = stubFetch(() => jsonResponse(200, { data: [], page: { hasMore: false } }));
    await getMyCertificates(ORIGIN);
    expect(stub.lastUrl()).toBe("http://test.local/api/v1/me/certificates?limit=100");
  });

  it("ส่ง header x-ltc-bff-internal เมื่อเรียกจากฝั่ง server (window ไม่มี)", async () => {
    const stub = stubFetch(() => jsonResponse(200, { data: [], page: { hasMore: false } }));
    await getMyCertificates(ORIGIN);
    expect(stub.lastHeaders().get("x-ltc-bff-internal")).toBe("1");
  });
});
