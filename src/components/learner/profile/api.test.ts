/**
 * api.test — สัญญาชั้นเรียก BFF ของหน้าโปรไฟล์ (Wave E Phase 5 · lane E)
 *
 * mock fetch ที่ขอบเขต global — ตรวจ URL/method/headers (cookie forward · x-ltc-bff-internal
 * เฉพาะขา server) · การแกะ envelope {data} · tolerant-read normalize (camelCase/snake_case) ·
 * drift fail-closed ERR-SYS-001 · error envelope → ApiError
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getMyProfile, normalizeMeExtras, updateMyProfile } from "./api";

/** envelope 200 รูปมาตรฐาน {data} */
function okEnvelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** response แบบ error envelope §1.3 */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** window จำลอง — api.ts resolve origin จาก window.location.origin ฝั่ง browser (node ไม่มีให้เอง) */
function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

describe("getMyProfile — GET /api/v1/me", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("แกะ envelope {data} ตามสัญญา Wave C และคืนค่าครบ", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        email: "learner@test.local",
        displayName: "สมชาย ใจดี",
        roles: ["citizen"],
        mfaVerified: false,
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const profile = await getMyProfile();
    expect(profile.displayName).toBe("สมชาย ใจดี");
    expect(profile.phone).toBeNull();
    expect(profile.preferredLocale).toBe("th");
    expect(profile.firstName).toBeNull();
    expect(profile.lastName).toBeNull();
  });

  it("tolerant-read: รับ phone/preferredLocale/first/last_name ทั้ง camelCase และ snake_case", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        email: "learner@test.local",
        displayName: "สมชาย ใจดี",
        roles: ["citizen"],
        mfaVerified: true,
        preferred_locale: "en",
        first_name: "สมชาย",
        last_name: "ใจดี",
        phone: "021234567",
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const profile = await getMyProfile();
    expect(profile.preferredLocale).toBe("en");
    expect(profile.firstName).toBe("สมชาย");
    expect(profile.lastName).toBe("ใจดี");
  });

  it("preferred_locale ที่ไม่รู้จัก normalize เป็น th (default ตาม DD)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        email: "learner@test.local",
        displayName: "สมชาย ใจดี",
        roles: [],
        mfaVerified: false,
        preferredLocale: "jp",
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const profile = await getMyProfile();
    expect(profile.preferredLocale).toBe("th");
  });

  it("drift fail-closed: ขาดฟิลด์บังคับ (displayName) → ApiError ERR-SYS-001", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ id: "x", email: "a@b.c", roles: [], mfaVerified: false }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMyProfile()).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });
});

describe("updateMyProfile — PATCH /api/v1/me", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ส่ง body camelCase เฉพาะเขต self-edit · phone=null ถูกตัดออก · headers ครบ", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(null));
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    await updateMyProfile(
      { displayName: "สมชาย", phone: null, preferredLocale: "en" },
      { cookieHeader: "ltc_session=abc" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/me");
    expect(init.method).toBe("PATCH");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toContain("application/json");
    expect(headers.cookie).toBe("ltc_session=abc");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ displayName: "สมชาย", preferredLocale: "en" });
  });

  it("phone ที่กรอก → ส่งครบ 3 ฟิลด์ · 200 null = สำเร็จ", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(null));
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateMyProfile({ displayName: "สมชาย", phone: "0812345678", preferredLocale: "th" }),
    ).resolves.toBeUndefined();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).toEqual({ displayName: "สมชาย", phone: "0812345678", preferredLocale: "th" });
  });

  it("error envelope 409 → ApiError คง code/message จาก BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(409, "ERR-PATCH-LOCKED", "ข้อมูลถูกแก้ไขโดยเจ้าหน้าที่ กรุณาโหลดใหม่"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      updateMyProfile({ displayName: "สมชาย", phone: null, preferredLocale: "th" }),
    ).rejects.toMatchObject({ code: "ERR-PATCH-LOCKED", status: 409 });
  });
});

describe("normalizeMeExtras — tolerant-read ระดับฟังก์ชัน", () => {
  it("รับ snake_case ครบทุกฟิลด์ — alias ดิบถูกทิ้ง (normalize เข้ารูปกลาง)", () => {
    const extras = normalizeMeExtras({ preferred_locale: "en", first_name: "ก", last_name: "ข" });
    expect(extras).toEqual({ preferredLocale: "en", firstName: "ก", lastName: "ข" });
  });

  it("รับ camelCase ครบทุกฟิลด์", () => {
    const extras = normalizeMeExtras({ preferredLocale: "en", firstName: "ก", lastName: "ข", phone: "02" });
    expect(extras).toEqual({ phone: "02", preferredLocale: "en", firstName: "ก", lastName: "ข" });
  });


  it("ไม่มีฟิลด์เสริมเลย → ไม่มีคีย์เสริมใด ๆ (ทิ้งคีย์แปลกปลอม)", () => {
    expect(normalizeMeExtras({})).toEqual({});
  });
});
