/**
 * unit tests — src/lib/schemas/license (Wave E Phase 5 · D-p5-2/3/4)
 *
 * จุดตรวจ: license_no `^\d{6,9}$` · ไฟล์ jpg/png/pdf ≤10MB (และไฟล์ว่าง) · body ตัดสิน
 * strict + reason ≤500 · view ขาออก strict ทุกชุด (key เกิน = fail)
 */
import { describe, expect, it } from "vitest";
import {
  AdminLicenseApplicationRow,
  EVIDENCE_MAX_BYTES,
  EvidenceFileSchema,
  LicenseApplicationStatus,
  LicenseDecisionBody,
  LicenseNoSchema,
  LicenseDecisionResult,
  MyLicenseStatusView,
  SubmittedLicenseApplication,
} from "./license";

/** File จำลอง — ตั้ง type/size ได้ตรง schema โดยไม่เขียน byte จริงทั้งก้อน */
function makeFile(options: {
  readonly type: string;
  readonly size: number;
  readonly name?: string;
}): File {
  const file = new File(["x".repeat(options.size)], options.name ?? "evidence.bin", {
    type: options.type,
  });
  Object.defineProperty(file, "size", { value: options.size });
  return file;
}

describe("LicenseNoSchema — ^\\d{6,9}$ (ตรงเงื่อนไข RPC 0035)", () => {
  it.each(["123456", "1234567", "123456789", " 123456 "])("ยอมรับ %j (trim ก่อน)", (value) => {
    expect(LicenseNoSchema.safeParse(value).success).toBe(true);
  });

  it.each(["12345", "1234567890", "12345a", "12-4567", "", "๑๒๓๔๕๖"])(
    "ปฏิเสธ %j",
    (value) => {
      expect(LicenseNoSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("EvidenceFileSchema — jpg/png/pdf ≤10MB", () => {
  it("ยอมรับ jpg/png/pdf ขนาดปกติ", () => {
    for (const type of ["image/jpeg", "image/png", "application/pdf"]) {
      expect(EvidenceFileSchema.safeParse(makeFile({ type, size: 1024 })).success).toBe(true);
    }
  });

  it("ปฏิเสธ mime อื่น (gif/webp/txt)", () => {
    for (const type of ["image/gif", "image/webp", "text/plain", ""]) {
      expect(EvidenceFileSchema.safeParse(makeFile({ type, size: 1024 })).success).toBe(false);
    }
  });

  it("ปฏิเสธไฟล์ว่าง (size 0)", () => {
    expect(EvidenceFileSchema.safeParse(makeFile({ type: "image/png", size: 0 })).success).toBe(false);
  });

  it(`ปฏิเสธเกิน 10MB (10MB+1 byte) — EVIDENCE_MAX_BYTES=${EVIDENCE_MAX_BYTES}`, () => {
    const file = makeFile({ type: "application/pdf", size: EVIDENCE_MAX_BYTES + 1 });
    expect(EvidenceFileSchema.safeParse(file).success).toBe(false);
  });

  it("ยอมรับพอดี 10MB", () => {
    expect(EvidenceFileSchema.safeParse(makeFile({ type: "application/pdf", size: EVIDENCE_MAX_BYTES })).success).toBe(true);
  });
});

describe("LicenseApplicationStatus — enum 0001", () => {
  it("ยอมเฉพาะ pending/approved/rejected", () => {
    expect(LicenseApplicationStatus.safeParse("pending").success).toBe(true);
    expect(LicenseApplicationStatus.safeParse("approved").success).toBe(true);
    expect(LicenseApplicationStatus.safeParse("rejected").success).toBe(true);
    expect(LicenseApplicationStatus.safeParse("processing").success).toBe(false);
  });
});

describe("LicenseDecisionBody — strict + reason ≤500", () => {
  it("ยอมรับ approve ไม่มี reason", () => {
    expect(LicenseDecisionBody.safeParse({ action: "approve" }).success).toBe(true);
  });

  it("ยอมรับ reject พร้อม reason", () => {
    expect(LicenseDecisionBody.safeParse({ action: "reject", reason: "x".repeat(500) }).success).toBe(true);
  });

  it("ปฏิเสธ key แปลกปลอม (strict)", () => {
    expect(LicenseDecisionBody.safeParse({ action: "approve", status: "x" }).success).toBe(false);
  });

  it("ปฏิเสธ action อื่น และ reason เกิน 500", () => {
    expect(LicenseDecisionBody.safeParse({ action: "delete" }).success).toBe(false);
    expect(LicenseDecisionBody.safeParse({ action: "approve", reason: "x".repeat(501) }).success).toBe(false);
  });
});

describe("views ขาออก — strict ทุกชุด", () => {
  const T = "2026-09-01T00:00:00+00:00";
  const APP_ID = "b0000000-0000-4000-8000-000000000001";
  const LIC_ID = "d0000000-0000-4000-8000-000000000001";

  it("SubmittedLicenseApplication ตรวจแถวยื่นสำเร็จ", () => {
    const ok = SubmittedLicenseApplication.safeParse({
      applicationId: APP_ID,
      status: "pending",
      submittedAt: T,
    });
    expect(ok.success).toBe(true);
  });

  it("LicenseDecisionResult — approve ครบ + reject (ใบ/role null)", () => {
    expect(
      LicenseDecisionResult.safeParse({
        applicationId: APP_ID,
        result: "approved",
        resultingLicenseId: LIC_ID,
        roleGranted: true,
      }).success,
    ).toBe(true);
    expect(
      LicenseDecisionResult.safeParse({
        applicationId: APP_ID,
        result: "rejected",
        resultingLicenseId: null,
        roleGranted: null,
      }).success,
    ).toBe(true);
  });

  it("MyLicenseStatusView — ครบทุกเคส (มี/ไม่มีคำขอ ใบ) + ปฏิเสธ key เกิน", () => {
    expect(
      MyLicenseStatusView.safeParse({
        latestApplication: {
          status: "rejected",
          rejectedReason: "ภาพไม่ชัด",
          decidedAt: T,
          submittedAt: T,
        },
        currentLicense: { licenseNo: "1234567", verifiedAt: T },
        canResubmit: true,
      }).success,
    ).toBe(true);
    expect(
      MyLicenseStatusView.safeParse({
        latestApplication: null,
        currentLicense: null,
        canResubmit: true,
      }).success,
    ).toBe(true);
    expect(
      MyLicenseStatusView.safeParse({
        latestApplication: { status: "pending", rejectedReason: null, decidedAt: null, submittedAt: T },
        currentLicense: null,
        canResubmit: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("AdminLicenseApplicationRow — ตรงสัญญา lane F + ปฏิเสธ key เกิน", () => {
    const row = {
      id: APP_ID,
      displayName: "สมศรี ใจดี",
      email: "somsri@example.com",
      licenseNo: "1234567",
      status: "pending",
      submittedAt: T,
      decidedAt: null,
      reason: null,
      evidenceUrl: null,
    };
    expect(AdminLicenseApplicationRow.safeParse(row).success).toBe(true);
    expect(AdminLicenseApplicationRow.safeParse({ ...row, userId: "x" }).success).toBe(false);
  });
});
