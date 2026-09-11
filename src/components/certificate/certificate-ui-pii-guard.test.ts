/**
 * certificate-ui-pii-guard.test — ห้ามมี PII/holder ใน UI ตรวจสอบสาธารณะ + รายการของตัวเอง
 * (Wave D-6 · D8-12 "ห้ามแสดงชื่อเจ้าของ" · แบบเดียวกับ learning.client-bundle-guard)
 *
 * สแกนเฉพาะไฟล์ที่ lane D-6 เป็นเจ้าของ (สร้างใหม่ทั้งหมด) — ตัดคอมเมนต์ออกก่อนเช็ค
 * เพราะคอมเมนต์อธิบายว่า "ห้าม holder_name" ซึ่งต้องยอมให้พิมพ์ใน comment ได้
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** ไฟล์ที่ lane D-6 สร้าง (client หรือ server UI) — ทั้งหมดห้ามมี PII token ในโค้ด */
const D6_FILES = [
  "src/components/certificate/verify-panel.tsx",
  "src/components/certificate/my-certificates-view.tsx",
  "src/lib/fixtures/certificates.ts",
  "src/lib/fixtures/certificates.server.ts",
  "src/app/(public)/verify/page.tsx",
  "src/app/(public)/verify/[code]/page.tsx",
  "src/app/(learner)/my/certificates/page.tsx",
];

const BANNED = [
  /holder_name/i,
  /holderName/i,
  /display_name/i,
  /revoked_at/i,
  /supersedes_cert_id/i,
  /holder_name_snapshot/i,
] as const;

/** ตัด /* ... *\/ และ // ... ออกก่อนสแกน (โค้ดเท่านั้น) */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("PII guard — UI ประกาศนียบัตร (D-6)", () => {
  it("ไฟล์ทั้งเจ็ดอยู่ในการสแกนเสมอ (กันลืม)", () => {
    expect(D6_FILES).toHaveLength(7);
  });

  it("ไม่มี PII token ในโค้ดของไฟล์ D-6 ทั้งหมด", () => {
    const violations: string[] = [];
    for (const rel of D6_FILES) {
      const content = stripComments(readFileSync(`${ROOT}/${rel}`, "utf8"));
      for (const pattern of BANNED) {
        if (pattern.test(content)) {
          violations.push(`${rel} :: ${pattern.source}`);
        }
      }
  }
    expect(violations).toEqual([]);
  });
});