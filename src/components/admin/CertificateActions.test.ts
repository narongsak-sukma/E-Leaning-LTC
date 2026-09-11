/**
 * unit tests — CertificateActions logic (D-7)
 * ครอบ: parsers fail-closed ทั้ง 3 resource · certIssueReducer · certRowActionReducer
 * (Wave E PB-20 — ปุ่มเพิกถอน/ออกใบแทนต่อแถวทะเบียน · actionKind กำหนดโมดัลที่เปิด ·
 * สถานะ error/success คงอยู่จนกดปิด) · เกณฑ์เหตุผลเพิกถอน · uuid guard ·
 * หัวข้อ/ป้ายปุ่มยืนยันตาม phase
 */
import { describe, expect, it } from "vitest";

import { AdminApiError } from "@/lib/exam-admin.client";
import {
  certIssueReducer,
  certRowActionReducer,
  CERT_ROW_ACTION_DEFAULT,
  isUuid,
  issueConfirmLabelOf,
  issueTitleOf,
  manageConfirmLabelOf,
  manageTitleOf,
  modalCloseBlocked,
  parseIssuedCertificateView,
  parseRevokedCertificateView,
  parseReissuedCertificateView,
  REVOKE_REASON_MIN_LENGTH,
  revokeReasonValid,
  shouldRefreshAfterError,
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

describe("certRowActionReducer — ปุ่มเพิกถอน/ออกใบแทนต่อแถว (PB-20)", () => {
  it("REQUEST_REVOKE ตั้ง phase confirming + actionKind revoke และล้างเหตุผลเดิม", () => {
    const state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REVOKE" });
    expect(state.phase).toBe("confirming");
    expect(state.actionKind).toBe("revoke");
    expect(state.reason).toBe("");
    expect(state.message).toBeNull();
  });

  it("REQUEST_REISSUE ตั้ง actionKind reissue — ไม่มีช่องเหตุผล", () => {
    const state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REISSUE" });
    expect(state.phase).toBe("confirming");
    expect(state.actionKind).toBe("reissue");
  });

  it("REQUEST_* ตอนไม่ idle ไม่เปลี่ยนสถานะ (ปุ่ม disabled กันอยู่แล้ว แต่ reducer กันเองด้วย)", () => {
    const busy = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REVOKE" });
    const frozen = certRowActionReducer(busy, { type: "REQUEST_REISSUE" });
    expect(frozen.actionKind).toBe("revoke");
  });

  it("TYPE_REASON แก้ได้เฉพาะช่วง confirming ของ revoke — ช่วงส่งห้ามแก้กลางคัน", () => {
    let state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REVOKE" });
    state = certRowActionReducer(state, { type: "TYPE_REASON", value: "เหตุผลเบื้องต้น" });
    expect(state.reason).toBe("เหตุผลเบื้องต้น");
    state = certRowActionReducer(state, { type: "SUBMIT" });
    const frozen = certRowActionReducer(state, { type: "TYPE_REASON", value: "แอบแก้กลางคัน" });
    expect(frozen.reason).toBe("เหตุผลเบื้องต้น");
    const reissueConfirm = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REISSUE" });
    const untouched = certRowActionReducer(reissueConfirm, { type: "TYPE_REASON", value: "ไม่มีช่องนี้" });
    expect(untouched.reason).toBe("");
  });

  it("SUBMIT → submitting; RESOLVE_SUCCESS เก็บ certNo ผลลัพธ์", () => {
    let state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REISSUE" });
    state = certRowActionReducer(state, { type: "SUBMIT" });
    expect(state.phase).toBe("submitting");
    state = certRowActionReducer(state, { type: "RESOLVE_SUCCESS", certNo: "CERT-2569-000002" });
    expect(state.phase).toBe("success");
    expect(state.resultCertNo).toBe("CERT-2569-000002");
  });

  it("RESOLVE_SUCCESS ตอนไม่ submitting ไม่ถูกต้อง → สถานะคงเดิม", () => {
    const state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, {
      type: "RESOLVE_SUCCESS",
      certNo: "CERT-2569-000003",
    });
    expect(state.phase).toBe("idle");
    expect(state.resultCertNo).toBeNull();
  });

  it("REJECT ต้องมาจาก submitting เท่านั้น และ CLOSE รีเซ็ตเต็ม", () => {
    let state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REVOKE" });
    state = certRowActionReducer(state, { type: "TYPE_REASON", value: "เหตุผลเพิกถอนครบถ้วน" });
    state = certRowActionReducer(state, { type: "SUBMIT" });
    state = certRowActionReducer(state, { type: "REJECT", message: "ล้มเหลว" });
    expect(state.phase).toBe("error");
    expect(state.message).toBe("ล้มเหลว");
    expect(state.actionKind).toBe("revoke");
    const reset = certRowActionReducer(state, { type: "CLOSE" });
    expect(reset).toEqual(CERT_ROW_ACTION_DEFAULT);
  });

  it("CLOSE กลาง submitting ถูกกั้น — ผลล่าช้าต้องตกถึง success/error ก่อน (gate r2 MINOR)", () => {
    let state = certRowActionReducer(CERT_ROW_ACTION_DEFAULT, { type: "REQUEST_REVOKE" });
    state = certRowActionReducer(state, { type: "SUBMIT" });
    const frozen = certRowActionReducer(state, { type: "CLOSE" });
    expect(frozen.phase).toBe("submitting");
    // ผลสำเร็จมาทีหลังยังตกถึง success ได้ (โมดัลเปิดรอ พร้อมข้อความ + refresh ตอนปิด)
    const success = certRowActionReducer(frozen, { type: "RESOLVE_SUCCESS", certNo: "CERT-2569-000009" });
    expect(success.phase).toBe("success");
    expect(success.resultCertNo).toBe("CERT-2569-000009");
  });
});

describe("modalCloseBlocked — กั้นปิดทุกช่องทางกลาง submitting (gate r2 MINOR)", () => {
  it("submitting → true · ทุก phase อื่น → false", () => {
    expect(modalCloseBlocked("submitting")).toBe(true);
    expect(modalCloseBlocked("idle")).toBe(false);
    expect(modalCloseBlocked("confirming")).toBe(false);
    expect(modalCloseBlocked("success")).toBe(false);
    expect(modalCloseBlocked("error")).toBe(false);
  });
});

describe("shouldRefreshAfterError — รีเฟรชตอนปิดโมดัล (MINOR-6)", () => {
  it("409/404 → true — สถานะแถวเปลี่ยนที่เซิร์ฟเวอร์ ข้อความสัญญาว่าจะรีเฟรช", () => {
    expect(shouldRefreshAfterError(new AdminApiError("ERR-CONFLICT", 409, "สถานะเปลี่ยน"))).toBe(true);
    expect(shouldRefreshAfterError(new AdminApiError("ERR-NF-001", 404, "ไม่พบ"))).toBe(true);
  });

  it("403/400/error ทั่วไป/null → false — ไม่สัญญารีเฟรช ไม่ชน rate โดยไม่จำเป็น", () => {
    expect(shouldRefreshAfterError(new AdminApiError("ERR-RBAC-001", 403, "ไม่มีสิทธิ์"))).toBe(false);
    expect(shouldRefreshAfterError(new AdminApiError("ERR-VAL-001", 400, "ผิดรูป", ["reason"]))).toBe(false);
    expect(shouldRefreshAfterError(new Error("network"))).toBe(false);
    expect(shouldRefreshAfterError(null)).toBe(false);
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
    expect(manageConfirmLabelOf("submitting", "revoke")).toContain("กำลัง");
    expect(manageConfirmLabelOf("submitting", "reissue")).toContain("กำลัง");
    expect(issueConfirmLabelOf("error")).toBe("ปิด");
    expect(manageConfirmLabelOf("success", "revoke")).toBe("ปิด");
    expect(manageConfirmLabelOf("success", "reissue")).toBe("ปิด");
  });
});
