/**
 * E2E-05 — เรียนวิดีโอ + เอกสารจนจบโมดูล (TEST-PLAN E2E-05)
 *
 * พิสูจน์บนแอปจริง + DB จริง:
 * - ลงทะเบียนแล้วเปิดหน้าเรียนได้จริง (outline แสดงครบ 3 บทเรียน)
 * - เอกสาร: แหล่งเนื้อหายังไม่ถูก wire (paragraphs=[] ที่ page.tsx:134 → ปุ่ม "อ่านจบแล้ว"
 *   disabled อย่างถูกต้อง) — spec บันทึกสถานะจริงนี้ไว้ แล้วยืนยันการอ่านผ่าน
 *   browser-session API (ขอบเขตที่ได้รับ) จากนั้นตรวจผลจริงบน UI + DB
 * - วิดีโอ: VideoPlayer ยังรับ src=null (page.tsx:121) — <video> ไม่มีอยู่จริง จึงยิง
 *   heartbeat ผ่าน browser-session API ด้วย position ที่เพิ่มขึ้นตามเวลาจริง —
 *   RPC ผูก accum ≤ elapsed นับแต่แถวถูกสร้าง + 60s (anti-fabrication migration 0011)
 *   จึงต้องรอเวลาจริง ~7 นาที (600s × 80% = 480s) — documented long-wait ตามข้อยกเว้น
 */
import { expect, test } from "@playwright/test";

import { psqlScalar } from "./helpers/db";
import { loadCourseFacts, type CourseFacts } from "./helpers/seed";
import { enrollCourse, loginViaForm, postDocumentRead, postVideoPosition } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser } from "./helpers/users";

const COURSE_CODE = "LTC-101";
/** เกณฑ์จบวิดีโอ = 80% (VIDEO_COMPLETE_PCT ใน src/lib/config.ts) */
const VIDEO_COMPLETE_PCT = 80;
/** จังหวะ heartbeat 30s (config 15s — ใช้ 2× เพื่อลดจำนวน call) */
const HEARTBEAT_MS = 30_000;

test.describe("E2E-05 ความคืบหน้าการเรียน", () => {
  let course: CourseFacts | undefined;
  let userId = "";
  let userEmail = "";

  test.beforeAll(async () => {
    course = await loadCourseFacts(COURSE_CODE);
    const user = await createLearnerUser("e2e05");
    userId = user.id;
    userEmail = user.email;
  });

  test.afterAll(async () => {
    if (userId !== "") {
      await deleteLearnerUser(userId);
    }
  });

  test("เอกสาร: ยืนยันอ่านแล้ว progress เป็น 1 จาก 3 (DB completed)", async ({ page }) => {
    const lessons = course?.lessons ?? [];
    const doc = lessons.find((l) => l.type === "document");
    expect(doc, "seed: LTC-101 ต้องมีบทเรียน document").toBeDefined();
    await loginViaForm(page, userEmail);
    expect(await enrollCourse(page, course?.id ?? "")).toBe(201);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${doc?.id ?? ""}`);
    // สถานะจริงของ UI: เนื้อหาเอกสารยังไม่ถูก wire (gap) — ปุ่มยืนยันต้อง disabled
    await expect(page.getByText("เนื้อหาเอกสารของบทเรียนนี้ยังไม่เปิดใช้งาน")).toBeVisible();
    await expect(page.getByRole("button", { name: "อ่านจบแล้ว" })).toBeDisabled();
    const status = await postDocumentRead(page, doc?.id ?? "");
    expect(status).toBe(200);
    await page.goto("/my/courses");
    await expect(page.getByText("เรียนแล้ว 1 จาก 3 บทเรียน")).toBeVisible();
    const completed = await psqlScalar(`
      select count(*) from public.lesson_progress lp
      join public.enrollments e on e.id = lp.enrollment_id
      where e.user_id = '${userId}' and lp.lesson_id = '${doc?.id ?? ""}'
        and lp.status = 'completed';
    `);
    expect(Number(completed)).toBe(1);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${doc?.id ?? ""}`);
    await expect(page.getByText("เรียนจบแล้ว")).toHaveCount(1);
  });

  test("วิดีโอ: heartbeat จน watch_pct ≥ 80 → progress 2 จาก 3 (long-wait ~7 นาที)", async ({
    page,
  }) => {
    test.setTimeout(540_000);
    const lessons = course?.lessons ?? [];
    const video = lessons.find((l) => l.type === "video");
    expect(video, "seed: LTC-101 ต้องมีบทเรียน video").toBeDefined();
    const target = Math.ceil(((video?.durationSec ?? 600) * VIDEO_COMPLETE_PCT) / 100);
    await loginViaForm(page, userEmail);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${video?.id ?? ""}`);
    await expect(page.getByRole("heading", { name: "บทที่ 1 แนะนำหลักสูตร" })).toBeVisible();
    const first = await postVideoPosition(page, video?.id ?? "", 60);
    expect(first).toBe(200);
    let accum = 0;
    let position = 60;
    let waited = 0;
    while (accum < target && waited < 430_000) {
      await page.waitForTimeout(HEARTBEAT_MS);
      waited += HEARTBEAT_MS;
      position += 30;
      const status = await postVideoPosition(page, video?.id ?? "", position);
      expect(status).toBe(200);
      accum = Number(
        await psqlScalar(`
          select coalesce(max(watch_sec_accum), 0) from public.lesson_progress lp
          join public.enrollments e on e.id = lp.enrollment_id
          where e.user_id = '${userId}' and lp.lesson_id = '${video?.id ?? ""}';
        `),
      );
    }
    expect(accum).toBeGreaterThanOrEqual(target);
    await page.goto("/my/courses");
    await expect(page.getByText("เรียนแล้ว 2 จาก 3 บทเรียน")).toBeVisible();
    const pct = await psqlScalar(`
      select max(watch_pct) from public.lesson_progress lp
      join public.enrollments e on e.id = lp.enrollment_id
      where e.user_id = '${userId}' and lp.lesson_id = '${video?.id ?? ""}';
    `);
    expect(Number(pct)).toBeGreaterThanOrEqual(80);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${video?.id ?? ""}`);
    await expect(page.getByText("เรียนจบแล้ว")).toHaveCount(2);
  });
});
