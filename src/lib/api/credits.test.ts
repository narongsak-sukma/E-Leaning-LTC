/**
 * credits.test — unit test ของ data layer "หน่วยกิตสะสม + transcript" (Wave E Phase 3)
 *
 * - URL builders (BFF-relative path)
 * - delegate: envelope { data } + zod strict — drift → ERR-SYS-001 fail-closed ·
 *   error envelope จาก BFF → ApiError (code/message ไทยผ่าน)
 * - ทะเบียนข้อความไทย + ตัวช่วยแสดงผล (pure) ครบทุก enum
 * - เอกสาร CSV: BOM + header ไทย + CRLF + กันสูตร (buildCsv) + เซลล์ว่างเมื่อไม่มีค่า
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  CreditSummaryView,
  ENROLLMENT_STATUSES,
  TranscriptView,
  creditTypeThai,
  cycleStatusThai,
  enrollmentStatusThai,
  formatActivityDateThai,
  formatCertificateListText,
  formatCreditAmount,
  formatCreditsText,
  formatCycleDateThai,
  getMyCreditSummary,
  getMyTranscript,
  myCreditsApiUrl,
  myTranscriptApiUrl,
  passedLabel,
  transcriptCsvApiUrl,
  transcriptCsvDocument,
} from "./credits";

const ORIGIN = { origin: "http://test.local" };
const USER_ID = "b0000000-0000-4000-8000-000000000002";
const CYCLE_ID = "a0000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "c0000000-0000-4000-8000-000000000003";
const COURSE_ID = "d0000000-0000-4000-8000-000000000004";
const ISO = "2026-09-10T03:00:00+07:00";
const BOM = "﻿";

/** สร้างรอบที่ผ่าน schema เสมอ (ทับค่ารายฟิลด์ได้) */
function cycleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cycle_id: CYCLE_ID,
    cycle_no: 1,
    starts_on: "2026-01-01",
    ends_on: "2026-12-31",
    status: "open",
    required_credits: { general: 12 },
    balances: { general: { earned: 3.5, required: 12, missing: 8.5 } },
    ...overrides,
  };
}

function summaryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER_ID,
    current: cycleFixture(),
    history: [cycleFixture()],
    ...overrides,
  };
}

function entryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrollment_id: ENROLLMENT_ID,
    course_id: COURSE_ID,
    course_title: "หลักสูตร A",
    enrollment_status: "completed",
    completed_at: ISO,
    passed: true,
    best_score_pct: 90,
    passed_at: ISO,
    credits: { general: 3.5 },
    certificates: [{ cert_no: "LTC-2026-000001", status: "valid", issued_at: ISO }],
    ...overrides,
  };
}

function transcriptFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER_ID,
    generated_at: ISO,
    entries: [entryFixture()],
    ...overrides,
  };
}

/** stub fetch + จับ request ล่าสุด (url + headers) ไว้ตรวจ path/header ที่ส่งออก */
function stubFetch(handler: (url: string) => Response): {
  lastUrl: () => string;
  lastHeaders: () => Headers;
} {
  let lastUrl = "";
  let lastHeaders = new Headers();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    lastUrl = String(input);
    lastHeaders = new Headers(init?.headers);
    return handler(lastUrl);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { lastUrl: () => lastUrl, lastHeaders: () => lastHeaders };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// [append-more]
// [append-more] — ต่อจากตรงนี้คือเนื้อ test suite

describe("URL builders", () => {
  it("คืน path BFF-relative ตาม API-SPEC §3", () => {
    expect(myCreditsApiUrl()).toBe("/api/v1/me/credits");
    expect(myTranscriptApiUrl()).toBe("/api/v1/me/transcript");
    expect(transcriptCsvApiUrl()).toBe("/api/v1/me/transcript?format=csv");
  });
});

describe("getMyCreditSummary", () => {
  it("200 — ส่ง GET ไป /api/v1/me/credits และคืนข้อมูลที่ผ่าน strict schema", async () => {
    const payload = summaryFixture();
    const stub = stubFetch(
      () => new Response(JSON.stringify({ data: payload }), { status: 200 }),
    );
    const summary = await getMyCreditSummary(ORIGIN);
    expect(stub.lastUrl()).toBe("http://test.local/api/v1/me/credits");
    expect(summary).toEqual(payload);
  });

  it("401 — error envelope → ApiError code/message ไทยจาก BFF", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบก่อนใช้บริการ" },
          }),
          { status: 401 },
        ),
    );
    const err = await getMyCreditSummary(ORIGIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("ERR-AUTH-001");
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe("กรุณาเข้าสู่ระบบก่อนใช้บริการ");
  });

  it("ข้อมูลผิดสัญญา (คีย์เกิน — strict) → ERR-SYS-001 fail-closed", async () => {
    const payload = summaryFixture({ extra: true });
    stubFetch(
      () => new Response(JSON.stringify({ data: payload }), { status: 200 }),
    );
    const err = await getMyCreditSummary(ORIGIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("ERR-SYS-001");
  });

  it("body ไม่ใช่ object (data หาย) → ERR-SYS-001", async () => {
    stubFetch(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    const err = await getMyCreditSummary(ORIGIN).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("ERR-SYS-001");
  });
});

describe("getMyTranscript", () => {
  it("200 — ส่ง GET ไป /api/v1/me/transcript และคืนข้อมูลที่ผ่าน strict schema", async () => {
    const payload = transcriptFixture();
    const stub = stubFetch(
      () => new Response(JSON.stringify({ data: payload }), { status: 200 }),
    );
    const transcript = await getMyTranscript(ORIGIN);
    expect(stub.lastUrl()).toBe("http://test.local/api/v1/me/transcript");
    expect(transcript).toEqual(payload);
  });

  it("entries ว่าง — ผ่าน schema", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: transcriptFixture({ entries: [] }) }),
          { status: 200 },
        ),
    );
    const transcript = await getMyTranscript(ORIGIN);
    expect(transcript.entries).toHaveLength(0);
  });

  it("enrollment_status นอกทะเบียน (strict enum) → ERR-SYS-001", async () => {
    const payload = transcriptFixture({
      entries: [entryFixture({ enrollment_status: "teleporting" })],
    });
    stubFetch(
      () => new Response(JSON.stringify({ data: payload }), { status: 200 }),
    );
    const err = await getMyTranscript(ORIGIN).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("ERR-SYS-001");
  });

  it("data ไม่ใช่ object → ERR-SYS-001", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [1, 2] }), { status: 200 }));
    const err = await getMyTranscript(ORIGIN).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("ERR-SYS-001");
  });
});

describe("schema strict ทุกชั้น", () => {
  it("CreditSummaryView — คีย์เกิน/คีย์ขาด/ชนิดผิด = ตายที่ parse", () => {
    expect(() => CreditSummaryView.parse(summaryFixture())).not.toThrow();
    expect(() => CreditSummaryView.parse(summaryFixture({ extra: 1 }))).toThrow();
    expect(() =>
      CreditSummaryView.parse(summaryFixture({ current: cycleFixture({ cycle_no: "หนึ่ง" }) })),
    ).toThrow();
    expect(() =>
      CreditSummaryView.parse(summaryFixture({ history: undefined })),
    ).toThrow();
  });

  it("TranscriptView — แถว drift (best_score_pct เกิน 100) = ตายที่ parse", () => {
    expect(() => TranscriptView.parse(transcriptFixture())).not.toThrow();
    expect(() =>
      TranscriptView.parse(
        transcriptFixture({ entries: [entryFixture({ best_score_pct: 101 })] }),
      ),
    ).toThrow();
  });

  it("ENROLLMENT_STATUSES ครบ 4 ค่าตาม enum ของ DB (0001 L100)", () => {
    expect(ENROLLMENT_STATUSES).toEqual(["active", "completed", "expired", "cancelled"]);
  });
});

// [append-more2]
// [append-more2] — ทะเบียนไทย + เอกสาร CSV

describe("ทะเบียนข้อความไทย + ตัวช่วยแสดงผล (pure)", () => {
  it("creditTypeThai — ชนิดที่รู้จัก = ป้ายไทย · ชนิดใหม่ = คงรหัสเดิม", () => {
    expect(creditTypeThai("general")).toBe("ทั่วไป");
    expect(creditTypeThai("ethics")).toBe("ethics");
  });

  it("cycleStatusThai — ครบทุก enum cycle_status (0001 L128)", () => {
    expect(cycleStatusThai("open")).toBe("กำลังดำเนินอยู่");
    expect(cycleStatusThai("closed")).toBe("ปิดแล้ว");
    expect(cycleStatusThai("grace")).toBe("ช่วงผ่อนผัน");
  });

  it("enrollmentStatusThai — ครบทุก enum enrollment_status (0001 L100)", () => {
    expect(enrollmentStatusThai("active")).toBe("กำลังเรียน");
    expect(enrollmentStatusThai("completed")).toBe("เรียนจบแล้ว");
    expect(enrollmentStatusThai("expired")).toBe("สิทธิ์เรียนหมดอายุ");
    expect(enrollmentStatusThai("cancelled")).toBe("ยกเลิก");
  });

  it("passedLabel — ครบสามกรณี (null = ยังไม่มีผลสอบ)", () => {
    expect(passedLabel(true)).toBe("ผ่าน");
    expect(passedLabel(false)).toBe("ไม่ผ่าน");
    expect(passedLabel(null)).toBe("ยังไม่มีผลสอบ");
  });

  it("formatCreditAmount — เต็มตัดทศนิยม · เศษคง 2 ตำแหน่ง", () => {
    expect(formatCreditAmount(12)).toBe("12");
    expect(formatCreditAmount(3.5)).toBe("3.50");
    expect(formatCreditAmount(8.25)).toBe("8.25");
  });

  it("formatCreditsText — general: 3.50 · หลายชนิดเรียงคีย์คั่น ; · ว่าง = เซลล์ว่าง", () => {
    expect(formatCreditsText({ general: 3.5 })).toBe("general: 3.50");
    expect(formatCreditsText({ ethics: 1, general: 3.5 })).toBe("ethics: 1; general: 3.50");
    expect(formatCreditsText({})).toBe("");
  });

  it("formatCertificateListText — cert_no (สถานะไทย) คั่น ; · ไม่มีใบ = เซลล์ว่าง", () => {
    const certs = [
      { cert_no: "LTC-2026-000001", status: "valid" as const, issued_at: ISO },
      { cert_no: "LTC-2026-000002", status: "revoked" as const, issued_at: ISO },
    ];
    expect(formatCertificateListText(certs)).toBe(
      "LTC-2026-000001 (ใช้งานได้); LTC-2026-000002 (ถูกเพิกถอน)",
    );
    expect(formatCertificateListText([])).toBe("");
  });

  it("formatCycleDateThai/formatActivityDateThai — ปฏิทินพุทธศักราช", () => {
    expect(formatCycleDateThai("2026-01-01")).toContain("2569");
    expect(formatCycleDateThai("2026-01-01")).toContain("มกราคม");
    expect(formatActivityDateThai(ISO)).toContain("2569");
  });
});

describe("transcriptCsvDocument", () => {
  it("BOM นำหน้า + header ไทยครบ 9 คอลัมน์ + CRLF ตาม RFC 4180", () => {
    const csv = transcriptCsvDocument(
      TranscriptView.parse(transcriptFixture()),
    );
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      BOM + "ลำดับ,หลักสูตร,สถานะการลงทะเบียน,วันที่เรียนจบ,ผ่าน,คะแนนสูงสุด (%),วันที่ผ่าน,หน่วยกิต,ใบประกาศณียบัตร",
    );
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("แถวข้อมูล — ลำดับเริ่ม 1 · สถานะไทย · วันที่ไทย · หน่วยกิต text · ใบประกาศฯ text", () => {
    const csv = transcriptCsvDocument(
      TranscriptView.parse(
        transcriptFixture({
          entries: [entryFixture(), entryFixture({ enrollment_id: ENROLLMENT_ID, course_title: "หลักสูตร B", passed: false, best_score_pct: null, passed_at: null, completed_at: null, credits: {}, certificates: [] })],
        }),
      ),
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    const row1 = lines[1];
    expect(row1).toContain("หลักสูตร A");
    expect(row1).toContain("เรียนจบแล้ว");
    expect(row1).toContain("ผ่าน");
    expect(row1).toContain("general: 3.50");
    expect(row1).toContain("LTC-2026-000001 (ใช้งานได้)");
    const row2 = lines[2];
    expect(row2).toContain("หลักสูตร B");
    expect(row2).toContain("ไม่ผ่าน");
    expect(row2).not.toContain("LTC-2026-");
  });

  it("กันสูตร CSV — ชื่อหลักสูตรขึ้นต้น = ถูกนำหน้า ' และครอบ quote เมื่อมี ,", () => {
    const csv = transcriptCsvDocument(
      TranscriptView.parse(
        transcriptFixture({
          entries: [
            entryFixture({ course_title: "=DROP TABLE, หลักสูตรอันตราย" }),
          ],
        }),
      ),
    );
    expect(csv).toContain(`"'=DROP TABLE, หลักสูตรอันตราย"`);
  });

  it("best_score_pct เป็น null = เซลล์ว่าง (ไม่ใช่คำว่า null)", () => {
    const csv = transcriptCsvDocument(
      TranscriptView.parse(
        transcriptFixture({ entries: [entryFixture({ best_score_pct: null })] }),
      ),
    );
    expect(csv).not.toContain("null");
  });
});
