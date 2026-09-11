/**
 * certificate.test — contract ของ schemas/v1/certificate (Wave D-2 · API-SPECIFICATION §4 #13)
 *
 * จุดหลัก: 4 ฟิลด์ snake_case เท่านั้น (ไม่มี holder_name — PII) · not_found อนุญาต null
 * เท่านั้น · uuid param ของ pdf · mapper ของ /me/certificates
 */
import { describe, expect, it } from "vitest";
import {
  CertificatePublicView,
  CertificateIdParams,
  MyCertificateResource,
  toMyCertificateResource,
  type MyCertificateRow,
} from "./certificate";

const T = "2026-09-01T00:00:00+00:00";

describe("CertificatePublicView — 4 ฟิลด์ snake_case (§4 #13)", () => {
  it("ผ่านรูปเจอ (valid) — issued_at ยอมทั้ง +00:00 และ Z", () => {
    for (const issuedAt of [T, "2026-09-01T00:00:00Z"]) {
      const parsed = CertificatePublicView.parse({
        code: "LTC-2026-000001",
        course_title: "หลักสูตรทดสอบ",
        issued_at: issuedAt,
        status: "valid",
      });
      expect(parsed.status).toBe("valid");
      expect(Object.keys(parsed).sort()).toEqual(["code", "course_title", "issued_at", "status"]);
    }
  });

  it("ผ่านรูป not_found (course_title/issued_at เป็น null)", () => {
    const parsed = CertificatePublicView.parse({
      code: " typed-code ",
      course_title: null,
      issued_at: null,
      status: "not_found",
    });
    expect(parsed).toEqual({
      code: " typed-code ",
      course_title: null,
      issued_at: null,
      status: "not_found",
    });
  });

  it("ห้าม course_title/issued_at เป็น null เมื่อไม่ใช่ not_found (refine)", () => {
    for (const status of ["valid", "revoked", "superseded"] as const) {
      expect(() =>
        CertificatePublicView.parse({
          code: "LTC-2026-000001",
          course_title: null,
          issued_at: T,
          status,
        }),
      ).toThrow();
      expect(() =>
        CertificatePublicView.parse({
          code: "LTC-2026-000001",
          course_title: "หลักสูตรทดสอบ",
          issued_at: null,
          status,
        }),
      ).toThrow();
    }
  });

  it("status นอก enum (เช่น cancelled) ไม่ผ่าน", () => {
    expect(() =>
      CertificatePublicView.parse({
        code: "LTC-2026-000001",
        course_title: "หลักสูตรทดสอบ",
        issued_at: T,
        status: "cancelled",
      }),
    ).toThrow();
  });

  it("contract กัน PII: shape มี 4 คีย์เท่านั้น — ไม่มี holder_name/revoked_at", () => {
    const shape = CertificatePublicView.shape;
    expect(Object.keys(shape).sort()).toEqual(["code", "course_title", "issued_at", "status"]);
    expect(Object.keys(shape)).not.toContain("holder_name");
    expect(Object.keys(shape)).not.toContain("revoked_at");
  });
});

describe("MyCertificateResource + mapper (GET /me/certificates)", () => {
  const row: MyCertificateRow = {
    id: "11111111-2222-4333-8444-555555555501",
    cert_no: "LTC-2026-000001",
    course_title_snapshot: "หลักสูตรทดสอบ",
    issued_at: T,
    status: "valid",
  };

  it("map แถว DB → resource snake_case (id, cert_no, course_title, issued_at, status)", () => {
    const resource = toMyCertificateResource(row);
    expect(resource).toEqual({
      id: "11111111-2222-4333-8444-555555555501",
      cert_no: "LTC-2026-000001",
      course_title: "หลักสูตรทดสอบ",
      issued_at: T,
      status: "valid",
    });
    expect(() => MyCertificateResource.parse(resource)).not.toThrow();
  });

  it("issued_at รูป +00:00 ผ่าน · รูปอื่น (เช่น 09/01/2026) ไม่ผ่าน", () => {
    const resource = toMyCertificateResource(row);
    expect(() => MyCertificateResource.parse({ ...resource, issued_at: "09/01/2026" })).toThrow();
  });
});

describe("CertificateIdParams (pdf)", () => {
  it("uuid ผ่าน", () => {
    expect(() => CertificateIdParams.parse({ code: "11111111-2222-4333-8444-555555555501" })).not.toThrow();
  });

  it("ไม่ใช่ uuid → ไม่ผ่าน (route จะตอบ ERR-VAL-001)", () => {
    expect(() => CertificateIdParams.parse({ code: "LTC-2026-000001" })).toThrow();
    expect(() => CertificateIdParams.parse({ code: "" })).toThrow();
  });
});
