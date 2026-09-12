/**
 * unit tests — reports/catalog (Wave E Phase 5 · lane F · ADM-004)
 * ทะเบียนรายงานครบ 3 ประเภท · path ตรง route จริง · บทบาทตาม matrix §2.4
 */
import { describe, expect, it } from "vitest";

import { REPORT_CARDS } from "./catalog";

describe("REPORT_CARDS", () => {
  it("ครบ 3 ประเภท ไม่ซ้ำ", () => {
    const types = REPORT_CARDS.map((card) => card.type);
    expect(types).toEqual(["enrollments", "assessments", "credits"]);
  });

  it("exportPath ชี้ /export?format=csv ของ type ตัวเอง", () => {
    for (const card of REPORT_CARDS) {
      expect(card.exportPath).toBe(
        `/api/v1/admin/reports/${card.type}/export?format=csv`,
      );
    }
  });

  it("ไทยก่อน + roles ไม่ว่าง", () => {
    for (const card of REPORT_CARDS) {
      expect(card.titleTh.length > 0).toBe(true);
      expect(card.descriptionTh.length > 0).toBe(true);
      expect(card.roles.length > 0).toBe(true);
    }
  });

  it("staff:exam เห็นเฉพาะรายงานผลสอบ (matrix §2.4 — D12-23)", () => {
    const viewerOfExam = REPORT_CARDS.filter((card) => card.roles.includes("staff:exam"));
    expect(viewerOfExam.map((card) => card.type)).toEqual(["assessments"]);
  });

  it("credit report สำหรับ registrar/super_admin", () => {
    const credits = REPORT_CARDS.find((card) => card.type === "credits");
    expect(credits?.roles).toEqual(["staff:registrar", "super_admin"]);
  });
});
