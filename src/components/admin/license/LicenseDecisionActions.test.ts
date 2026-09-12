/**
 * unit tests — license/LicenseDecisionActions (Wave E Phase 5 · lane F)
 * pure helpers: reject reason >= 10 · body/path per endpoint · status badge views
 */
import { describe, expect, it } from "vitest";

import {
  buildDecisionBody,
  licenseApplicationPath,
  licenseStatusViewOf,
  REJECT_REASON_MIN_LENGTH,
  rejectReasonValid,
} from "./LicenseDecisionActions";

describe("rejectReasonValid", () => {
  it("trim >= 10 -> true, short/blank -> false", () => {
    expect(rejectReasonValid("เอกสารไม่ครบถ้วนตามที่กำหนด")).toBe(true);
    expect(rejectReasonValid("   เอกสารไม่ครบ   ")).toBe(true);
    expect(rejectReasonValid("สั้นเกิน")).toBe(false);
    expect(rejectReasonValid("          ")).toBe(false);
    expect(REJECT_REASON_MIN_LENGTH).toBe(10);
  });
});

describe("buildDecisionBody", () => {
  it("reject trims reason, approve has no reason key", () => {
    expect(buildDecisionBody("reject", "  เอกสารยืนยันตัวตนไม่ครบถ้วน  ")).toEqual({
      action: "reject",
      reason: "เอกสารยืนยันตัวตนไม่ครบถ้วน",
    });
    expect(buildDecisionBody("approve", "")).toEqual({ action: "approve" });
    expect(Object.keys(buildDecisionBody("approve", "x")).includes("reason")).toBe(false);
  });
});

describe("licenseApplicationPath", () => {
  it("encodes id", () => {
    expect(licenseApplicationPath("a 1")).toBe("/api/v1/admin/license-applications/a%201");
  });
});

describe("licenseStatusViewOf", () => {
  it("known label+tone, unknown neutral", () => {
    expect(licenseStatusViewOf("pending")).toEqual({ label: "รอตรวจ", tone: "neutral" });
    expect(licenseStatusViewOf("approved")).toEqual({ label: "อนุมัติแล้ว", tone: "success" });
    expect(licenseStatusViewOf("rejected")).toEqual({ label: "ปฏิเสธแล้ว", tone: "danger" });
    const unknown = licenseStatusViewOf("frozen");
    expect(unknown.tone).toBe("neutral");
  });
});
