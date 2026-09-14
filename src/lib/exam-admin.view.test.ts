/**
 * unit tests — exam-admin.view (D-7)
 * ครอบ: ตรวจ enum guard · label/tone ครบทุกสถานะ · สิทธิ์แสดงผลต่อบทบาท ·
 * ผู้ช่วยจัดรูปของตาราง (กติกา/ประเภท/วันเวลา) · firstSearchParam ·
 * validationFieldLabels แปล path เป็นภาษาไทย (กฎข้อ 3 ของ lane)
 */
import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_STATUS_LABEL_TH,
  ASSESSMENT_STATUS_TONE,
  assessmentKindLabel,
  assessmentRulesSummaryLine,
  canCreateAssessment,
  canCreateQuestionBank,
  canIssueCertificate,
  canRevokeCertificate,
  canWriteAssessmentRules,
  firstSearchParam,
  formatThaiDateTime,
  isExamAdminAssessmentStatus,
  validationFieldLabels,
  type ExamAdminAssessmentRuleSummary,
} from "./exam-admin.view";

/** กติกาจำลองสำหรับ test (ข้อมูลจำลองอยู่ใน .test.ts เท่านั้น) */
function makeRuleSummary(overrides: Partial<ExamAdminAssessmentRuleSummary> = {}): ExamAdminAssessmentRuleSummary {
  return {
    version: 1,
    passPct: 70,
    timeLimitMinutes: 60,
    questionCount: 30,
    maxAttempts: 3,
    cooldownMinutes: 1440,
    shuffleQuestions: true,
    shuffleOptions: true,
    requireCourseComplete: true,
    selection: {},
    proctoringMode: "basic",
    examReviewMode: "after_final_attempt",
    effectiveFrom: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("enum guard", () => {
  it("รับเฉพาะสถานะใน enum assessment_status", () => {
    expect(isExamAdminAssessmentStatus("draft")).toBe(true);
    expect(isExamAdminAssessmentStatus("published")).toBe(true);
    expect(isExamAdminAssessmentStatus("closed")).toBe(true);
    expect(isExamAdminAssessmentStatus("archived")).toBe(true);
  });

  it("ปฏิเสธค่าแปลกปลอม (ค่าว่าง/ตัวพิมพ์ใหญ่/ค่าอื่น)", () => {
    expect(isExamAdminAssessmentStatus("")).toBe(false);
    expect(isExamAdminAssessmentStatus("DRAFT")).toBe(false);
    expect(isExamAdminAssessmentStatus("published ")).toBe(false);
    expect(isExamAdminAssessmentStatus("pending")).toBe(false);
    expect(isExamAdminAssessmentStatus(null)).toBe(false);
    expect(isExamAdminAssessmentStatus(undefined)).toBe(false);
  });
});

describe("label/tone ครบทุกสถานะ", () => {
  it("มี label และ tone ครบทั้ง 4 สถานะ และไม่ว่าง", () => {
    const statuses = ["draft", "published", "closed", "archived"] as const;
    for (const status of statuses) {
      expect(ASSESSMENT_STATUS_LABEL_TH[status].length).toBeGreaterThan(0);
      expect(ASSESSMENT_STATUS_TONE[status]).toBeDefined();
    }
  });
});

describe("สิทธิ์แสดงผลต่อบทบาท (mirror RBAC §2)", () => {
  it("instructor สร้างชุดข้อสอบ/คลังข้อสอบได้ แต่แนบกติกาไม่ได้", () => {
    expect(canCreateAssessment(["instructor"])).toBe(true);
    expect(canCreateQuestionBank(["instructor"])).toBe(true);
    expect(canWriteAssessmentRules(["instructor"])).toBe(false);
  });

  it("staff:exam ทำได้ทั้งหมดในขอบเขตข้อสอบ", () => {
    expect(canCreateAssessment(["staff:exam"])).toBe(true);
    expect(canWriteAssessmentRules(["staff:exam"])).toBe(true);
    expect(canCreateQuestionBank(["staff:exam"])).toBe(true);
  });

  it("staff:registrar เท่านั้นที่ออก/เพิกถอนใบได้ (SoD T9)", () => {
    expect(canIssueCertificate(["staff:registrar"])).toBe(true);
    expect(canRevokeCertificate(["staff:registrar"])).toBe(true);
    expect(canIssueCertificate(["staff:exam", "instructor"])).toBe(false);
    expect(canIssueCertificate([])).toBe(false);
  });

  it("super_admin ทำได้ทุกอย่าง", () => {
    expect(canCreateAssessment(["super_admin"])).toBe(true);
    expect(canWriteAssessmentRules(["super_admin"])).toBe(true);
    expect(canIssueCertificate(["super_admin"])).toBe(true);
    expect(canRevokeCertificate(["super_admin"])).toBe(true);
  });
});

describe("assessmentRulesSummaryLine", () => {
  it("ไม่มีกติกา → ข้อความแจ้งชัด (ไม่ใช่ขีดล่างเปล่า ๆ)", () => {
    expect(assessmentRulesSummaryLine(null)).toBe("ยังไม่กำหนดกติกา");
  });

  it("มีกติกา → สรุปครบเกณฑ์ผ่าน/จำนวนข้อ/เวลา/จำนวนครั้ง", () => {
    const line = assessmentRulesSummaryLine(makeRuleSummary());
    expect(line).toContain("70%");
    expect(line).toContain("30 ข้อ");
    expect(line).toContain("60 นาที");
    expect(line).toContain("3 ครั้ง");
  });
});

describe("assessmentKindLabel", () => {
  it("แยกปลายหลักสูตร/ระหว่างเรียน", () => {
    expect(assessmentKindLabel(true)).toContain("ปลาย");
    expect(assessmentKindLabel(false)).toContain("ระหว่างเรียน");
  });
});

describe("formatThaiDateTime", () => {
  it("แสดงปีพุทธศักราช (I18N-003)", () => {
    expect(formatThaiDateTime("2026-08-20T13:45:00Z")).toContain("2569");
  });
});

describe("firstSearchParam", () => {
  it("ตัดค่าแรกจาก multi-value และส่ง undefined ต่อค่าว่าง", () => {
    expect(firstSearchParam(undefined)).toBeUndefined();
    expect(firstSearchParam("draft")).toBe("draft");
    expect(firstSearchParam(["published", "draft"])).toBe("published");
  });
});

describe("validationFieldLabels", () => {
  it("แปล field path ที่รู้จักเป็นภาษาไทย", () => {
    expect(validationFieldLabels(["courseId", "rules.passPct"])).toEqual([
      "หลักสูตร",
      "เกณฑ์ผ่าน (%)",
    ]);
  });

  it("ไม่รู้จัก path ใด → ส่ง path เดิมกลับ (ไม่เดาความ)", () => {
    expect(validationFieldLabels(["questions.0.options.2.optionText"])).toEqual([
      "questions.0.options.2.optionText",
    ]);
  });
});
