/**
 * learning.server.test — unit test ของ loaders ฝั่ง server (PB-12 · D-0)
 *
 * - paragraphsOfContentMd: content_md → ย่อหน้าของ DocumentViewer (ตัดมาร์กอัปหัวข้อ/บุลเล็ต)
 * - resolveLessonMediaUrl: media_assets ที่ RLS ให้อ่านได้ → signed URL · ไม่ผ่านสิทธิ์ = null
 *   (media_read จำกัด instructor/staff — ผู้เรียนได้ null → placeholder ไทย ห้ามปลอม URL)
 * - loadCourseViewerGate: 401 = guest · พบแถว = enrolled · expired/cancelled = not_enrolled
 * - loadLessonWorkspace: เนื้อหาจริงจาก lessons.content_md (document) + src (video)
 * - loadLessonWorkspace (D85/LRN-009): seed ตำแหน่งเริ่มเล่นจาก video_max_position_sec —
 *   clamp [0, duration-1] · 0 = ค่าจริง · null (แถว legacy) → fallback สูตร watchPct เดิม
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ssrClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock("@/lib/supabase/ssr", () => ({ createSupabaseSsrClient: mocks.ssrClient }));

// env ขั้นต่ำที่ lib/config ต้องใช้ (MEDIA_SIGNED_URL_TTL_SEC ใช้ค่า default 900)
process.env.PUBLIC_BASE_URL = "http://test.local";
process.env.SUPABASE_URL = "http://localhost:53227";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  loadCourseViewerGate,
  loadLessonWorkspace,
  paragraphsOfContentMd,
  resolveLessonMediaUrl,
} from "./learning.server";

const COURSE = "00000000-0000-4000-8000-000000000001";
const MODULE_A = "00000000-0000-4000-8000-000000000002";
const MODULE_B = "00000000-0000-4000-8000-000000000003";
const LESSON_V = "00000000-0000-4000-8111-000000000011";
const LESSON_D = "00000000-0000-4000-8111-000000000012";
const LESSON_Q = "00000000-0000-4000-8111-000000000013";
const ENROLLMENT = "00000000-0000-4000-8111-000000000031";
const ISO = "2026-09-10T03:00:00+07:00";

const DETAIL_BODY = {
  id: COURSE,
  titleTh: "หลักสูตรจริยธรรมทนายความ",
  category: { id: "00000000-0000-4000-8111-000000000051", nameTh: "จริยธรรม" },
  modules: [
    {
      id: MODULE_A,
      titleTh: "โมดูลที่ 1",
      lessons: [
        { id: LESSON_V, titleTh: "วิดีโอแนะนำหลักสูตร", type: "video", durationSec: 600 },
        { id: LESSON_D, titleTh: "เอกสารจรรยาบรรณทนายความ", type: "document", durationSec: null },
      ],
    },
    {
      id: MODULE_B,
      titleTh: "โมดูลที่ 2",
      lessons: [{ id: LESSON_Q, titleTh: "แบบทดสอบย่อยท้ายหลักสูตร", type: "quiz", durationSec: null }],
    },
  ],
};

const PROGRESS_BODY = {
  courseId: COURSE,
  enrollmentId: ENROLLMENT,
  enrollmentStatus: "active",
  lessonTotal: 3,
  lessonCompleted: 0,
  progressPct: 0,
  modules: [],
};

const ENROLLMENT_ROW = {
  id: ENROLLMENT,
  courseId: COURSE,
  status: "active",
  enrolledAt: ISO,
  expiresAt: null,
  completedAt: null,
};

interface LessonRowStub {
  content_md: string | null;
  media: {
    provider: string;
    bucket: string;
    storage_path: string;
    status: string;
  } | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** stub fetch ตามลำดับ BFF: GET /courses/{id} แล้ว GET /courses/{id}/progress — override ได้รายเคส */
function stubBff(args?: {
  /** wire body ของ GET /courses/{id} (default DETAIL_BODY) */
  readonly detail?: unknown;
  /** wire body ของ GET /courses/{id}/progress (default PROGRESS_BODY) */
  readonly progress?: unknown;
}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.includes("/progress")) {
      return jsonResponse(200, { data: args?.progress ?? PROGRESS_BODY });
    }
    return jsonResponse(200, { data: args?.detail ?? DETAIL_BODY });
  }));
}

/** stub fetch — GET /me/enrollments (สถานะการลงทะเบียนของผู้ชม) */
function stubEnrollments(rows: readonly unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> =>
      jsonResponse(200, { data: rows, page: { hasMore: false } })),
  );
}

/** stub supabase client — lessons query + storage signed URL ตามสิทธิ์ที่จำลอง */
function stubSsrClient(args: {
  lessonRow: LessonRowStub | null;
  signedUrl: string | null;
}) {
  const { lessonRow, signedUrl } = args;
  const row: { data: LessonRowStub | null; error: null } = { data: lessonRow, error: null };
  const builder: {
    select: () => unknown;
    eq: () => unknown;
    maybeSingle: () => Promise<{ data: LessonRowStub | null; error: null }>;
  } = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => row,
  };
  const createSignedUrl = vi.fn(async () =>
    signedUrl === null
      ? { data: null, error: { message: "denied" } }
      : { data: { signedUrl }, error: null });
  const client = {
    from: () => builder,
    storage: { from: () => ({ createSignedUrl }) },
  };
  mocks.ssrClient.mockResolvedValue(client as never);
  return { createSignedUrl };
}

beforeEach(() => {
  mocks.ssrClient.mockReset();
  vi.unstubAllGlobals();
});

// ——— paragraphsOfContentMd — เนื้อหาเอกสาร → ย่อหน้า ———
describe("paragraphsOfContentMd", () => {
  it("null / whitespace-only → empty paragraphs", () => {
    expect(paragraphsOfContentMd(null)).toEqual([]);
    expect(paragraphsOfContentMd("   ")).toEqual([]);
  });

  it("markdown → paragraphs (strip heading/bullet/quote markers, join continuation lines)", () => {
    const md = "# h1\n\nfirst line\nsecond line\n\n- bullet one\n- bullet two\n\n> quote";
    expect(paragraphsOfContentMd(md)).toEqual([
      "h1",
      "first line second line",
      "bullet one bullet two",
      "quote",
    ]);
  });

  it("no blank line → single paragraph", () => {
    expect(paragraphsOfContentMd("single paragraph")).toEqual(["single paragraph"]);
  });
});

// ——— resolveLessonMediaUrl — media ที่ RLS ให้อ่านได้ → signed URL / null ———
describe("resolveLessonMediaUrl", () => {
  it("media null → null", async () => {
    stubSsrClient({ lessonRow: null, signedUrl: null });
    expect(await resolveLessonMediaUrl(null)).toBeNull();
  });

  it("status not ready → null", async () => {
    stubSsrClient({ lessonRow: null, signedUrl: null });
    const media = { provider: "supabase_storage", bucket: "media", storagePath: "p.mp4", status: "processing" };
    expect(await resolveLessonMediaUrl(media)).toBeNull();
  });

  it("provider r2/stream (ยังไม่มี CDN config) → null", async () => {
    stubSsrClient({ lessonRow: null, signedUrl: null });
    const media = { provider: "r2", bucket: "media", storagePath: "p.mp4", status: "ready" };
    expect(await resolveLessonMediaUrl(media)).toBeNull();
  });

  it("supabase_storage + ready → signed URL ตาม TTL ใน config (900)", async () => {
    const { createSignedUrl } = stubSsrClient({ lessonRow: null, signedUrl: "https://sb.example.com/sign" });
    const media = { provider: "supabase_storage", bucket: "media", storagePath: "courses/ltc-101/intro.mp4", status: "ready" };
    expect(await resolveLessonMediaUrl(media)).toBe("https://sb.example.com/sign");
    expect(createSignedUrl).toHaveBeenCalledWith("courses/ltc-101/intro.mp4", 900);
  });

  it("storage ปฏิเสธสิทธิ์ → null (placeholder — ห้ามปลอม URL)", async () => {
    stubSsrClient({ lessonRow: null, signedUrl: null });
    const media = { provider: "supabase_storage", bucket: "media", storagePath: "x.mp4", status: "ready" };
    expect(await resolveLessonMediaUrl(media)).toBeNull();
  });
});

// ——— loadCourseViewerGate — สถานะผู้ชมหน้ารายละเอียดหลักสูตร (PB-12) ———
describe("loadCourseViewerGate", () => {
  it("401 → guest (ยังไม่เข้าสู่ระบบ)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        jsonResponse(401, { error: { code: "ERR-AUTH-001", message: "กรุณาเข้าสู่ระบบ" } })),
    );
    expect(await loadCourseViewerGate(COURSE)).toEqual({ kind: "guest" });
  });

  it("ยังไม่ลงทะเบียน (รายการว่าง) → not_enrolled", async () => {
    stubEnrollments([]);
    expect(await loadCourseViewerGate(COURSE)).toEqual({ kind: "not_enrolled" });
  });

  it("ลงทะเบียนแล้ว status active → enrolled", async () => {
    stubEnrollments([ENROLLMENT_ROW]);
    expect(await loadCourseViewerGate(COURSE)).toEqual({ kind: "enrolled", status: "active" });
  });

  it("status expired → not_enrolled (ปุ่มลงทะเบียน + error จริงจาก RPC)", async () => {
    stubEnrollments([{ ...ENROLLMENT_ROW, status: "expired" }]);
    expect(await loadCourseViewerGate(COURSE)).toEqual({ kind: "not_enrolled" });
  });

  it("BFF ขัดข้อง (503) → not_enrolled (ไม่ปิดกั้น CTA)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        jsonResponse(503, { error: { code: "ERR-SYS-002", message: "บริการไม่พร้อมใช้งาน" } })),
    );
    expect(await loadCourseViewerGate(COURSE)).toEqual({ kind: "not_enrolled" });
  });
});

// ——— loadLessonWorkspace — เนื้อหาจริงจาก DB (content_md / media) ———
describe("loadLessonWorkspace", () => {
  it("บทเรียนเอกสาร: content_md → ย่อหน้าจริง (PB-12)", async () => {
    stubBff();
    stubSsrClient({
      lessonRow: { content_md: "# doc heading\n\nfirst paragraph", media: null },
      signedUrl: null,
    });
    const workspace = await loadLessonWorkspace(COURSE, LESSON_D);
    if (workspace.kind !== "ready") {
      throw new Error("workspace ควรพร้อม");
    }
    const lesson = workspace.data.lesson;
    expect(lesson.kind).toBe("document");
    if (lesson.kind !== "document") {
      throw new Error("lesson ควรเป็นเอกสาร");
    }
    expect(lesson.paragraphs).toEqual(["doc heading", "first paragraph"]);
  });

  it("บทเรียนเอกสาร: อ่านแถวไม่ได้ (RLS) → ย่อหน้าว่าง (placeholder ไทย ห้ามปลอมเนื้อหา)", async () => {
    stubBff();
    stubSsrClient({ lessonRow: null, signedUrl: null });
    const workspace = await loadLessonWorkspace(COURSE, LESSON_D);
    if (workspace.kind !== "ready") {
      throw new Error("workspace ควรพร้อม");
    }
    const lesson = workspace.data.lesson;
    expect(lesson.kind).toBe("document");
    if (lesson.kind !== "document") {
      throw new Error("lesson ควรเป็นเอกสาร");
    }
    expect(lesson.paragraphs).toEqual([]);
  });

  it("บทเรียนวิดีโอ: media null (RLS ไม่ผ่าน) → src null", async () => {
    stubBff();
    stubSsrClient({ lessonRow: null, signedUrl: null });
    const workspace = await loadLessonWorkspace(COURSE, LESSON_V);
    if (workspace.kind !== "ready") {
      throw new Error("workspace ควรพร้อม");
    }
    const lesson = workspace.data.lesson;
    expect(lesson.kind).toBe("video");
    if (lesson.kind !== "video") {
      throw new Error("lesson ควรเป็นวิดีโอ");
    }
    expect(lesson.src).toBeNull();
  });

  it("บทเรียนวิดีโอ: media ready + signed URL → src จริงจาก storage", async () => {
    stubBff();
    const { createSignedUrl } = stubSsrClient({
      lessonRow: {
        content_md: null,
        media: {
          provider: "supabase_storage",
          bucket: "media",
          storage_path: "courses/ltc-101/intro.mp4",
          status: "ready",
        },
      },
      signedUrl: "https://media.test/signed",
    });
    const workspace = await loadLessonWorkspace(COURSE, LESSON_V);
    if (workspace.kind !== "ready") {
      throw new Error("workspace ควรพร้อม");
    }
    const lesson = workspace.data.lesson;
    expect(lesson.kind).toBe("video");
    if (lesson.kind !== "video") {
      throw new Error("lesson ควรเป็นวิดีโอ");
    }
    expect(lesson.src).toBe("https://media.test/signed");
    expect(createSignedUrl).toHaveBeenCalledWith("courses/ltc-101/intro.mp4", 900);
  });
});

// ——— loadLessonWorkspace — seed ตำแหน่งเริ่มเล่นจาก video_max_position_sec (D85/LRN-009) ———
/** สถานะของ LESSON_V (วิดีโอ) ใน progress — รูปร่างเดียวกับ CourseLessonProgressView */
interface VideoLessonState {
  readonly lessonId: string;
  readonly lessonType: "video";
  readonly status: "not_started" | "in_progress" | "completed";
  readonly watchPct: number;
  readonly videoMaxPositionSec: number | null;
  readonly quizScorePct: number | null;
  readonly completedAt: string | null;
}

/** สร้างสถานะของ LESSON_V — default in_progress/watchPct 40 (ค่าที่สูตร % เดิมให้ 240 พอดี) */
function videoLesson(
  videoMaxPositionSec: number | null,
  overrides?: { readonly status?: "not_started" | "in_progress" | "completed"; readonly watchPct?: number },
): VideoLessonState {
  return {
    lessonId: LESSON_V,
    lessonType: "video",
    status: overrides?.status ?? "in_progress",
    watchPct: overrides?.watchPct ?? 40,
    videoMaxPositionSec,
    quizScorePct: null,
    completedAt: null,
  };
}

/** รัน loadLessonWorkspace จริงแล้วคืน initialPositionSeconds ที่ seed ให้ player */
async function seededPositionOf(lesson: VideoLessonState, durationSec = 600): Promise<number> {
  const detail =
    durationSec === 600
      ? DETAIL_BODY
      : {
          ...DETAIL_BODY,
          modules: DETAIL_BODY.modules.map((moduleRow) =>
            moduleRow.id === MODULE_A
              ? {
                  ...moduleRow,
                  lessons: moduleRow.lessons.map((row) =>
                    row.id === LESSON_V ? { ...row, durationSec } : row,
                  ),
                }
              : moduleRow,
          ),
        };
  stubBff({ detail, progress: { ...PROGRESS_BODY, modules: [
    {
      moduleId: MODULE_A,
      title: "โมดูลที่ 1",
      sortOrder: 1,
      lessonTotal: 1,
      lessonCompleted: lesson.status === "completed" ? 1 : 0,
      progressPct: lesson.status === "completed" ? 100 : 0,
      lessons: [lesson],
    },
  ] } });
  stubSsrClient({ lessonRow: null, signedUrl: null });
  const workspace = await loadLessonWorkspace(COURSE, LESSON_V);
  if (workspace.kind !== "ready") {
    throw new Error("workspace ควรพร้อม");
  }
  const lessonView = workspace.data.lesson;
  if (lessonView.kind !== "video") {
    throw new Error("lesson ควรเป็นวิดีโอ");
  }
  return lessonView.initialPositionSeconds;
}

describe("loadLessonWorkspace — seed ตำแหน่งเริ่มเล่นจาก video_max_position_sec (D85 clamp)", () => {
  it("v = 0 → 0 (ค่าจริง — ไม่ fallback สูตร watchPct)", async () => {
    expect(await seededPositionOf(videoLesson(0))).toBe(0);
  });

  it("v = duration (600) → 599 (duration-1 — player seek เมื่อ 0 < v < element.duration ตาม F19)", async () => {
    expect(await seededPositionOf(videoLesson(600))).toBe(599);
  });

  it("v > duration (700) → 599 (clamp เพดาน duration-1)", async () => {
    expect(await seededPositionOf(videoLesson(700))).toBe(599);
  });

  it("v = 333 (watchPct 40) → 333 — ต้องไม่เท่ากับ 240 ที่สูตร watchPct เดิมจะให้ (พิสูจน์อ่านวินาทีจริง)", async () => {
    const seeded = await seededPositionOf(videoLesson(333, { watchPct: 40 }));
    expect(seeded).toBe(333);
    // สูตรเดิมจาก % จะให้ min(600, round(0.4*600)) = 240 — ถ้า fallback ผิดที่ เทสนี้แดงทันที
    expect(seeded).not.toBe(Math.min(600, Math.round((40 / 100) * 600)));
  });

  it("v = null (แถว legacy ก่อนมีคอลัมน์) + watchPct 40 → 240 ตามสูตร watchPct เดิม", async () => {
    expect(await seededPositionOf(videoLesson(null, { watchPct: 40 }))).toBe(240);
  });

  it("completed แล้ว → 0 เสมอ (แม้ v = 500 — เริ่มดูใหม่เพื่อทบทวน)", async () => {
    expect(await seededPositionOf(videoLesson(500, { status: "completed", watchPct: 85 }))).toBe(0);
  });

  it("durationSec = 0 (ผิดปกติ) → 0 (ไม่มีความยาวให้ seed — กัน duration-1 ติดลบ)", async () => {
    expect(await seededPositionOf(videoLesson(300), 0)).toBe(0);
  });
});
