/**
 * api.test — สัญญาชั้นเรียก BFF ของหน้าใบอนุญาตว่าความ (D-p5-4 · IDENT-002/005 · lane E)
 *
 * mock fetch ที่ขอบเขต global — GET /me/license (normalize camel/snake + strict fail-closed)
 * · PUT /me/license multipart (ฟิลด์ license_no + file — ห้าม JSON) · validator mirror BFF
 * · formatThaiDateTime
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LICENSE_FILE_MAX_BYTES,
  LICENSE_NO_PATTERN,
  MyLicenseContract,
  formatThaiDateTime,
  getMyLicense,
  normalizeLicenseApplication,
  normalizeLicenseCurrent,
  normalizeMyLicenseView,
  submitMyLicense,
  validateLicenseFile,
  validateLicenseNo,
} from "./api";

/** envelope 200 {data:...} §1.1 */
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

/** window จำลอง — api.ts resolve origin จาก window.location.origin */
function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

const ISO_1 = "2026-09-01T02:00:00Z";
const ISO_2 = "2026-09-10T05:30:00+07:00";

describe("normalizeLicenseApplication / normalizeLicenseCurrent", () => {
  it("รับ camelCase ครบ", () => {
    const application = normalizeLicenseApplication({
      status: "pending",
      submittedAt: ISO_1,
      decidedAt: null,
      rejectedReason: null,
    });
    expect(application).toEqual({
      status: "pending",
      submittedAt: ISO_1,
      decidedAt: null,
      rejectedReason: null,
    });
    expect(
      normalizeLicenseCurrent({ licenseNo: "1234567", verifiedAt: ISO_2 }),
    ).toEqual({ licenseNo: "1234567", verifiedAt: ISO_2 });
  });

  it("รับ snake_case ครบ (tolerant-read)", () => {
    const application = normalizeLicenseApplication({
      status: "rejected",
      submitted_at: ISO_1,
      decided_at: ISO_2,
      rejected_reason: "ไฟล์ไม่ชัด",
    });
    expect(application).toEqual({
      status: "rejected",
      submittedAt: ISO_1,
      decidedAt: ISO_2,
      rejectedReason: "ไฟล์ไม่ชัด",
    });
    expect(
      normalizeLicenseCurrent({ license_no: "1234567", verified_at: ISO_2 }),
    ).toEqual({ licenseNo: "1234567", verifiedAt: ISO_2 });
  });

  it("status ไม่รู้จัก หรือ submittedAt หาย → null (drift)", () => {
    expect(normalizeLicenseApplication({ status: "weird", submittedAt: ISO_1 })).toBeNull();
    expect(normalizeLicenseApplication({ status: "pending" })).toBeNull();
    expect(normalizeLicenseCurrent({ licenseNo: "1234567" })).toBeNull();
  });
});

describe("normalizeMyLicenseView — wrapper และแผงราบ + canResubmit", () => {
  it("แบบ wrapper application/license", () => {
    const view = normalizeMyLicenseView({
      application: { status: "approved", submittedAt: ISO_1, decidedAt: ISO_2, rejectedReason: null },
      license: { licenseNo: "1234567", verifiedAt: ISO_2 },
    });
    expect(view?.application?.status).toBe("approved");
    expect(view?.license?.licenseNo).toBe("1234567");
    expect(view?.canResubmit).toBe(true);
  });

  it("แบบแผงราบ (ฟิลด์คลี่ top-level)", () => {
    const view = normalizeMyLicenseView({
      status: "pending",
      submittedAt: ISO_1,
      decidedAt: null,
      rejectedReason: null,
    });
    expect(view?.application?.status).toBe("pending");
    expect(view?.license).toBeNull();
    expect(view?.canResubmit).toBe(false);
  });

  it("canResubmit ส่งมาเอง → ใช้ค่า server · ไม่ส่ง → derive (ไม่มี pending)", () => {
    const explicit = normalizeMyLicenseView({
      application: null,
      license: null,
      canResubmit: true,
    });
    expect(explicit?.canResubmit).toBe(true);

    const derived = normalizeMyLicenseView({
      application: { status: "approved", submittedAt: ISO_1, decidedAt: ISO_2, rejectedReason: null },
      license: null,
    });
    expect(derived?.canResubmit).toBe(true);

    const derivedPending = normalizeMyLicenseView({
      application: { status: "pending", submittedAt: ISO_1, decidedAt: null, rejectedReason: null },
      license: null,
    });
    expect(derivedPending?.canResubmit).toBe(false);
  });
});

describe("getMyLicense — GET /me/license", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200 → normalize + strict parse ผ่าน · URL/method ถูก", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        application: {
          status: "rejected",
          submittedAt: ISO_1,
          decidedAt: ISO_2,
          rejectedReason: "เอกสารไม่ครบ",
        },
        license: { licenseNo: "1234567", verifiedAt: ISO_2 },
        canResubmit: true,
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const view = await getMyLicense();
    expect(view.application?.rejectedReason).toBe("เอกสารไม่ครบ");
    expect(view.license?.licenseNo).toBe("1234567");
    expect(view.canResubmit).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/me/license");
    expect(init.method).toBe("GET");
  });

  it("body ไม่มี envelope {data} → ERR-SYS-001 fail-closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ application: null, license: null }), { status: 200 }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMyLicense()).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });

  it("submittedAt ไม่ใช่ ISO (strict zod) → ERR-SYS-001 fail-closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        application: { status: "pending", submittedAt: "ไม่ใช่เวลา", decidedAt: null, rejectedReason: null },
        license: null,
        canResubmit: false,
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMyLicense()).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });

  it("500 envelope → ApiError ข้อความไทยจาก BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(500, "ERR-SYS-002", "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMyLicense()).rejects.toMatchObject({
      code: "ERR-SYS-002",
      message: "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่",
    });
  });
});

describe("submitMyLicense — PUT /me/license (multipart)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("FormData ฟิลด์ license_no + file · method PUT · 202 = สำเร็จ", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: null }), { status: 202 }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["pdf-bytes"], "license.pdf", { type: "application/pdf" });

    await expect(
      submitMyLicense({ licenseNo: "1234567", file }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/me/license");
    expect(init.method).toBe("PUT");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("license_no")).toBe("1234567");
    const attached = form.get("file");
    expect(attached).toBeInstanceOf(File);
    expect((attached as File).name).toBe("license.pdf");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
  });

  it("409 มีคำขอ pending → ApiError ข้อความไทยจาก BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(409, "ERR-CONFLICT-001", "มีคำขอที่ยังถูกตรวจสอบอยู่"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(submitMyLicense({ licenseNo: "1234567", file })).rejects.toMatchObject({
      code: "ERR-CONFLICT-001",
      status: 409,
    });
  });
});

describe("validateLicenseNo — mirror ^\\d{6,9}$", () => {
  it("6-9 หลักผ่าน · 5/10 หลักหรือมีตัวอักษร → ข้อความไทย", () => {
    expect(validateLicenseNo("123456")).toBeNull();
    expect(validateLicenseNo("1234567")).toBeNull();
    expect(validateLicenseNo("123456789")).toBeNull();
    expect(validateLicenseNo("12345")).toBe("เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก");
    expect(validateLicenseNo("1234567890")).toBe("เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก");
    expect(validateLicenseNo("1234a67")).toBe("เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก");
    expect(LICENSE_NO_PATTERN.test("123456")).toBe(true);
  });
});

describe("validateLicenseFile — jpg/png/pdf ≤10MB (mirror BFF)", () => {
  it("ขนาดไม่เกิน → ผ่าน (null)", () => {
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    expect(validateLicenseFile(file)).toBeNull();
    expect(LICENSE_FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("เกิน 10MB → ข้อความไทย", () => {
    const big = new File([new Uint8Array(11)], "a.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: LICENSE_FILE_MAX_BYTES + 1 });
    expect(validateLicenseFile(big)).toBe(
      "ไฟล์แนบมีขนาดเกิน 10 เมกะไบต์ กรุณาแนบไฟล์ที่เล็กกว่า",
    );
  });

  it("ชนิดไม่อนุญาต (MIME) → ข้อความไทย", () => {
    const exe = new File(["MZ"], "virus.exe", { type: "application/x-msdownload" });
    expect(validateLicenseFile(exe)).toBe("ชนิดไฟล์ต้องเป็น JPG, PNG หรือ PDF เท่านั้น");
  });

  it("MIME ว่าง → ใช้นามสกุลไฟล์ (.pdf/.jpg/.png ผ่าน · .exe ไม่ผ่าน)", () => {
    const noMimePdf = new File(["x"], "b.pdf", { type: "" });
    expect(validateLicenseFile(noMimePdf)).toBeNull();
    const noMimeJpg = new File(["x"], "c.jpeg", { type: "" });
    expect(validateLicenseFile(noMimeJpg)).toBeNull();
    const noMimeExe = new File(["x"], "d.exe", { type: "" });
    expect(validateLicenseFile(noMimeExe)).toBe("ชนิดไฟล์ต้องเป็น JPG, PNG หรือ PDF เท่านั้น");
  });

  it("MIME กลุ่ม jpg/png ผ่านครบ", () => {
    expect(validateLicenseFile(new File(["x"], "e.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(validateLicenseFile(new File(["x"], "f.png", { type: "image/png" }))).toBeNull();
  });
});

describe("formatThaiDateTime / MyLicenseContract", () => {
  it("วันเวลาไม่ถูกต้อง → คืนค่าเดิม (ไม่ crash)", () => {
    expect(formatThaiDateTime("not-a-date")).toBe("not-a-date");
  });

  it("วันเวลาถูกต้อง → รูปแบบไทย (มีปี พ.ศ.)", () => {
    const text = formatThaiDateTime(ISO_1);
    expect(text).toContain("2569");
  });

  it("MyLicenseContract strict — คีย์แปลกปลอม fail", () => {
    const ok = MyLicenseContract.safeParse({
      application: null,
      license: null,
      canResubmit: true,
    });
    expect(ok.success).toBe(true);
    const bad = MyLicenseContract.safeParse({
      application: null,
      license: null,
      canResubmit: true,
      extra: 1,
    });
    expect(bad.success).toBe(false);
  });
});
