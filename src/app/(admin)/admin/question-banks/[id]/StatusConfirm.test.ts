/**
 * unit tests — StatusConfirm (Wave G P2 · lane W2)
 * ครอบ: hint D77 + ปุ่ม from→to + endpoint/body ของ PATCH status — ท่าที่คอมโพเนนต์
 * เรียก patchAdminJson จริง (logic อยู่ที่ bank-detail.view · node env ไม่มี jsdom
 * คอมโพเนนต์รับ canToggle บูลีนจากผู้ช่วยบทบาทที่เทส role matrix แล้ว)
 */
import { describe, expect, it } from "vitest";

import {
  bankQuestionStatusEndpointOf,
  questionStatusBody,
  statusActionLabelTh,
  statusConfirmDescriptionTh,
  statusTargetOf,
} from "./bank-detail.view";

/** คู่ endpoint/body ที่ handleConfirm เรียก patchAdminJson — จำลองจากสถานะปัจจุบัน */
function confirmCallOf(status: "draft" | "active" | "retired"): {
  readonly endpoint: string;
  readonly body: { readonly status: string };
} {
  const target = statusTargetOf(status);
  return {
    endpoint: bankQuestionStatusEndpointOf("B1", "Q9"),
    body: questionStatusBody(target),
  };
}

describe("StatusConfirm — endpoint ที่เรียกจริง (D75)", () => {
  it("ปลดจาก active → PATCH .../Q9/status body คีย์เดียว status:retired", () => {
    const call = confirmCallOf("active");
    expect(call.endpoint).toBe("/api/v1/admin/question-banks/B1/questions/Q9/status");
    expect(call.body).toEqual({ status: "retired" });
    expect(Object.keys(call.body).length).toBe(1);
  });

  it("เปิดจาก retired → body status:active (คีย์เดียว)", () => {
    const call = confirmCallOf("retired");
    expect(call.endpoint).toBe("/api/v1/admin/question-banks/B1/questions/Q9/status");
    expect(call.body).toEqual({ status: "active" });
  });

  it("เปิดจาก draft → body status:active (คีย์เดียว)", () => {
    expect(confirmCallOf("draft").body).toEqual({ status: "active" });
  });
});

describe("StatusConfirm — ปุ่ม + ข้อความยืนยัน (D77)", () => {
  it("ป้ายปุ่ม toggle ไทยตามสถานะปัจจุบัน", () => {
    expect(statusActionLabelTh("active")).toBe("ปลดจากการใช้งาน");
    expect(statusActionLabelTh("draft")).toBe("เปิดใช้งาน");
  });

  it("ข้อความยืนยันจาก active: from→to + hint ปลดครบถ้วน", () => {
    const message = statusConfirmDescriptionTh("active");
    expect(message).toContain('จาก "ใช้งาน"');
    expect(message).toContain('เป็น "ปลดจากการใช้งาน"');
    expect(message).toContain("ข้อที่ปลดจะไม่ถูกสุ่มให้การสอบที่เริ่มใหม่");
  });

  it("ข้อความยืนยันจาก retired: hint เข้า pool ทันที + การสอบที่กำลังทำไม่เปลี่ยน", () => {
    const message = statusConfirmDescriptionTh("retired");
    expect(message).toContain("การสอบที่กำลังทำอยู่ไม่เปลี่ยน");
    expect(message).toContain('เป็น "ใช้งาน"');
  });
});
