/**
 * api.test — สัญญาชั้นเรียก BFF ของหน้า privacy (D-p5-13 · SEC-011/IDENT-008 · lane E)
 *
 * mock fetch ที่ขอบเขต global — ตรวจ URL/method/headers · สัญญา GET/PATCH /profile/consents
 * (route จริงของ repo) · export 202 {jobId,status} ทั้งรูป envelope และ record ตรง ๆ ·
 * delete 202-ack · 409/429/403 → ApiError คง code/status/message ไทยจาก envelope
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConsentEntry,
  ConsentStatusView,
  ConsentsView,
  ExportJobView,
  consentsApiUrl,
  getMyConsents,
  profileDeleteApiUrl,
  profileExportApiUrl,
  requestMyAccountDeletion,
  requestMyDataExport,
  updateMyConsent,
} from "./api";

/** envelope 200 {data:...} ตาม §1.1 (jsonOk) */
function okEnvelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** response error envelope §1.3 */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** window จำลอง — api.ts resolve origin จาก window.location.origin (node ไม่มีให้เอง) */
function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

/** แถว consent จำลอง — รูปตาม route จริงของ repo ({type,status,updated_at}) */
function consentFixture(
  overrides?: Partial<{ type: string; status: string; updatedAt: string }>,
): Record<string, unknown> {
  return {
    type: overrides?.type ?? "marketing",
    status: overrides?.status ?? "granted",
    updated_at: overrides?.updatedAt ?? "2026-09-12T02:00:00Z",
  };
}

describe("URL builders — path BFF-relative", () => {
  it("คืน path ตาม spec §3.2", () => {
    expect(consentsApiUrl()).toBe("/api/v1/profile/consents");
    expect(profileExportApiUrl()).toBe("/api/v1/profile/export");
    expect(profileDeleteApiUrl()).toBe("/api/v1/profile/delete");
  });
});

describe("getMyConsents — GET /profile/consents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("แกะ envelope → ConsentsView (consents + notice_acknowledgments)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        notice_acknowledgments: [],
        consents: [consentFixture(), consentFixture({ type: "email_notify", status: "revoked" })],
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const view = await getMyConsents();
    expect(view.consents).toHaveLength(2);
    expect(view.consents[0]?.type).toBe("marketing");
    expect(view.consents[0]?.status).toBe("granted");
    expect(view.consents[1]?.status).toBe("revoked");
    expect(view.notice_acknowledgments).toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/profile/consents");
    expect(init.method).toBe("GET");
  });

  it("สัญญาผิดรูป (ไม่มี data) → ERR-SYS-001 fail-closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ consents: [] }), { status: 200 }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMyConsents()).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });

  it("แถว consent ฟิลด์หาย → strict parse fail-closed ERR-SYS-001", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ notice_acknowledgments: [], consents: [{ type: "marketing" }] }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMyConsents()).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });
});

describe("updateMyConsent — PATCH /profile/consents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("grant → body {type, action} · ตอบ {type,status} ตาม route จริง", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ type: "marketing", status: "granted" }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateMyConsent("marketing", "grant");
    expect(result).toEqual({ type: "marketing", status: "granted" });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ type: "marketing", action: "grant" });
  });

  it("revoke email_notify → {type:'email_notify', status:'revoked'}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ type: "email_notify", status: "revoked" }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const result = await updateMyConsent("email_notify", "revoke");
    expect(result.status).toBe("revoked");
  });

  it("500 envelope → ApiError ข้อความไทยจาก BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(500, "ERR-SYS-002", "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(updateMyConsent("marketing", "grant")).rejects.toMatchObject({
      code: "ERR-SYS-002",
      status: 500,
      message: "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่",
    });
  });
});

describe("requestMyDataExport — GET /profile/export (202)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("202 envelope {jobId,status} → ExportJobView", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { jobId: "job-1", status: "queued" } }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const job = await requestMyDataExport();
    expect(job).toEqual({ jobId: "job-1", status: "queued" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/profile/export");
    expect(init.method).toBe("GET");
  });

  it("tolerant ack: 202 record ตรง ๆ (ไม่ห่อ envelope) ก็อ่านได้", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-2", status: "queued" }), { status: 202 }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestMyDataExport()).resolves.toEqual({ jobId: "job-2", status: "queued" });
  });

  it("409 มี pending อยู่แล้ว → ApiError code HTTP_409 (หรือ code จาก BFF)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(409, "ERR-CONFLICT-001", "มีคำขอที่ยังไม่เสร็จ"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestMyDataExport()).rejects.toMatchObject({
      code: "ERR-CONFLICT-001",
      status: 409,
      message: "มีคำขอที่ยังไม่เสร็จ",
    });
  });

  it("429 cooldown → ApiError status 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(429, "ERR-RATE-001", "ขอได้ทุก 24 ชั่วโมง"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestMyDataExport()).rejects.toMatchObject({ code: "ERR-RATE-001", status: 429 });
  });
});

describe("requestMyAccountDeletion — POST /profile/delete (202-ack)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("202 → resolve (body รูปใดก็ได้)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { token_expires_in_hours: 24 } }), { status: 202 }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestMyAccountDeletion()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/profile/delete");
    expect(init.method).toBe("POST");
  });

  it("403 guard บทบาท → ApiError ข้อความไทยจาก BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(403, "ERR-AUTHZ-003", "บัญชีประเภทนี้ต้องขอลบผ่านผู้ดูแลระบบ"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestMyAccountDeletion()).rejects.toMatchObject({
      code: "ERR-AUTHZ-003",
      status: 403,
      message: "บัญชีประเภทนี้ต้องขอลบผ่านผู้ดูแลระบบ",
    });
  });
});

describe("schemas — strict ตามสัญญา", () => {
  it("ConsentEntry/ConsentStatusView/ExportJobView รูปถูกต้องผ่าน", () => {
    expect(ConsentEntry.safeParse(consentFixture()).success).toBe(true);
    expect(ConsentStatusView.safeParse({ type: "marketing", status: "granted" }).success).toBe(true);
    expect(ExportJobView.safeParse({ jobId: "job-1", status: "queued" }).success).toBe(true);
  });

  it("ConsentsView คีย์แปลกปลอม = fail (strict)", () => {
    const parsed = ConsentsView.safeParse({
      notice_acknowledgments: [],
      consents: [],
      extra: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("updated_at ไม่ใช่ ISO → fail", () => {
    const parsed = ConsentEntry.safeParse({
      type: "marketing",
      status: "granted",
      updated_at: "ไม่ใช่เวลา",
    });
    expect(parsed.success).toBe(false);
  });
});
