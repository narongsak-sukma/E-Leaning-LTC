/**
 * E2E-05 — เรียนวิดีโอ + เอกสารจนจบโมดูล (TEST-PLAN E2E-05) — UI-driven (lane D-9)
 *
 * - ลงทะเบียนแล้วเปิดหน้าเรียนได้จริง (outline แสดงครบ 3 บทเรียน)
 * - เอกสาร: เนื้อหาถูก wire แล้ว (page.tsx:134 ส่ง paragraphs จริง — D-0) จึงกด
 *   ปุ่ม "อ่านจบแล้ว" ผ่าน UI จริง (DocumentViewer attestation → BFF documentRead)
 *   — ไม่ใช้ postDocumentRead API ทางตรงแล้ว (ตามโจทย์ lane D-9)
 * - วิดีโอ: **ลองเล่นผ่าน UI จริงก่อน** (probe <video> บนหน้าจอ: duration/error/currentTime
 *   หลัง play) — ถ้า Chromium decode ได้ จะเล่นจน watch_pct ≥ 80 ผ่าน UI ทั้งหมด
 *   · ธง (เหตุผลที่ยังต้องมี fallback): media seed `courses/ltc-101/intro.mp4` เป็นไฟล์
 *     stub 32 ไบต์ (ftyp+free เท่านั้น ไม่มี moov/duration) — Chromium อ่าน metadata ไม่ได้
 *     → currentTime คงที่ 0 → VideoPlayer heartbeat (position = element.currentTime,
 *     ข้ามเมื่อ ≤ 0 — src/components/learner/video-player.tsx:46) ไม่มีวันยิง → ความคืบหน้า
 *     ผ่าน UI ทำไม่ได้จริง จึงคง heartbeat ทาง browser-session API ด้วย position ที่เพิ่ม
 *     ตามเวลาจริง (RPC ผูก accum ≤ elapsed + 60s — anti-fabrication 0011) — ทดสอบ probe
 *     ทุกรอบ ถ้าไฟล์จริงถูกอัปโหลด (PB-14) สาขา UI จะทำงานเองโดยไม่ต้องแก้ spec
 *   · long-wait ~7 นาที (600s × 80% = 480s) — documented ตามข้อยกเว้น
 */
import { expect, test, type Page } from "@playwright/test";

import { psqlScalar } from "./helpers/db";
import { loadCourseFacts, type CourseFacts } from "./helpers/seed";
import {
  enrollCourse,
  loginViaForm,
  postVideoPosition,
} from "./helpers/session";
import { createLearnerUser, deleteLearnerUser } from "./helpers/users";

const COURSE_CODE = "LTC-101";
/** เกณฑ์จบวิดีโอ = 80% (VIDEO_COMPLETE_PCT ใน src/lib/config.ts) */
const VIDEO_COMPLETE_PCT = 80;
/** จังหวะ heartbeat ทาง API 30s (config 15s — ใช้ 2× เพื่อลดจำนวน call) */
const HEARTBEAT_MS = 30_000;
/** เวลาที่ให้ <video> พยายาม decode ก่อนตัดสินว่าเล่นผ่าน UI ไม่ได้ */
const PLAYBACK_PROBE_MS = 8_000;

/** ผล probe การเล่นผ่าน UI (บันทึกลง report ทุกรอบ — โปร่งใสว่าใช้สาขาไหน) */
interface PlaybackProbe {
  readonly videoOnPage: boolean;
  readonly durationFinite: boolean;
  readonly duration: number;
  readonly errorCode: number;
  readonly currentTimeAfterPlay: number;
  readonly uiPlayable: boolean;
}

/** probe จริงบนหน้า: muted play() แล้ววัดว่า currentTime เดินหรือไม่ (เกณฑ์ > 0.5 วิ) */
async function probeUiPlayback(page: Page): Promise<PlaybackProbe> {
  const videoOnPage = (await page.locator("video").count()) > 0;
  if (!videoOnPage) {
    return {
      videoOnPage,
      durationFinite: false,
      duration: Number.NaN,
      errorCode: -1,
      currentTimeAfterPlay: 0,
      uiPlayable: false,
    };
  }
  const before = await page.evaluate(() => {
    const v = document.querySelector("video");
    if (v === null) {
      return null;
    }
    v.muted = true;
    void v.play().catch(() => undefined);
    return { duration: v.duration, errorCode: v.error === null ? 0 : v.error.code };
  });
  await page.waitForTimeout(PLAYBACK_PROBE_MS);
  const after = await page.evaluate(() => {
    const v = document.querySelector("video");
    return v === null ? null : { t: v.currentTime, err: v.error === null ? 0 : v.error.code };
  });
  const duration = before?.duration ?? Number.NaN;
  const errorCode = Math.max(before?.errorCode ?? 0, after?.err ?? 0);
  const currentTimeAfterPlay = after?.t ?? 0;
  const uiPlayable =
    Number.isFinite(duration) && duration > 0 && errorCode === 0 && currentTimeAfterPlay > 0.5;
  return {
    videoOnPage,
    durationFinite: Number.isFinite(duration) && duration > 0,
    duration,
    errorCode,
    currentTimeAfterPlay,
    uiPlayable,
  };
}

/** อ่าน watch_sec_accum สูงสุดของบทเรียนวิดีโอของผู้เรียน (DB ground truth) */
async function watchAccumSeconds(courseId: string, lessonId: string, userId: string): Promise<number> {
  const accum = await psqlScalar(`
    select coalesce(max(watch_sec_accum), 0) from public.lesson_progress lp
    join public.enrollments e on e.id = lp.enrollment_id
    where e.user_id = '${userId}' and e.course_id = '${courseId}' and lp.lesson_id = '${lessonId}';
  `);
  return Number(accum);
}

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

  test("เอกสาร: กด 'อ่านจบแล้ว' ผ่าน UI → progress 1 จาก 3 (DB completed)", async ({ page }) => {
    const lessons = course?.lessons ?? [];
    const doc = lessons.find((l) => l.type === "document");
    expect(doc, "seed: LTC-101 ต้องมีบทเรียน document").toBeDefined();
    await loginViaForm(page, userEmail);
    expect(await enrollCourse(page, course?.id ?? "")).toBe(201);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${doc?.id ?? ""}`);
    // เนื้อหาถูก wire แล้ว (paragraphs จริง) → ปุ่มต้อง enabled และกดได้ผ่าน UI จริง
    await expect(page.getByRole("button", { name: "อ่านจบแล้ว" })).toBeEnabled();
    await page.getByRole("button", { name: "อ่านจบแล้ว" }).click();
    await expect(
      page.getByText("ส่งยืนยันการอ่านจบเรียบร้อย รอระบบตัดสินสถานะจบบทเรียน"),
    ).toBeVisible();
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

  test("วิดีโอ: probe เล่นผ่าน UI ก่อน (ธง: stub decode ไม่ได้ → heartbeat API) จน watch_pct ≥ 80 (~7 นาที)", async ({
    page,
  }) => {
    test.setTimeout(540_000);
    const lessons = course?.lessons ?? [];
    const video = lessons.find((l) => l.type === "video");
    expect(video, "seed: LTC-101 ต้องมีบทเรียน video").toBeDefined();
    const courseId = course?.id ?? "";
    const lessonId = video?.id ?? "";
    const target = Math.ceil(((video?.durationSec ?? 600) * VIDEO_COMPLETE_PCT) / 100);
    await loginViaForm(page, userEmail);
    await page.goto(`/courses/${courseId}/learn/${lessonId}`);
    await expect(page.getByRole("heading", { name: "บทที่ 1 แนะนำหลักสูตร" })).toBeVisible();

    // ── ลองเล่นผ่าน UI จริงก่อนเสมอ (ธง lead) — ผล probe ผูกกับรายงานทุกรอบ ──
    const probe = await probeUiPlayback(page);
    test.info().annotations.push({
      type: "note",
      description:
        `probe วิดีโอ UI: videoOnPage=${String(probe.videoOnPage)} duration=${String(probe.duration)} ` +
        `errorCode=${String(probe.errorCode)} currentTimeAfterPlay=${probe.currentTimeAfterPlay.toFixed(2)} ` +
        `→ uiPlayable=${String(probe.uiPlayable)}`,
    });

    if (probe.uiPlayable) {
      // ── สาขา UI จริง: เล่นต่อจน accum ≥ เกณฑ์ ผ่านเบราว์เซอร์ทั้งหมด ──
      let accum = 0;
      let waited = 0;
      while (accum < target && waited < 500_000) {
        await page.waitForTimeout(HEARTBEAT_MS);
        waited += HEARTBEAT_MS;
        accum = await watchAccumSeconds(courseId, lessonId, userId);
      }
      expect(accum).toBeGreaterThanOrEqual(target);
    } else {
      // ── สาขา fallback (ธง): stub 32 ไบต์ decode ไม่ได้ — คง heartbeat ทาง API ──
      // ตามโจทย์: "ถ้า Chromium decode ไม่ได้ ให้คง heartbeat ทาง API + บันทึกเหตุผล
      // ในคอมเมนต์ + รายงานเป็นธง" — position เพิ่มตามเวลาจริง ไม่ปลอมว่าเล่นผ่าน UI
      const first = await postVideoPosition(page, lessonId, 60);
      expect(first).toBe(200);
      let accum = 0;
      let position = 60;
      let waited = 0;
      while (accum < target && waited < 430_000) {
        await page.waitForTimeout(HEARTBEAT_MS);
        waited += HEARTBEAT_MS;
        position += 30;
        const status = await postVideoPosition(page, lessonId, position);
        expect(status).toBe(200);
        accum = await watchAccumSeconds(courseId, lessonId, userId);
      }
      expect(accum).toBeGreaterThanOrEqual(target);
    }

    // ── ผลสุดท้ายต้องเหมือนกันทั้งสองสาขา (ตัดสินจาก DB จริง + UI) ──
    await page.goto("/my/courses");
    await expect(page.getByText("เรียนแล้ว 2 จาก 3 บทเรียน")).toBeVisible();
    const pct = await psqlScalar(`
      select max(watch_pct) from public.lesson_progress lp
      join public.enrollments e on e.id = lp.enrollment_id
      where e.user_id = '${userId}' and lp.lesson_id = '${lessonId}';
    `);
    expect(Number(pct)).toBeGreaterThanOrEqual(80);
    await page.goto(`/courses/${courseId}/learn/${lessonId}`);
    await expect(page.getByText("เรียนจบแล้ว")).toHaveCount(2);
  });
});
