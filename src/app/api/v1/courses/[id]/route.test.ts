/**
 * route.test — unit test ของ GET /api/v1/courses/{id} (contract-first —
 * mock Supabase client ตามแบบ src/lib/rbac.test.ts; guest/draft ตาม TC-005)
 */
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { errorDefinition } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { GET } from "./route";

vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  // gate r12: getUser ของ session.ts ใช้ buffered client — wrapper อ่าน stub จาก
  // createSupabaseSsrClient ณ เวลาถูกเรียก (mockResolvedValue ตั้งทีหลังได้)
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

interface QuerySpy {
  readonly select: Mock;
  readonly eq: Mock;
  readonly order: Mock;
  readonly limit: Mock;
  readonly not: Mock;
  readonly or: Mock;
  readonly filter: Mock;
  readonly maybeSingle: Mock;
}

interface Terminal {
  data: unknown;
  error: { message: string } | null;
}

function makeBuilder(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const terminal: Terminal = { data: result.data ?? null, error: result.error ?? null };
  const spy: QuerySpy = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    not: vi.fn(),
    or: vi.fn(),
    filter: vi.fn(),
    maybeSingle: vi.fn(),
  };
  const self = spy as unknown as Record<string, unknown>;
  const chain = ["select", "eq", "order", "limit", "not", "or", "filter"] as const;
  for (const method of chain) {
    spy[method].mockImplementation(() => self);
  }
  spy.maybeSingle.mockImplementation(async () => terminal);
  // thenable — await self → terminal (จำลอง query builder ของ supabase-js)
  self.then = ((onFulfilled?: (value: unknown) => unknown) =>
    Promise.resolve(terminal).then(onFulfilled)) as unknown;
  return { spy, self: self as unknown as Awaited<ReturnType<typeof createSupabaseSsrClient>> };
}

const createClientMock = vi.mocked(createSupabaseSsrClient);
const enforceRateLimitMock = vi.mocked(enforceRateLimit);

/**
 * client จำลองที่ dispatch ตามตาราง/view — courses กับ views สาธารณะ (DCR-4)
 * ได้ builder คนละตัว (route query views แยก แล้ว map ใน JS)
 */
function makeClient(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const byTable = new Map<string, ReturnType<typeof makeBuilder>>();
  const from = vi.fn((table: string) => {
    const cached = byTable.get(table);
    if (cached !== undefined) {
      return cached.self;
    }
    const created = makeBuilder(tables[table]);
    byTable.set(table, created);
    return created.self;
  });
  createClientMock.mockResolvedValue({ from } as never);
  return {
    from,
    /** spy ของ builder ที่ route เรียกไปแล้ว (หรือ builder ใหม่ถ้ายังไม่ถูกใช้ — ไว้ assert args) */
    spyOf: (table: string): QuerySpy => {
      const cached = byTable.get(table);
      if (cached !== undefined) {
        return cached.spy;
      }
      return makeBuilder(tables[table]).spy;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const COURSE_ID = "11111111-1111-4111-8111-111111111101";
/** uuid ข้อสอบปลายหลักสูตร (course_exam_summary.assessment_id — 0021/DCR-7) */
const ASSESSMENT_ID = "a0000000-0000-4000-8000-000000000001";

function makeRequest(id: string): Request {
  return new Request(`http://localhost:3000/api/v1/courses/${id}`);
}

async function callRoute(id: string): Promise<Response> {
  return GET(makeRequest(id), { params: Promise.resolve({ id }) });
}

/** แถว courses จำลอง (RLS อนุญาต — published) */
function publishedRow() {
  return {
    id: COURSE_ID,
    code: "C101",
    title_th: "หลักสูตรทดสอบ",
    title_en: "Test Course",
    summary: "สรุป",
    description_md: "รายละเอียดแบบ markdown",
    status: "published",
    is_public: true,
    level: "beginner",
    outcome_highlights: [
      "เข้าใจโครงสร้างระบบกฎหมายไทยและลำดับชั้นของกฎหมาย",
      "อ่านและทำความเข้าใจสัญญาทั่วไปก่อนลงนามได้",
    ],
    published_at: "2026-08-01T00:00:00+00:00",
    category: { id: "cat-1", slug: "public-law", name_th: "กฎหมายสำหรับประชาชน" },
    course_modules: [
      {
        id: "mod-2",
        title_th: "โมดูล 2",
        sort_order: 2,
        is_preview: false,
        lessons: [
          { id: "l1", type: "video", title_th: "บทที่ 1", duration_sec: 1800, is_preview: true, sort_order: 1 },
          { id: "l2", type: "document", title_th: "บทที่ 2", duration_sec: null, is_preview: false, sort_order: 2 },
        ],
      },
      {
        id: "mod-1",
        title_th: "โมดูล 1",
        sort_order: 1,
        is_preview: true,
        lessons: [{ id: "l3", type: "quiz", title_th: "แบบทดสอบ", duration_sec: null, is_preview: false, sort_order: 1 }],
      },
    ],
  };
}

describe("GET /api/v1/courses/{id}", () => {
  it("200 — รายละเอียด + โมดูล/บทเรียนเรียง sort_order + camelCase + ฟิลด์ DCR-4", async () => {
    makeClient({
      courses: { data: publishedRow() },
      course_public_stats: { data: { course_id: COURSE_ID, learner_count: 3412, credits: 3 } },
      course_instructors_public: {
        data: [
          {
            display_name: "ผศ.ดร.สมชาย วัฒนศิริ",
            title: "ภาคีสมาชิกสภาทนายความแห่งประเทศไทย",
            bio: "ผู้เชี่ยวชาญกฎหมายแพ่ง",
          },
          { display_name: "ทนายพิมพ์ชนก ศรีสุวรรณ", title: null, bio: null },
        ],
      },
      course_exam_summary: {
        data: {
          question_count: 30,
          time_limit_minutes: 60,
          pass_score_pct: 70,
          max_attempts: 3,
          assessment_id: ASSESSMENT_ID,
        },
      },
    });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as {
      data: {
        modules: Array<{ id: string; sortOrder: number; lessons: Array<{ id: string }> }>;
        lessonCount: number;
        durationHours: number;
        [key: string]: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body.data.id).toBe(COURSE_ID);
    expect(body.data.categorySlug).toBe("public-law");
    expect(body.data.description).toBe("รายละเอียดแบบ markdown");
    expect(body.data.modules.map((m) => m.id)).toEqual(["mod-1", "mod-2"]);
    expect(body.data.modules[0]?.lessons.map((l) => l.id)).toEqual(["l3"]);
    expect(body.data.lessonCount).toBe(3);
    expect(body.data.durationHours).toBe(0.5);
    expect(body.data.level).toBe("beginner");
    expect(body.data.credits).toBe(3);
    expect(body.data.learnerCount).toBe(3412);
    expect(body.data.outcomes).toEqual([
      "เข้าใจโครงสร้างระบบกฎหมายไทยและลำดับชั้นของกฎหมาย",
      "อ่านและทำความเข้าใจสัญญาทั่วไปก่อนลงนามได้",
    ]);
    expect(body.data.instructors).toEqual([
      {
        nameTh: "ผศ.ดร.สมชาย วัฒนศิริ",
        titleTh: "ภาคีสมาชิกสภาทนายความแห่งประเทศไทย",
        bio: "ผู้เชี่ยวชาญกฎหมายแพ่ง",
      },
      { nameTh: "ทนายพิมพ์ชนก ศรีสุวรรณ", titleTh: null, bio: null },
    ]);
    expect(body.data.exam).toEqual({
      questionCount: 30,
      timeLimitMinutes: 60,
      passScorePct: 70,
      maxAttempts: 3,
      assessmentId: ASSESSMENT_ID,
    });
    expect(enforceRateLimitMock).toHaveBeenCalledWith(expect.anything(), { group: "PUBLIC_READ" });
  });

  it("select เฉพาะคอลัมน์ที่ต้องใช้ + query ด้วย id ที่ parse แล้ว + ใช้ view ครบ 3 ตัว (DCR-4)", async () => {
    const client = makeClient({
      courses: { data: publishedRow() },
      course_public_stats: { data: null },
      course_instructors_public: { data: [] },
      course_exam_summary: { data: null },
    });

    await callRoute(COURSE_ID);

    expect(client.spyOf("courses").select).toHaveBeenCalledWith(expect.stringContaining("description_md"));
    expect(client.spyOf("courses").eq).toHaveBeenCalledWith("id", COURSE_ID);
    expect(client.spyOf("courses").maybeSingle).toHaveBeenCalledTimes(1);
    expect(client.spyOf("course_public_stats").select).toHaveBeenCalledWith(
      expect.stringContaining("learner_count"),
    );
    expect(client.spyOf("course_public_stats").eq).toHaveBeenCalledWith("course_id", COURSE_ID);
    expect(client.spyOf("course_instructors_public").select).toHaveBeenCalledWith(
      expect.stringContaining("display_name"),
    );
    expect(client.spyOf("course_exam_summary").select).toHaveBeenCalledWith(
      expect.stringContaining("max_attempts"),
    );
    expect(client.spyOf("course_exam_summary").select).toHaveBeenCalledWith(
      expect.stringContaining("assessment_id"),
    );
    expect(client.spyOf("course_exam_summary").maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("draft/ไม่พบ (RLS คืน null สำหรับ guest — TC-005) → 404 ERR-CRS-001 ไม่เปิดเผยการมีอยู่ + ไม่ query views", async () => {
    const client = makeClient({ courses: { data: null } });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ERR-CRS-001");
    expect(body.error.message).toBe(errorDefinition("ERR-CRS-001").message);
    expect(client.from).not.toHaveBeenCalledWith("course_public_stats");
  });

  it("id ไม่ใช่ UUID → 400 ERR-VAL-001 field id (ไม่ query DB)", async () => {
    createClientMock.mockResolvedValue({ from: vi.fn() } as never);

    const response = await callRoute("not-a-uuid");
    const body = (await response.json()) as { error: { code: string; details: { fields: string[] } } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details).toEqual({ fields: ["id"] });
    // ตรวจรูปแบบ id ก่อนแตะฐานข้อมูล — ไม่สร้าง client / ไม่ query
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("error ฝั่ง DB → 503 ERR-SYS-002 แบบ opaque (ไม่ leak SQL)", async () => {
    makeClient({ courses: { error: { message: "SQLSTATE XX000" } } });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("error ฝั่ง view (course_instructors_public) → 503 ERR-SYS-002 (DCR-4)", async () => {
    makeClient({
      courses: { data: publishedRow() },
      course_instructors_public: { error: { message: "SQLSTATE XX000" } },
    });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("null-path: ไม่มีกฎ credit / ไม่มี exam / ไม่มี outcome_highlights / วิทยากร title NULL", async () => {
    makeClient({
      courses: {
        data: { ...publishedRow(), outcome_highlights: null },
      },
      course_public_stats: { data: { course_id: COURSE_ID, learner_count: 0, credits: null } },
      course_instructors_public: { data: [] },
      course_exam_summary: { data: null },
    });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as {
      data: { credits: number; learnerCount: number; outcomes: unknown[]; instructors: unknown[]; exam: unknown };
    };

    expect(response.status).toBe(200);
    expect(body.data.credits).toBe(0);
    expect(body.data.learnerCount).toBe(0);
    expect(body.data.outcomes).toEqual([]);
    expect(body.data.instructors).toEqual([]);
    expect(body.data.exam).toBeNull();
  });

  it("exam มีแถวแต่ assessment_id = null → exam ครบ 4 ฟิลด์เดิม + assessmentId null (200)", async () => {
    makeClient({
      courses: { data: publishedRow() },
      course_public_stats: { data: null },
      course_instructors_public: { data: [] },
      course_exam_summary: {
        data: {
          question_count: 10,
          time_limit_minutes: 45,
          pass_score_pct: 60,
          max_attempts: 2,
          assessment_id: null,
        },
      },
    });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { data: { exam: { assessmentId: string | null } | null } };

    expect(response.status).toBe(200);
    expect(body.data.exam).toEqual({
      questionCount: 10,
      timeLimitMinutes: 45,
      passScorePct: 60,
      maxAttempts: 2,
      assessmentId: null,
    });
  });

  it("แถว exam drift (คีย์เกิน) → 503 ERR-SYS-002 แบบ opaque (CourseExamSummaryView .strict() — ไม่ strip เงียบ)", async () => {
    makeClient({
      courses: { data: publishedRow() },
      course_public_stats: { data: null },
      course_instructors_public: { data: [] },
      course_exam_summary: {
        data: {
          question_count: 10,
          time_limit_minutes: 45,
          pass_score_pct: 60,
          max_attempts: 2,
          assessment_id: null,
          extra_column: "drift",
        },
      },
    });

    const response = await callRoute(COURSE_ID);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).toBe(errorDefinition("ERR-SYS-002").message);
  });

  it("สะท้อน x-request-id กลับทุก response (SDS §5.4)", async () => {
    makeClient({
      courses: { data: publishedRow() },
      course_public_stats: { data: null },
      course_instructors_public: { data: [] },
      course_exam_summary: { data: null },
    });
    const request = new Request(`http://localhost:3000/api/v1/courses/${COURSE_ID}`, {
      headers: { "x-request-id": "req-c2-detail" },
    });

    const response = await GET(request, { params: Promise.resolve({ id: COURSE_ID }) });

    expect(response.headers.get("x-request-id")).toBe("req-c2-detail");
  });
});
