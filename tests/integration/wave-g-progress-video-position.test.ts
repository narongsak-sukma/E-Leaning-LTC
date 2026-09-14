/**
 * Integration — Wave G P3 (D85/LRN-009): โซ่ video_max_position_sec ทะลุจริง
 * GET /courses/{id}/progress (BFF จริงบน container app) → zod contract (CourseLessonProgressView)
 * → reader (getCourseProgress) → buildCourseOutline (stateByLesson) → loadLessonWorkspace
 * (seed ตำแหน่งเริ่มเล่นให้ player)
 *
 * หลักฐานต่อข้อ:
 * - BFF ส่ง video_max_position_sec ออกครบทุกแถว "ดิบ" (0 = ค่าจริง · null = แถว legacy
 *   ก่อนมีคอลัมน์ — ไม่ clamp ที่ BFF การ clamp เป็นหน้าที่ของ loader)
 * - outline ผูกสถานะต่อบทเรียนครบ (stateByLesson → OutlineLesson.videoMaxPositionSec)
 * - loader clamp ตำแหน่งเริ่มเล่น (duration 600 ทุกบท):
 *     v=0 → 0 · v=600 → 599 · v=700 → 599 · v=333 (watchPct 40) → 333 ≠ 240 (ค่าที่
 *     สูตร watchPct เดิมจะให้ — พิสูจน์อ่านวินาทีจริง ไม่ใช่ %) · null (legacy) → 240
 *     ตามสูตรเดิม · completed + v=500 → 0
 *
 * เงื่อนไขรัน: TEST_DATABASE_URL + container app (next dev) + .env ครบ
 * (PUBLIC_BASE_URL ชี้ container app, SUPABASE_URL/ANON_KEY — loader ยิง BFF ผ่าน
 * origin นี้และอ่าน lessons/media ด้วย JWT ผู้เรียนผ่าน Kong) · app เข้าไม่ถึง = skip
 * ทุกเคส (แบบ wave-g-qb-bank-detail) ยกเว้น TEST_REQUIRE_APP=1 (battery §2.4)
 * = ล้มทันที ห้ามผ่าน battery โดยไม่ได้พิสูจน์บน BFF จริง · รันโดย lead ตามลำดับ D-f-7
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANON_KEY, createTestUser, psql, psqlScalar, restCall, type TestUser } from "./helpers.js";
import {
  buildCourseOutline,
  getCourseDetail,
  getCourseProgress,
} from "@/lib/fixtures/learning";
import { loadLessonWorkspace } from "@/lib/fixtures/learning.server";

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (next dev) — BFF จริงของทุกเคส */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

/** ชื่อ cookie session ของ @supabase/ssr ใน container app — sb-<host ส่วนแรก>-auth-token */
const AUTH_COOKIE = "sb-kong-auth-token";

// ─── fixture ids ตายตัว (uuid hex เท่านั้น — ลบทันทีใน cleanup) ─────────────────

const COURSE = "cccccccc-0000-4000-8000-0000000000d1";
const MODULE_A = "cccccccc-0000-4000-8000-0000000000d2";

const L_V0 = "eeeeeeee-0000-4000-8000-0000000000e1";
const L_V600 = "eeeeeeee-0000-4000-8000-0000000000e2";
const L_V700 = "eeeeeeee-0000-4000-8000-0000000000e3";
const L_V333 = "eeeeeeee-0000-4000-8000-0000000000e4";
const L_VNULL = "eeeeeeee-0000-4000-8000-0000000000e5";
const L_VDONE = "eeeeeeee-0000-4000-8000-0000000000e6";

const M_V0 = "ffffffff-0000-4000-8000-0000000000a1";
const M_V600 = "ffffffff-0000-4000-8000-0000000000a2";
const M_V700 = "ffffffff-0000-4000-8000-0000000000a3";
const M_V333 = "ffffffff-0000-4000-8000-0000000000a4";
const M_VNULL = "ffffffff-0000-4000-8000-0000000000a5";
const M_VDONE = "ffffffff-0000-4000-8000-0000000000a6";

const ALL_MEDIA = [M_V0, M_V600, M_V700, M_V333, M_VNULL, M_VDONE];

/** ความยาววิดีโอทุกบท (วินาที) — ตัวเลขคำนวณ clamp อ้างอิง */
const DURATION = 600;

/** ค่าที่สูตร watchPct เดิมจะให้ (fallback ของแถว legacy) — ใช้เป็นตัวแยกแยะ */
function legacyFormula(watchPct: number): number {
  return Math.min(DURATION, Math.round((watchPct / 100) * DURATION));
}

/** ข้อมูล seed รายเคส — maxPosition = ค่าคอลัมน์ใน DB · expectedSeeded = clamp ที่ loader ต้องให้ */
interface VideoCase {
  readonly id: string;
  readonly mediaId: string;
  readonly path: string;
  readonly maxPosition: number | null;
  readonly status: "in_progress" | "completed";
  readonly watchPct: number;
  /** ค่าที่ BFF/outline ต้องส่งออก "ดิบ" (ไม่ clamp) */
  readonly expectedRaw: number | null;
  /** initialPositionSeconds ที่ loader ต้อง seed */
  readonly expectedSeeded: number;
}

const CASES: readonly VideoCase[] = [
  { id: L_V0, mediaId: M_V0, path: "courses/wgp3/pos0.mp4", maxPosition: 0, status: "in_progress", watchPct: 5, expectedRaw: 0, expectedSeeded: 0 },
  { id: L_V600, mediaId: M_V600, path: "courses/wgp3/pos600.mp4", maxPosition: DURATION, status: "in_progress", watchPct: 95, expectedRaw: DURATION, expectedSeeded: DURATION - 1 },
  { id: L_V700, mediaId: M_V700, path: "courses/wgp3/pos700.mp4", maxPosition: 700, status: "in_progress", watchPct: 95, expectedRaw: 700, expectedSeeded: DURATION - 1 },
  { id: L_V333, mediaId: M_V333, path: "courses/wgp3/pos333.mp4", maxPosition: 333, status: "in_progress", watchPct: 40, expectedRaw: 333, expectedSeeded: 333 },
  { id: L_VNULL, mediaId: M_VNULL, path: "courses/wgp3/posnull.mp4", maxPosition: null, status: "in_progress", watchPct: 40, expectedRaw: null, expectedSeeded: legacyFormula(40) },
  { id: L_VDONE, mediaId: M_VDONE, path: "courses/wgp3/posdone.mp4", maxPosition: 500, status: "completed", watchPct: 100, expectedRaw: 500, expectedSeeded: 0 },
];

// ─── cookie session ของ @supabase/ssr (base64url ตาม cookieEncoding) ────────────

interface JwtPayload {
  readonly exp?: number;
}

function sessionCookieValue(accessToken: string, userId: string): string {
  const part = accessToken.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as JwtPayload;
  const expiresAt = typeof payload.exp === "number"
    ? payload.exp
    : Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "wgp3-unused-no-refresh",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "",
      factors: [],
    },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** GET ผ่าน BFF จริงด้วย cookie session (แบบ wave-g-qb-bank-detail) */
async function bffGet(path: string, token: string, userId: string): Promise<{
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
}> {
  const response = await fetch(`${APP_URL}${path}`, {
    headers: {
      cookie: `${AUTH_COOKIE}=${sessionCookieValue(token, userId)}`,
      "x-forwarded-for": "10.7.0.1",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — คง null */ }
  return { status: response.status, text, json };
}

// ─── next/headers mock สำหรับ loader leg (RSC) — cookie จาก globalThis holder ───
// vi.mock ถูก hoist เหนือ const ทุกตัว จึงอ่านค่าผ่าน globalThis ณ เวลาเรียกจริง

declare global {
  var __wgp3SessionCookie: string | undefined;
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => {
      const value = globalThis.__wgp3SessionCookie;
      return value === undefined || value === "" ? [] : [{ name: "sb-kong-auth-token", value }];
    },
  }),
  headers: async () => new Headers(),
}));

// ─── fixture: ล้าง + seed (เรียกซ้ำได้) ─────────────────────────────────────────

/** ล้างโลกของ suite (เรียงตาม FK — RESTRICT) */
async function cleanupWaveGp3ProgressWorld(): Promise<void> {
  await psql(`
    delete from public.lesson_progress
     where enrollment_id in (select id from public.enrollments where course_id = '${COURSE}');
    delete from public.enrollments where course_id = '${COURSE}';
    delete from public.lessons
     where module_id in (select id from public.course_modules where course_id = '${COURSE}');
    delete from public.course_modules where course_id = '${COURSE}';
    delete from public.media_assets where id in (${ALL_MEDIA.map((id) => `'${id}'`).join(",")});
    delete from public.courses where id = '${COURSE}';
    delete from public.role_assignments where user_id in (select id from auth.users where email like 'wgp3-prog-%');
    delete from public.profiles where id in (select id from auth.users where email like 'wgp3-prog-%');
    delete from auth.users where email like 'wgp3-prog-%';
  `);
}

/** seed หลักสูตร 1 โมดูล 6 บทวิดีโอ (duration 600 · CHECK บังคับ media_id) + media_assets คู่ */
async function seedProgressWorld(learnerId: string): Promise<void> {
  const mediaValues = CASES.map((row) =>
    `('${row.mediaId}', 'supabase_storage', 'video', 'media', '${row.path}', 'video/mp4', 1024, ${DURATION}, 'ready', '${learnerId}')`
  ).join(",\n      ");
  const lessonValues = CASES.map((row, index) =>
    `('${row.id}', '${MODULE_A}', 'video', 'วิดีโอ D85 ${index + 1}', ${DURATION}, '${row.mediaId}', ${index + 1})`
  ).join(",\n      ");
  await psql(`
    insert into public.courses
      (id, code, category_id, created_by, title_th, is_public, status, published_at)
    values
      ('${COURSE}', 'E14-GP3-PROG',
       (select id from public.course_categories order by id limit 1), '${learnerId}',
       'หลักสูตร probe video_max_position_sec (wave-g-progress-video-position)', true, 'published', now())
    on conflict (id) do nothing;
    insert into public.course_modules (id, course_id, title_th, sort_order)
    values ('${MODULE_A}', '${COURSE}', 'โมดูล D85', 1)
    on conflict (id) do nothing;
    insert into public.media_assets
      (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, duration_sec, status, uploaded_by)
    values
      ${mediaValues}
    on conflict (id) do nothing;
    insert into public.lessons
      (id, module_id, type, title_th, duration_sec, media_id, sort_order)
    values
      ${lessonValues}
    on conflict (id) do nothing;
  `);
}

/** seed แถวความคืบหน้ารายเคส (video_max_position_sec ตามตาราง CASES) */
async function seedProgressRows(enrollmentId: string): Promise<void> {
  const values = CASES.map((row) =>
    `('${enrollmentId}', '${row.id}', '${row.status}', ${row.watchPct}, ${row.maxPosition === null ? "null" : String(row.maxPosition)}, ${row.status === "completed" ? "now()" : "null"})`
  ).join(",\n      ");
  await psql(`
    insert into public.lesson_progress
      (enrollment_id, lesson_id, status, watch_pct, video_max_position_sec, completed_at)
    values
      ${values}
  `);
}

// ─── ตัวช่วยตรวจโซ่ ──────────────────────────────────────────────────────────────

let learner: TestUser;

/** container app เข้าถึงได้หรือไม่ — ไม่ได้ = skip ทุกเคส (สแตกบางสภาพรันแค่ db+kong) */
let appReachable = false;

/**
 * app ไม่พร้อม → skip เคสตามปกติ ยกเว้น TEST_REQUIRE_APP=1 (battery §2.4) —
 * โหมด battery ห้ามเขียวแบบไม่ได้พิสูจน์บน BFF จริง: skip เงียบ = false pass → โยน error
 */
function requireAppOrSkip(ctx: { skip(): void }): void {
  if (appReachable) {
    return;
  }
  if (process.env["TEST_REQUIRE_APP"] === "1") {
    throw new Error(
      `app ไม่พร้อมที่ ${APP_URL} แต่ TEST_REQUIRE_APP=1 — battery ห้าม skip เคส BFF`,
    );
  }
  ctx.skip();
}

interface LessonWire {
  readonly lessonId: string;
  readonly videoMaxPositionSec: number | null;
}

function lessonsOf(body: unknown): Map<string, LessonWire> {
  const data = (body as { data: { modules: Array<{ lessons: LessonWire[] }> } }).data;
  const map = new Map<string, LessonWire>();
  for (const moduleRow of data.modules) {
    for (const lesson of moduleRow.lessons) {
      map.set(lesson.lessonId, lesson);
    }
  }
  return map;
}

describe.skipIf(!DB_URL)(
  "Wave G P3 — โซ่ video_max_position_sec ทะลุจริง GET→parser→map→loader (D85)",
  () => {
    beforeAll(async () => {
      await cleanupWaveGp3ProgressWorld();
      learner = await createTestUser("wgp3-prog-learn", "lawyer");
      await seedProgressWorld(learner.id);
      // ลงทะเบียนตามทางจริง (RPC enroll — เหมือน qb-bank-detail)
      await restCall(
        "POST",
        "/rest/v1/rpc/enroll",
        { apiKey: ANON_KEY, token: learner.accessToken },
        { p_course_id: COURSE },
      );
      const enrollmentId = await psqlScalar(
        `select id::text from public.enrollments where user_id = '${learner.id}' and course_id = '${COURSE}';`,
      );
      await seedProgressRows(enrollmentId);
      // ตั้ง cookie session ให้ loader leg (vi.mock("next/headers") อ่านจาก globalThis)
      globalThis.__wgp3SessionCookie = sessionCookieValue(learner.accessToken, learner.id);
      try {
        const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(5_000) });
        appReachable = probe.status < 500;
      } catch {
        appReachable = false;
      }
    }, 300_000);

    afterAll(async () => {
      globalThis.__wgp3SessionCookie = undefined;
      await cleanupWaveGp3ProgressWorld();
    });

    it("BFF GET /courses/{id}/progress → videoMaxPositionSec ทะลุครบ 6 แถว แบบดิบ (0=ค่าจริง · null=legacy)", async (ctx) => {
      requireAppOrSkip(ctx);
      const res = await bffGet(`/api/v1/courses/${COURSE}/progress`, learner.accessToken, learner.id);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const byLesson = lessonsOf(res.json);
      for (const row of CASES) {
        expect(
          byLesson.get(row.id)?.videoMaxPositionSec,
          `แถว ${row.id.slice(-2)} ต้องส่งค่าดิบจาก DB`,
        ).toBe(row.expectedRaw);
      }
    }, 60_000);

    it("reader+outline: getCourseProgress (zod) → buildCourseOutline → videoMaxPositionSec ผูกครบทุกบท", async (ctx) => {
      requireAppOrSkip(ctx);
      const context = { origin: APP_URL, cookieHeader: `${AUTH_COOKIE}=${sessionCookieValue(learner.accessToken, learner.id)}` };
      const [detail, progress] = await Promise.all([
        getCourseDetail(COURSE, context),
        getCourseProgress(COURSE, context),
      ]);
      const outline = buildCourseOutline(detail, progress);
      const byLesson = new Map<string, { status: string; watchPct: number; videoMaxPositionSec: number | null }>();
      for (const moduleRow of outline.modules) {
        for (const lesson of moduleRow.lessons) {
          byLesson.set(lesson.id, { status: lesson.status, watchPct: lesson.watchPct, videoMaxPositionSec: lesson.videoMaxPositionSec });
        }
      }
      for (const row of CASES) {
        const state = byLesson.get(row.id);
        expect(state?.videoMaxPositionSec, `outline บท ${row.id.slice(-2)}`).toBe(row.expectedRaw);
        expect(state?.status).toBe(row.status);
        expect(state?.watchPct).toBe(row.watchPct);
      }
    }, 60_000);

    it("loader: loadLessonWorkspace seed ตำแหน่งเริ่มเล่นถูก clamp ตามเคส (0→0 · 600→599 · 700→599 · 333→333≠240 · null→240 · completed→0)", async (ctx) => {
      requireAppOrSkip(ctx);
      for (const row of CASES) {
        const workspace = await loadLessonWorkspace(COURSE, row.id);
        if (workspace.kind !== "ready") {
          throw new Error(`บท ${row.id.slice(-2)}: workspace ควรพร้อม (ได้ ${workspace.kind})`);
        }
        const lesson = workspace.data.lesson;
        if (lesson.kind !== "video") {
          throw new Error(`บท ${row.id.slice(-2)}: lesson ควรเป็นวิดีโอ`);
        }
        expect(
          lesson.initialPositionSeconds,
          `บท ${row.id.slice(-2)} (v=${row.maxPosition === null ? "null" : row.maxPosition}, ${row.status}, watchPct ${row.watchPct})`,
        ).toBe(row.expectedSeeded);
      }
      // ตัวแยกแยะเชิงพิสูจน์: v=333 ต้องไม่ลูกเข้า fallback สูตร % เดิม (240)
      // และแถว legacy (null) เท่านั้นที่ได้ค่าตามสูตร — คืนสูตร = เทสนี้แดงทันที
      const v333 = CASES[3];
      const vNull = CASES[4];
      if (v333 === undefined || vNull === undefined) {
        throw new Error("fixture CASES ครบ 6 เคส");
      }
      expect(v333.expectedSeeded).not.toBe(legacyFormula(v333.watchPct));
      expect(vNull.expectedSeeded).toBe(legacyFormula(vNull.watchPct));
    }, 120_000);
  },
);
