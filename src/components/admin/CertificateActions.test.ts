/**
 * unit tests — CertificateActions logic (D-7)
 * ครอบ: parsers fail-closed ทั้ง 3 resource · certIssueReducer · certManageReducer
 * (actionKind กำหนดโมดัลที่เปิด · สถานะ error/success คงอยู่จนกดปิด) ·
 * เกณฑ์เหตุผลเพิกถอน · uuid guard · หัวข้อ/ป้ายปุ่มยืนยันตาม phase
 */
import { describe, expect, it } from "vitest";

import {
  CERT_MANAGE_DEFAULT,
  certIssueReducer,
  certManageReducer,
  isUuid,
  issueConfirmLabelOf,
  issueTitleOf,
  manageConfirmLabelOf,
  manageTitleOf,
  parseIssuedCertificateView,
  parseRevokedCertificateView,
  parseReissuedCertificateView,
  REVOKE_REASON_MIN_LENGTH,
  revokeReasonValid,
  type IssuedCertificateView,
} from "./CertificateActions";

/** ใบ valid จำลองตรง IssuedCertificateResource ของ BFF */
function makeIssued(overrides: Partial<IssuedCertificateView> = {}): IssuedCertificateView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    certNo: "CERT-2569-000001",
    verifyCode: "VC-0001",
    enrollmentId: "en-1",
    userId: "u-9",
    courseId: "c-101",
    holderNameSnapshot: "สมชาย ใจดี",
    courseTitleSnapshot: "กฎหมายที่ประชาชนควรรู้เบื้องต้น",
    creditSnapshot: null,
    status: "valid",
    issuedAt: "2026-09-05T06:30:00Z",
    pdfMediaId: null,
    ...overrides,
  };
}

/** ตัวเลือกไม่ถูกของ parser test — ผิดรูปทั้งหมดต้องได้ null */
const INVALID_ISSUED_ROWS: readonly unknown[] = [
  null,
  "text",
  {},
  { ...makeIssued(), id: "" },
  { ...makeIssued(), status: "revoked" },
  { ...makeIssued(), issuedAt: "ไม่ใช่วันที่" },
  { ...makeIssued(), creditSnapshot: "3" },
  { ...makeIssued(), pdfMediaId: 5 },
];

describe("parseIssuedCertificateView", () => {
  it("แถวครบตาม contract → view ครบทุกฟิลด์", () => {
    const view = parseIssuedCertificateView(makeIssued());
    expect(view).not.toBeNull();
    expect(view?.certNo).toBe("CERT-2569-000001");
    expect(view?.creditSnapshot).toBeNull();
  });

  it("ผิดรูปทุกแบบ → null (fail-closed — ไม่แสดงข้อมูลที่ไม่น่าเชื่อถือ)", () => {
    for (const row of INVALID_ISSUED_ROWS) {
      expect(parseIssuedCertificateView(row)).toBeNull();
    }
  });

  it("creditSnapshot เป็นจำนวนเต็ม → ผ่าน", () => {
    const view = parseIssuedCertificateView(makeIssued({ creditSnapshot: 3 }));
    expect(view?.creditSnapshot).toBe(3);
  });
});

describe("parseRevokedCertificateView", () => {
  it("แถวครบ → view ครบ", () => {
    const view = parseRevokedCertificateView({
      id: "22222222-2222-4222-8222-222222222222",
      certNo: "CERT-2569-000002",
      status: "revoked",
      revokedAt: "2026-09-06T00:00:00Z",
      revokedReason: "ตรวจพบการทุจริตในการสอบ",
    });
    expect(view?.status).toBe("revoked");
    expect(view?.revokedReason).toContain("ทุจริต");
  });

  it("ผิดรูป → null", () => {
    expect(parseRevokedCertificateView(null)).toBeNull();
    expect(parseRevokedCertificateView({})).toBeNull();
    expect(parseRevokedCertificateView({ ...makeIssued(), status: "valid" })).toBeNull();
  });
});

describe("parseReissuedCertificateView", () => {
  it("ครบทั้งใบใหม่และใบเดิม → view ครบ (ใบใหม่ตรวจซ้ำด้วย parser ใบ valid)", () => {
    const view = parseReissuedCertificateView({
      newCertificate: makeIssued(),
      oldCertificateId: "33333333-3333-4333-8333-333333333333",
      oldStatus: "superseded",
      oldSupersededBy: "11111111-1111-4111-8111-111111111111",
    });
    expect(view?.newCertificate.certNo).toBe("CERT-2569-000001");
    expect(view?.oldStatus).toBe("superseded");
  });

  it("ใบใหม่ผิดรูป → null ทั้ง view (fail-closed)", () => {
    expect(parseReissuedCertificateView({
      newCertificate: { ...makeIssued(), status: "revoked" },
      oldCertificateId: "33333333-3333-4333-8333-333333333333",
      oldStatus: "superseded",
      oldSupersededBy: "11111111-1111-4111-8111-111111111111",
    })).toBeNull();
  });
});

describe("revokeReasonValid / isUuid", () => {
  it("เหตุผลต้อง trim แล้วยาว ≥ 10 ตัวอักษร (mirror route จริง)", () => {
    expect(REVOKE_REASON_MIN_LENGTH).toBe(10);
    expect(revokeReasonValid("สั้น")).toBe(false);
    expect(revokeReasonValid("หลังสอบพบการทุจริต")).toBe(true);
    expect(revokeReasonValid("   ตัดช่องว่าง   ")).toBe(true);
    expect(revokeReasonValid("         ")).toBe(false);
  });

  it("uuid รูปแบบถูกต้องผ่าน ตัดช่องว่างขอบได้ และปฏิเสธค่ามั่ว", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("  11111111-1111-4111-8111-111111111111  ")).toBe(true);
    expect(isUuid("CERT-2569-000001")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-11111111111g")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

describe("certIssueReducer", () => {
  it("idle → confirming → submitting → success พร้อม certNo", () => {
    let state = certIssueReducer(
      { phase: "idle", message: null, issuedCertNo: null },
      { type: "OPEN_CONFIRM" },
    );
    expect(state.phase).toBe("confirming");
    state = certIssueReducer(state, { type: "SUBMIT" });
    expect(state.phase).toBe("submitting");
    state = certIssueReducer(state, { type: "RESOLVE_SUCCESS", certNo: "CERT-2569-000001" });
    expect(state.phase).toBe("success");
    expect(state.issuedCertNo).toBe("CERT-2569-000001");
  });

  it("submitting → REJECT → error พร้อมข้อความ และ CLOSE กลับ idle เสมอ", () => {
    let state = certIssueReducer(
      { phase: "submitting", message: null, issuedCertNo: null },
      { type: "REJECT", message: "ล้มเหลว" },
    );
    expect(state.phase).toBe("error");
    expect(state.message).toBe("ล้มเหลว");
    state = certIssueReducer(state, { type: "CLOSE" });
    expect(state.phase).toBe("idle");
  });

  it("SUBMIT จาก idle ตรง ๆ ไม่ถูกต้อง → สถานะคงเดิม (transition ต้องเป็นลำดับ)", () => {
    const state = certIssueReducer(
      { phase: "idle", message: null, issuedCertNo: null },
      { type: "SUBMIT" },
    );
    expect(state.phase).toBe("idle");
  });
});

describe("certManageReducer", () => {
  it("REQUEST_REVOKE ตั้ง actionKind revoke — โมดัลเพิกถอนคือโมดัลเดียวที่เปิด", () => {
    let state = certManageReducer(CERT_MANAGE_DEFAULT, { type: "TYPE_CERT_ID", value: "x" });
    state = certManageReducer(state, { type: "TYPE_REASON", value: "เหตุผลเพิกถอนใบนี้" });
    state = certManageReducer(state, { type: "REQUEST_REVOKE" });
    expect(state.phase).toBe("revoking");
    expect(state.actionKind).toBe("revoke");
  });

  it("REQUEST_REISSUE ตั้ง actionKind reissue และล้างข้อความ/ผลลัพธ์เดิม", () => {
    const state = certManageReducer(CERT_MANAGE_DEFAULT, { type: "REQUEST_REISSUE" });
    expect(state.phase).toBe("reissuing");
    expect(state.actionKind).toBe("reissue");
  });

  it("TYPE_* แก้ input ได้เฉพาะตอน idle — กันแก้กลางคัน", () => {
    const busy = certManageReducer(CERT_MANAGE_DEFAULT, { type: "REQUEST_REVOKE" });
    const frozen = certManageReducer(busy, { type: "TYPE_CERT_ID", value: "เปลี่ยนไม่ได้" });
    expect(frozen.certIdInput).toBe("");
  });

  it("SUBMIT → submitting; RESOLVE_SUCCESS เก็บใบใหม่เฉพาะผล reissue", () => {
    const issued = parseIssuedCertificateView(makeIssued());
    expect(issued).not.toBeNull();
    if (issued === null) {
      return;
    }
    let state = certManageReducer(CERT_MANAGE_DEFAULT, { type: "REQUEST_REISSUE" });
    state = certManageReducer(state, { type: "SUBMIT" });
    expect(state.phase).toBe("submitting");
    state = certManageReducer(state, {
      type: "RESOLVE_SUCCESS",
      view: { newCertificate: issued, oldCertificateId: "x", oldStatus: "superseded", oldSupersededBy: "y" },
    });
    expect(state.phase).toBe("success");
    expect(state.issuedView?.certNo).toBe("CERT-2569-000001");
    state = certManageReducer(state, { type: "RESOLVE_SUCCESS", view: null });
    expect(state.phase).toBe("success");
    expect(state.issuedView).not.toBeNull();
  });

  it("REJECT ต้องมาจาก submitting เท่านั้น และ CLOSE รีเซ็ตทั้งแผง", () => {
    let state = certManageReducer(CERT_MANAGE_DEFAULT, { type: "REQUEST_REISSUE" });
    state = certManageReducer(state, { type: "SUBMIT" });
    state = certManageReducer(state, { type: "REJECT", message: "ล้มเหลว" });
    expect(state.phase).toBe("error");
    expect(state.message).toBe("ล้มเหลว");
    expect(state.actionKind).toBe("reissue");
    const reset = certManageReducer(state, { type: "CLOSE" });
    expect(reset).toEqual(CERT_MANAGE_DEFAULT);
  });
});

describe("issueTitleOf / issueConfirmLabelOf / manageTitleOf / manageConfirmLabelOf", () => {
  it("หัวข้อตาม phase และชนิดการดำเนินการ (ภาษาไทยทั้งหมด)", () => {
    expect(issueTitleOf("success")).toContain("สำเร็จ");
    expect(issueTitleOf("error")).toContain("ไม่สำเร็จ");
    expect(manageTitleOf("idle", "revoke")).toContain("ยืนยัน");
    expect(manageTitleOf("idle", "reissue")).toContain("ยืนยัน");
    expect(manageTitleOf("success", "revoke")).toContain("เพิกถอน");
    expect(manageTitleOf("success", "reissue")).toContain("ออกใบแทน");
  });

  it("ป้ายปุ่มยืนยัน: submitting บอกว่ากำลังทำงาน, error/success เป็นปุ่มปิด", () => {
    expect(issueConfirmLabelOf("submitting")).toContain("กำลัง");
    expect(manageConfirmLabelOf("submitting")).toContain("กำลัง");
    expect(issueConfirmLabelOf("error")).toBe("ปิด");
    expect(manageConfirmLabelOf("success")).toBe("ปิด");
  });
});
