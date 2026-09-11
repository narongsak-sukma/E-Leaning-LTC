/**
 * E2E-07 — ผู้เรียนใหม่ลงทะเบียน course 3 (LTC-103) → เรียน document จน completed ผ่าน UI
 * → เห็นการ์ดกติกาการสอบที่ /courses/{id}/exam/{SEED_EXAM_ID}
 *
 * - course 3 เป็น is_public=false → ผู้เรียนต้องมีบทบาท `lawyer` จึงเห็นหน้าหลักสูตร/ลงทะเบียน
 *   (RLS 0010: is_public or has_any_role(['lawyer']) — spec สร้างผู้เรียน + role ผ่าน psql)
 * - ข้อสอบ seed (SEED_EXAM_ID): require_course_complete=true, max_attempts 3, cooldown 1440
 *   นาที — ตามโจทย์ **ห้ามกด "เริ่มสอบ" จริง** บนข้อสอบนี้ (กดเมื่อเรียนครบ = ใช้สิทธิ์ 1 ครั้ง
 *   และหลังส่งติด cooldown 1440 นาที ทำให้ lane อื่นใช้ seed ต่อไม่ได้)
 * - กติกาบนหน้าจอต้องตรง DB จริง (spec อ่าน assessment_rules ของ seed ผ่าน psql เทียบ)
 */
import { expect, test } from "@playwright/test";

import {
  COURSE3_ID,
  COURSE3_LESSON_ID,
  SEED_EXAM_ID,
  completeDocumentViaUi,
  createLawyerLearner,
  deleteD9User,
  enrollViaUi,
  type D9User,
} from "./d9-helpers";
import { psqlRows } from "./helpers/db";
import { loginViaForm } from "./helpers/session";

/** แถวกติกาจาก DB (ground truth) */
interface RuleRow {
  readonly question_count: number;
  readonly time_limit_minutes: number;
  readonly pass_pct: number;
  readonly max_attempts: number;
  readonly attempt_cooldown_minutes: number;
  readonly require_course_complete: boolean;
}

test.describe("E2E-07 กติกาการสอบหลังเรียนครบ", () => {
  let user: D9User | undefined;

  test.beforeAll(async () => {
    const created = await createLawyerLearner("d9-rules");
    user = created;
  });

  test.afterAll(async () => {
    if (user !== undefined) {
      await deleteD9User(user.id);
    }
  });

  test("ก่อนเรียนครบ: กดเริ่มสอบถูกปฏิเสธ (ERR-LRN-002 — ไม่เสียสิทธิ์ ไม่สร้าง attempt)", async ({
    page,
  }) => {
    await loginViaForm(page, user?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    await page.goto(`/courses/${COURSE3_ID}/exam/${SEED_EXAM_ID}`);
    await expect(page.getByRole("heading", { name: "กติกาการสอบ" })).toBeVisible();
    // กดเริ่มสอบโดยยังไม่เรียนครบ → BFF ปฏิเสธ ERR-LRN-002 → UI บล็อกด้วยข้อความไทย
    // (getByRole("alert") ชนกับ route announcer ของ Next — กรองด้วยข้อความ)
    await page.getByRole("button", { name: "เริ่มสอบ" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "ยังไม่มีสิทธิ์เข้าสอบ" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("ต้องลงทะเบียนรายวิชาและเรียนให้ครบตามกติกาก่อนจึงจะเข้าสอบได้");
    // ไม่เสียสิทธิ์: DB ยังไม่มี attempt ของผู้เรียนบนข้อสอบนี้
    const attempts = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${SEED_EXAM_ID}';
    `);
    expect(attempts[0]?.n).toBe(0);
  });

  test("เรียน document จน completed ผ่าน UI → การ์ดกติกาของข้อสอบ seed ตรง DB", async ({ page }) => {
    await loginViaForm(page, user?.email ?? "");
    // ผู้เรียนคนเดียวกันลงทะเบียนไปแล้วใน test แรก (workers:1 · เรียง test แบบ serial) —
    // เมื่อลงทะเบียนแล้วหน้าหลักสูตรไม่มีปุ่ม "ลงทะเบียนเรียน" อีก จึงรองรับทั้งสองสถานะ:
    // ยังมีปุ่ม = กดลงทะเบียนตามปกติ · ไม่มีปุ่ม = ลงทะเบียนแล้ว ผ่านเงื่อนไขเรียบร้อย
    await page.goto(`/courses/${COURSE3_ID}`);
    const enrollButton = page.getByRole("button", { name: "ลงทะเบียนเรียน" });
    if (await enrollButton.isVisible().catch(() => false)) {
      await enrollButton.click();
      await page.waitForURL(`**/courses/${COURSE3_ID}/learn**`, { timeout: 20_000 });
    }
    // เรียนจบบทเรียน document เดียวของ course 3 ผ่าน UI จริง (กด "อ่านจบแล้ว")
    await completeDocumentViaUi(page, COURSE3_ID, COURSE3_LESSON_ID);
    // หน้ากติกา: heading = ชื่อข้อสอบ seed + การ์ด "กติกาการสอบ"
    await page.goto(`/courses/${COURSE3_ID}/exam/${SEED_EXAM_ID}`);
    await expect(page.getByRole("heading", { name: "กติกาการสอบ" })).toBeVisible();
    // เทียบทุกแถวกติกากับ DB จริง (ตัวเลขไม่โกหก)
    const rules = await psqlRows<RuleRow>(`
      select question_count, time_limit_minutes, pass_pct, max_attempts,
             attempt_cooldown_minutes, require_course_complete
        from public.assessment_rules
       where assessment_id = '${SEED_EXAM_ID}'
         and effective_from <= now()
       order by effective_from desc limit 1;
    `);
    expect(rules[0]).toBeDefined();
    const rule = rules[0] as RuleRow;
    await expect(page.getByText(`จำนวนข้อสอบ${rule.question_count} ข้อ`)).toBeVisible();
    await expect(page.getByText(`${rule.time_limit_minutes} นาที`)).toBeVisible();
    await expect(
      page.getByText(`คะแนนรวมไม่น้อยกว่า ${rule.pass_pct} เปอร์เซ็นต์`),
    ).toBeVisible();
    await expect(page.getByText(`${rule.max_attempts} ครั้ง`, { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        rule.attempt_cooldown_minutes === 0
          ? "ไม่มี"
          : `${rule.attempt_cooldown_minutes} นาที`,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(rule.require_course_complete ? "ต้องเรียนบทเรียนให้ครบก่อน" : "ไม่มีเงื่อนไขการเรียน"),
    ).toBeVisible();
    await expect(page.getByText("เปิดหลังใช้ครั้งการสอบครั้งสุดท้ายตามกติกา")).toBeVisible();
    // ยืนยันว่า "เริ่มสอบ" พร้อมกด (สิทธิ์เข้าสอบเปิดแล้ว) — แต่ **ไม่กด** ตามโจทย์
    await expect(page.getByRole("button", { name: "เริ่มสอบ" })).toBeEnabled();
    // (ใช้ไปแล้ว 0 จาก 3 ครั้ง) — ข้อความจริงบนหน้ายืนยันการเริ่มสอบ (จำนวนครั้งตาม DB)
    await expect(
      page.getByText(`(ใช้ไปแล้ว 0 จาก ${rule.max_attempts} ครั้ง)`),
    ).toBeVisible();
    // DB: ยังไม่มี attempt เกิดขึ้นจริง — ปฏิบัติตามโจทย์ "ห้ามกดเริ่มจริงบน seed exam"
    const attempts = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${SEED_EXAM_ID}';
    `);
    expect(attempts[0]?.n).toBe(0);
  });
});
