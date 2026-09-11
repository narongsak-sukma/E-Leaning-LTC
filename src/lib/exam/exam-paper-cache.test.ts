/**
 * exam-paper-cache.test — แคชในหน่วยความจำพาชุดข้อจากหน้ากติกาไปห้องสอบ (ธง D37-6)
 *
 * - เก็บ/อ่านตาม attemptId · ทับของเดิมได้ · ลบแล้วอ่านไม่พบ
 * - ห้ามมี persistence ใด ๆ: guard ห้าม localStorage/sessionStorage/IndexedDB ในโมดูล
 */
import { describe, expect, it } from "vitest";

import type { ExamPaperSession } from "./exam-api";
import {
  clearAllExamPapers,
  clearExamPaper,
  readExamPaper,
  storeExamPaper,
} from "./exam-paper-cache";

const A1 = "10000000-0000-4000-8000-000000000001";
const A2 = "10000000-0000-4000-8000-000000000002";
const OPT = "20000000-0000-4000-8000-00000000000a";

function sessionOf(attemptId: string): ExamPaperSession {
  return {
    attemptId,
    status: "in_progress",
    deadlineAt: "2026-09-10T09:00:00+07:00",
    serverTime: "2026-09-10T08:00:00+07:00",
    questionCount: 1,
    questions: [
      {
        questionId: "30000000-0000-4000-8000-000000000001",
        seq: 1,
        selectedOptionIds: null,
        answeredAt: null,
        content: {
          version: 1,
          text: "โจทย์",
          options: [{ id: OPT, text: "ตัวเลือก" }],
          type: "multiple_choice",
        },
      },
    ],
  };
}

describe("exam-paper-cache", () => {
  it("เก็บแล้วอ่านได้ด้วย attemptId เดียวกัน", () => {
    clearAllExamPapers();
    const entry = { session: sessionOf(A1), serverOffsetMs: 1_000 };
    storeExamPaper(entry);
    expect(readExamPaper(A1)).toEqual(entry);
  });

  it("attemptId ต่างกัน = ไม่เห็นกันคนละรายการ", () => {
    clearAllExamPapers();
    storeExamPaper({ session: sessionOf(A1), serverOffsetMs: 0 });
    expect(readExamPaper(A2)).toBeNull();
  });

  it("เก็บซ้ำ = ทับรายการเดิม", () => {
    clearAllExamPapers();
    const updated = { session: sessionOf(A1), serverOffsetMs: 7_777 };
    storeExamPaper({ session: sessionOf(A1), serverOffsetMs: 0 });
    storeExamPaper(updated);
    expect(readExamPaper(A1)?.serverOffsetMs).toBe(7_777);
  });

  it("ลบรายการเดียวหรือล้างทั้งหมดแล้วอ่านไม่พบ (fail-closed)", () => {
    clearAllExamPapers();
    storeExamPaper({ session: sessionOf(A1), serverOffsetMs: 0 });
    storeExamPaper({ session: sessionOf(A2), serverOffsetMs: 0 });
    clearExamPaper(A1);
    expect(readExamPaper(A1)).toBeNull();
    expect(readExamPaper(A2)).not.toBeNull();
    clearAllExamPapers();
    expect(readExamPaper(A2)).toBeNull();
  });

  it("guard: โมดูลห้ามอ้าง localStorage/sessionStorage/IndexedDB เด็ดขาด", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("./exam-paper-cache.ts", import.meta.url), "utf8");
    // ตัดคอมเมนต์ออกก่อนตรวจ - สิ่งที่ห้ามคือ "การใช้งาน" ไม่ใช่การกล่าวถึงในคอมเมนต์
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/indexedDB/i);
  });
});
