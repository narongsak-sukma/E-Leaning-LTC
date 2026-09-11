/**
 * unit tests — POST /api/v1/assessments/[id]/attempts (Wave D-1)
 *
 * พฤติกรรม RPC ยึดข้อความ exception จริงจาก supabase/migrations/0011_functions.sql
 * (start_attempt — L411-L676): ASM-001/002/003 · LRN-001/LRN-002 · VAL-001 (ไม่มี claim)
 * จุดหลักของ lane นี้: ชุดข้อที่ตอบระหว่างสอบต้องไม่มี field เฉลยแม้แต่ตัวเดียว
 * (grep-style assert บน JSON.stringify ทั้ง response)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  // EXAM=2 เพื่อทดสอบ 429 (config cache ตอน first getConfig — ต้องตั้งก่อน import)
  process.env.RATE_LIMIT_EXAM_PER_MIN = "2";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { POST } from "./route";
import { errorDefinition } from "@/lib/errors";
import { AttemptStartView } from "@/lib/schemas/v1/exam";

const ASSESSMENT_ID = "a0000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "b0000000-0000-4000-8000-000000000001";
const T = "2026-09-10T02:02:03+00:00";
const Q1 = "d0000000-0000-4000-8000-000000000101";
const Q2 = "d0000000-0000-4000-8000-000000000102";
const OPT1 = "e0000000-0000-4000-8000-000000000201";
const OPT2 = "e0000000-0000-4000-8000-000000000202";

const START_RESULT = {
  attempt_id: ATTEMPT_ID,
  session_id: "sess-1",
  expires_at: T,
  question_count: 2,
};

// แถว learner_attempt_paper_view (0019) — question_paper = snapshot ตัดเฉลยแล้ว
// ({question_id,version,text,options:[{id,text}]} — ไม่มี points/is_correct ทุกชั้น)
const VIEW_ROWS = [
  {
    question_id: Q1,
    seq: 1,
    selected_option_ids: null,
    answered_at: null,
    question_paper: {
      question_id: Q1,
      version: 1,
      text: "ข้อที่ 1",
      options: [
        { id: OPT1, text: "ตัวเลือกแรก" },
        { id: OPT2, text: "ตัวเลือกที่สอง" },
      ],
      type: "single_choice",
    },
  },
  {
    question_id: Q2,
    seq: 2,
    selected_option_ids: [OPT1],
    answered_at: T,
    question_paper: {
      question_id: Q2,
      version: 2,
      text: "ข้อที่ 2",
      options: [
        { id: OPT1, text: "ตัวเลือกแรก" },
        { id: OPT2, text: "ตัวเลือกที่สอง" },
      ],
      type: "true_false",
    },
  },
];

interface Spec {
  userId: string | null;
  aal: "aal1" | "aal2";
  roles: readonly string[];
  start: { data: unknown; error: { message: string } | null };
  // r9-O2: ครอบกรณี container ปลอม ({length:1} ไม่ใช่ array จริง) ด้วย
  rows: unknown;
  rowsError: { message: string } | null;
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: "u1",
    aal: "aal1",
    roles: ["citizen"],
    start: { data: START_RESULT, error: null },
    rows: VIEW_ROWS,
    rowsError: null,
    ...spec,
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const viewCalls: { select: string[]; eq: Array<[string, unknown]>; order: Array<[string, unknown]> } = {
    select: [],
    eq: [],
    order: [],
  };
  const viewBuilder = {
    select: vi.fn((columns: string) => {
      viewCalls.select.push(columns);
      return viewBuilder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      viewCalls.eq.push([column, value]);
      return viewBuilder;
    }),
    order: vi.fn((column: string, opts: unknown) => {
      viewCalls.order.push([column, opts]);
      return viewBuilder;
    }),
    then(res: (v: { data: unknown; error: { message: string } | null }) => unknown) {
      return res({ data: full.rows, error: full.rowsError });
    },
  };
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: full.userId === null ? null : { id: full.userId } },
        error: null,
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: full.aal, nextLevel: null, currentAuthenticationMethods: [] },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (...a: [string, unknown?]) => {
      const [fn] = a;
      if (fn === "my_roles") {
        return { data: full.roles, error: null };
      }
      return full.start;
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : viewBuilder)),
    _rpcArgs: [] as Array<{ fn: string; args: unknown }>,
    _viewCalls: viewCalls,
  };
}

function mockClient(spec: Partial<Spec> = {}) {
  const client = makeClient(spec);
  // เก็บ args ของ rpc (my_roles รวมอยู่ด้วย — filter ที่ test)
  const rawRpc = client.rpc;
  client.rpc = vi.fn(async (fn: string, args?: unknown) => {
    client._rpcArgs.push({ fn, args });
    return rawRpc(fn, args as never) as never;
  }) as typeof client.rpc;
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

async function post(id: string, spec: Partial<Spec> = {}) {
  const client = mockClient(spec);
  const res = await POST(
    new Request("http://localhost:3000/api/v1/assessments/" + id + "/attempts", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.3", "x-request-id": "req-d1-2" },
    }),
    { params: Promise.resolve({ id }) },
  );
  return { res, client };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("POST /assessments/{id}/attempts — happy path", () => {
  it("citizen เริ่มสอบ → 201 + หน้าต่างสอบ + ชุดข้อ (ผ่าน zod AttemptStartView)", async () => {
    const { res, client } = await post(ASSESSMENT_ID);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    const parsed = AttemptStartView.parse(body.data);
    expect(parsed.attemptId).toBe(ATTEMPT_ID);
    expect(parsed.deadlineAt).toBe(T);
    expect(parsed.questionCount).toBe(2);
    expect(parsed.questions.map((q) => q.questionId)).toEqual([Q1, Q2]);
    // 0019: โจทย์มาพร้อม content จาก paper view (version/text/options[{id,text}] เท่านั้น)
    expect(parsed.questions[0]?.content.version).toBe(1);
    expect(parsed.questions[0]?.content.text).toBe("ข้อที่ 1");
    expect(parsed.questions[0]?.content.options).toHaveLength(2);
    expect(Object.keys(parsed.questions[0]?.content.options[0] ?? {}).sort()).toEqual(["id", "text"]);
    // 0022/PB-18: ชนิดข้อส่งต่อจาก paper view ไปยังห้องสอบ (radio เมื่อตอบข้อเดียว)
    expect(parsed.questions[0]?.content.type).toBe("single_choice");
    expect(parsed.questions[1]?.content.type).toBe("true_false");
    expect(new Date(parsed.serverTime).toString()).not.toBe("Invalid Date");
    // เรียก RPC ตรง contract (p_assessment_id) และอ่านชุดข้อจาก view ของ attempt นั้น
    const startCall = client._rpcArgs.find((c) => c.fn === "start_attempt");
    expect(startCall?.args).toEqual({ p_assessment_id: ASSESSMENT_ID });
    expect(client._viewCalls.eq).toContainEqual(["attempt_id", ATTEMPT_ID]);
    expect(client._viewCalls.order).toContainEqual(["seq", { ascending: true }]);
    expect(res.headers.get("x-request-id")).toBe("req-d1-2");
  });

  it("takeover (ASM-011 lease หมด) → 201 + takeover:true ด้วย attempt เดิม", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      start: { data: { ...START_RESULT, takeover: true }, error: null },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { takeover?: boolean } };
    expect(body.data.takeover).toBe(true);
  });
});

describe("POST /assessments/{id}/attempts — response ระหว่างสอบต้องไร้เฉลย (D19-B1)", () => {
  it("แม้แถว view (จำลอง) มีคอลัมน์เฉลยครบ — r9-O2 แล้วคอลัมน์เหล่านั้นคือ drift ขาเข้า: 503 ก่อนถึง mapper และขาออกไม่มีคีย์เฉลยเด็ดขาด", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      rows: [
        {
          ...VIEW_ROWS[0],
          is_correct: true,
          points_earned: 5,
          explanation: "เฉลย ก",
          question_snapshot: { question_id: Q1, text: "โจทย์", options: [], points: 5 },
        },
        {
          ...VIEW_ROWS[1],
          is_correct: false,
          points_earned: 0,
          explanation: "เฉลย ข",
          question_snapshot: null,
        },
      ],
    });
    // เดิม (ถึง r8): mapper whitelist ตัดคีย์เฉลยแล้วตอบ 201 — r9-O2 เข้มขึ้น:
    // คอลัมน์เฉลยรั่วมากับแถว = สัญญา select เปลี่ยน = drift → 503 ไม่ใช่ 201 เฉย ๆ
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_paper_row_drift");
    const raw = JSON.stringify(body);
    for (const leak of [
      "is_correct",
      "isCorrect",
      "explanation",
      "points_earned",
      "pointsEarned",
      "question_snapshot",
      "questionSnapshot",
      "passed",
      "score_pct",
      "scorePct",
    ]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("select เฉพาะคอลัมน์ที่ไม่ใช่เฉลย (question_paper ของ 0019 ต่างจาก snapshot เฉลย)", async () => {
    const { client } = await post(ASSESSMENT_ID);
    const [cols] = client._viewCalls.select;
    for (const banned of ["is_correct", "points_earned", "question_snapshot", "explanation", "*"]) {
      expect(cols).not.toContain(banned);
    }
    expect(cols).toContain("question_paper");
  });
});

describe("POST /assessments/{id}/attempts — map ผล RPC ตาม 0011_functions.sql", () => {
  const cases: Array<{ label: string; message: string; code: string; status: number }> = [
    {
      label: "สอบครบจำนวนครั้ง",
      message: "คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว (ERR-ASM-001)",
      code: "ERR-ASM-001",
      status: 422,
    },
    {
      label: "มี attempt ค้าง (lease ยังไม่หมด)",
      message: "มีการสอบที่ยังไม่จบอยู่แล้ว (ERR-ASM-002)",
      code: "ERR-ASM-002",
      status: 409,
    },
    {
      label: "ไม่ published/ไม่พบ/คลังข้อไม่พอ/cooldown",
      message: "ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว (ERR-ASM-003)",
      code: "ERR-ASM-003",
      status: 404,
    },
    {
      label: "ยังไม่ลงทะเบียนหลักสูตร",
      message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)",
      code: "ERR-LRN-001",
      status: 403,
    },
    {
      label: "เรียนไม่ครบตามกติกา",
      message: "ยังเรียนบทก่อนหน้าไม่ครบตามเงื่อนไข (ERR-LRN-002)",
      code: "ERR-LRN-002",
      status: 422,
    },
    {
      label: "token ไม่มี session_id claim",
      message: "ข้อมูลที่ส่งมาไม่ถูกต้อง: token ไม่มี session_id (ERR-VAL-001)",
      code: "ERR-VAL-001",
      status: 400,
    },
  ];
  for (const c of cases) {
    it(c.label + " → " + c.code + " (" + c.status + ")", async () => {
      const { res } = await post(ASSESSMENT_ID, {
        start: { data: null, error: { message: c.message } },
      });
      expect(res.status).toBe(c.status);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(c.code);
      expect(body.error.message).toBe(errorDefinition(c.code as never).message);
    });
  }

  it("RPC ล้มเหลวไม่มีรหัสทะเบียน → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      start: { data: null, error: { message: "SQLSTATE 42P01 relation does not exist" } },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("RPC คืน jsonb ผิด contract → 503 ERR-SYS-002 (fail-closed)", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      start: { data: { attempt_id: "x" }, error: null },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("ชุดข้อเหลื่อมกับ question_count (แถวไม่ครบ) → 503 ERR-SYS-002 (fail-closed)", async () => {
    const { res } = await post(ASSESSMENT_ID, { rows: [VIEW_ROWS[0]] });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("อ่านชุดข้อล้มเหลว → 503 ERR-SYS-002", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      rowsError: { message: "SQLSTATE XX000" },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("question_paper ผิด contract (มี points แอบแถม) → 503 ERR-SYS-002 (fail-closed ที่ mapper)", async () => {
    const base = VIEW_ROWS[0];
    if (base === undefined) {
      throw new Error("fixture missing");
    }
    const { res } = await post(ASSESSMENT_ID, {
      rows: [
        { ...base, question_paper: { ...base.question_paper, points: 5 } },
        VIEW_ROWS[1],
      ],
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });
});

describe("POST /assessments/{id}/attempts — auth / validation / rate", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (และไม่เรียก RPC)", async () => {
    const { res, client } = await post(ASSESSMENT_ID, { userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._rpcArgs.some((c) => c.fn === "start_attempt")).toBe(false);
  });

  it("staff:viewer (ไม่มี attempt:start) → 403 ERR-RBAC-001", async () => {
    const { res } = await post(ASSESSMENT_ID, { roles: ["staff:viewer"], aal: "aal2" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("staff:viewer aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004 ก่อนพิจารณาสิทธิ์", async () => {
    const { res } = await post(ASSESSMENT_ID, { roles: ["staff:viewer"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("id ไม่ใช่ uuid → 400 ERR-VAL-001 (fields: id) และไม่เรียก RPC", async () => {
    const { res, client } = await post("not-a-uuid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields).toEqual(["id"]);
    expect(client._rpcArgs.some((c) => c.fn === "start_attempt")).toBe(false);
  });

  it("ครบ 2 ครั้ง (EXAM=2) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + retry-after", async () => {
    const first = await post(ASSESSMENT_ID);
    expect(first.res.status).toBe(201);
    const second = await post(ASSESSMENT_ID);
    expect(second.res.status).toBe(201);
    const third = await post(ASSESSMENT_ID);
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as {
      error: { code: string; details: { group: string } };
    };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("EXAM");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });
});

describe("r9-O2: แถว paper ขาเข้า drift → 503 fail-closed (ไม่ใช่ 500/strip เงียบ 201)", () => {
  it("สำเร็จแต่ data null → 503 attempt_paper_rows_not_array ไม่ใช่ 201 หน้าว่าง", async () => {
    const { res } = await post(ASSESSMENT_ID, { rows: null });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_paper_rows_not_array");
  });

  it("container ปลอม ({length:1} ผ่าน length check เดิม) → 503 attempt_paper_rows_not_array ไม่ใช่ TypeError 500", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      start: { data: { ...START_RESULT, question_count: 1 }, error: null },
      rows: { length: 1 },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_paper_rows_not_array");
  });

  it("แถว null ใน array ([null] ครบจำนวน) → 503 attempt_paper_row_drift ไม่ใช่ TypeError 500", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      start: { data: { ...START_RESULT, question_count: 1 }, error: null },
      rows: [null],
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_paper_row_drift");
  });

  it("แถวมีคีย์เกินนอก select 5 คอลัมน์ (is_correct รั่ว) → 503 attempt_paper_row_drift ไม่ strip เงียบแล้ว 201", async () => {
    const { res } = await post(ASSESSMENT_ID, {
      rows: [{ ...VIEW_ROWS[0], is_correct: true }, VIEW_ROWS[1]],
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_paper_row_drift");
  });

  it("แถวขาดคีย์ question_paper ไปเลย → 503 attempt_paper_row_drift", async () => {
    const missing = { ...VIEW_ROWS[0] } as Record<string, unknown>;
    delete missing["question_paper"];
    const { res } = await post(ASSESSMENT_ID, { rows: [missing, VIEW_ROWS[1]] });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_paper_row_drift");
  });

  it("จำนวนแถวไม่ตรง question_count (ผ่าน schema แล้ว) → 503 attempt_questions_bad_contract ตามเดิม", async () => {
    const { res } = await post(ASSESSMENT_ID, { rows: [VIEW_ROWS[0]] });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("attempt_questions_bad_contract");
  });
});
