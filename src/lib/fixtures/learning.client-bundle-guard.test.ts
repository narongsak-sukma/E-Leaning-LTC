/**
 * learning.client-bundle-guard.test — พิสูจน์ว่าเฉลยแบบทดสอบไม่อยู่ใน client path (D28/DCR-5)
 *
 * - ไล่อ่านไฟล์ .ts/.tsx ทั้งหมดใน src/components/learner + src/app/(learner) และ
 *   src/lib/fixtures/learning.ts (+ learning.server.ts) — ไฟล์ที่ Next.js แพ็กเข้า browser bundle ได้
 * - ห้ามพบ token ของเฉลย: correctChoiceIds / is_correct / fixtureSubmitQuiz / QUIZ_BANK
 *   (ยกเว้นไฟล์ .test.ts ซึ่งถูกยกเว้นจากการสแกน)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** ไล่ไดเรกทอรีแบบ recursive — เฉพาะ .ts/.tsx ที่ไม่ใช่ .test.ts */
function listClientFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listClientFiles(full);
    }
    const isSource = entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts");
    return isSource ? [full] : [];
  });
}

const BANNED_PATTERNS = [
  /correctChoiceIds/i,
  /is_correct/i,
  /fixtureSubmitQuiz/i,
  /QUIZ_BANK/,
] as const;

describe("client bundle guard — เฉลยออกจาก client bundle (D28/DCR-5)", () => {
  it("ไม่มี token ของเฉลยในไฟล์ client ทั้งหมด", () => {
    const files = [
      ...listClientFiles(join(ROOT, "src/components/learner")),
      ...listClientFiles(join(ROOT, "src/app/(learner)")),
      join(ROOT, "src/lib/fixtures/learning.ts"),
      join(ROOT, "src/lib/fixtures/learning.server.ts"),
    ];
    expect(files.length).toBeGreaterThan(5);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file} :: ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("learning.ts ถูกรวมในการสแกนเสมอ (กันลืมเพิ่มไฟล์ใหม่)", () => {
    const files = [
      ...listClientFiles(join(ROOT, "src/components/learner")),
      ...listClientFiles(join(ROOT, "src/app/(learner)")),
    ];
    expect(files).toContain(join(ROOT, "src/components/learner/quiz-panel.tsx"));
    expect(files).toContain(join(ROOT, "src/app/(learner)/my/courses/page.tsx"));
  });
});
