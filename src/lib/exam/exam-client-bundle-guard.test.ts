/**
 * exam-client-bundle-guard.test — ประตูกันเฉลยรั่วเข้า client bundle (ธง lead ข้อ 3)
 *
 * - ไฟล์ที่ถูกแนบไปกับ client bundle (client component + โมดูล lib ที่ client import)
 *   ห้ามมีชื่อฟิลด์เฉลย/คะแนนแม้แต่ตัวเดียว: is_correct / isCorrect / correctChoiceIds /
 *   explanation / pointsEarned / points
 * - exam-api (client-safe) ห้าม import schemas/v1/exam (โมดูล schema กลางมีชื่อคอลัมน์
 *   ฝั่งเฉลย/คะแนน — import = ชื่อเหล่านั้นเข้า bundle) · exam.server ต้องติด server-only
 * - หน้าทั้งสี่ของเส้นการสอบเป็น RSC (ไม่มี "use client") — หน้าผลสอบแสดงเฉลยตาม BFF
 *   ได้เพราะเรนเดอร์ฝั่ง server เท่านั้น (ธง lead ข้อ 4)
 * - ธง D37-6: หน้ากติกาเตือนเรื่องห้ามรีเฟรช (ข) · ห้องสอบ fail-closed เมื่อไม่พบชุดข้อ (ค)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** ไฟล์ที่ถูกแนบไปกับ client bundle (client component / โมดูลที่ client import) */
const CLIENT_FILES: readonly string[] = [
  "src/lib/exam/exam-api.ts",
  "src/lib/exam/exam-answers.ts",
  "src/lib/exam/exam-timer.ts",
  "src/lib/exam/exam-paper-cache.ts",
  "src/components/learner/exam/exam-rules-start.tsx",
  "src/components/learner/exam/exam-room.tsx",
];

/** หน้า RSC ของเส้นการสอบ — เรนเดอร์ฝั่ง server (เฉลยในหน้าผลสอบไม่มีทางถึง bundle) */
const RSC_PAGES: readonly string[] = [
  "src/app/(learner)/courses/[id]/exam/[assessmentId]/page.tsx",
  "src/app/(learner)/courses/[id]/exam/[assessmentId]/[attemptId]/page.tsx",
  "src/app/(learner)/my/exams/page.tsx",
  "src/app/(learner)/my/exams/[attemptId]/page.tsx",
];

/** ชื่อฟิลด์เฉลย/คะแนนที่ห้ามปรากฏใน client bundle */
const BANNED_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["is_correct", /\bis_correct\b/],
  ["isCorrect", /\bisCorrect\b/],
  ["correctChoiceIds", /\bcorrectChoiceIds?\b/],
  ["explanation", /\bexplanation\b/],
  ["pointsEarned", /\bpointsEarned\b/],
  ["points", /\bpoints\b/],
];

function readRepo(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("client bundle guard (ธง lead ข้อ 3 — เฉลยห้ามถึง client)", () => {
  it("ไฟล์ client ทุกไฟล์ไม่มีชื่อฟิลด์เฉลย/คะแนนแม้แต่ตัวเดียว", () => {
    const violations: string[] = [];
    for (const relPath of CLIENT_FILES) {
      const source = readRepo(relPath);
      for (const [name, pattern] of BANNED_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${relPath}: ${name}`);
        }
        expect(violations).toEqual([]);
      }
    }
  });

  it("exam-api (client-safe) ไม่อ้าง schema กลางของเส้นการสอบทุกทาง", () => {
    const source = readRepo("src/lib/exam/exam-api.ts");
    expect(source.includes('from "@/lib/schemas')).toBe(false);
  });

  it("exam.server ติด server-only (ห้ามเข้า client bundle)", () => {
    expect(readRepo("src/lib/exam/exam.server.ts")).toContain('import "server-only";');
  });

  it("หน้าทั้งสี่เป็น RSC (ไม่มี directive 'use client') — เฉลยหน้าผลสอบอยู่ฝั่ง server", () => {
    const violations: string[] = [];
    for (const relPath of RSC_PAGES) {
      if (readRepo(relPath).includes('"use client"')) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  it("ธง D37-6 (ข): หน้ากติกาเตือนห้ามรีเฟรช/ปิดหน้าก่อนเริ่มสอบ", () => {
    expect(readRepo("src/components/learner/exam/exam-rules-start.tsx")).toContain("ห้ามรีเฟรช");
  });

  it("ธง D37-6 (ค): ห้องสอบ fail-closed เมื่อไม่พบชุดข้อ (reload) — ไม่พยายามเปิดเอง", () => {
    const source = readRepo("src/components/learner/exam/exam-room.tsx");
    expect(source).toContain("beforeunload");
    expect(source).toContain("readExamPaper(attemptId)");
    expect(source).toContain('"no_paper"');
  });
});
