/**
 * unit tests — POST /api/v1/attempts/[id]/answers (Wave D-1)
 *
 * จุดตรวจหลัก (D20-B5): p_session_id ต้องมาจาก claim `session_id` ของ access token ใน
 * session store เท่านั้น — body จะแอบแถม session_id มาก็ต้องไม่ถูกใช้ · body ตาม §4 #7
 * (questionId/choiceIds/clientSavedAt) · rate EXAM · map ผล RPC save_answer ตามทะเบียน
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
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
import { errorDefinition, type ErrorCode } from "@/lib/errors";

const ATTEMPT_ID = "b0000000-0000-4000-8000-000000000001";
const Q1 = "d0000000-0000-4000-8000-000000000101";
const OPT1 = "e0000000-0000-4000-8000-000000000201";
const OPT2 = "e0000000-0000-4000-8000-000000000202";
const SESSION_ID = "sess-d1-answers-1";
const T = "2026-09-11T01:02:03+00:00";

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return enc({ alg: "HS256", typ: "JWT" }) + "." + enc(payload) + "." + "c2ln";
}

interface Spec {
  userId: string | null;
  aal: "aal1" | "aal2";
  roles: readonly string[];
  /** access token ทั้งสตริง — null = ไม่มี session ใน store */
  token: string | null;
  /** claim session_id ใน token (default SESSION_ID) — null = ตัด claim ทิ้ง */
  claim: string | null;
  rpcError: { message: string } | null;
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: "u1",
    aal: "aal1",
    roles: ["citizen"],
    token: makeJwt({ sub: "u1", session_id: SESSION_ID }),
    claim: SESSION_ID,
    rpcError: null,
    ...spec,
  };
  const claimObj: Record<string, unknown> =
    full.token === null
      ? {}
      : (JSON.parse(
          Buffer.from(full.token.split(".")[1] as string, "base64url").toString("utf8"),
        ) as Record<string, unknown>);
  if (full.claim === null) {
    delete claimObj["session_id"];
  }
  const token = full.token === null ? null : makeJwt(claimObj);
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const client = {
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
      getSession: vi.fn(async () => ({
        data: { session: token === null ? null : { access_token: token } },
        error: null,
      })),
    },
    rpc: vi.fn(async (...a: [string, unknown?]) => {
      const [fn] = a;
      if (fn === "my_roles") {
        return { data: full.roles, error: null };
      }
      return { data: null, error: full.rpcError };
    }),
    from: vi.fn(() => profilesBuilder),
    _rpcArgs: [] as Array<{ fn: string; args: unknown }>,
  };
  const rawRpc = client.rpc;
  client.rpc = vi.fn(async (fn: string, args?: unknown) => {
    client._rpcArgs.push({ fn, args });
    return rawRpc(fn, args as never) as never;
  }) as typeof client.rpc;
  return { client, full };
}

function mockClient(spec: Partial<Spec> = {}) {
  const { client } = makeClient(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

const BODY = {
  questionId: Q1,
  choiceIds: [OPT1, OPT2],
  clientSavedAt: T,
};

async function post(spec: Partial<Spec> = {}, body: unknown = BODY, headers: Record<string, string> = {}) {
  const client = mockClient(spec);
  const res = await POST(
    new Request("http://localhost:3000/api/v1/attempts/" + ATTEMPT_ID + "/answers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.5",
        "x-request-id": "req-d1-4",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ATTEMPT_ID }) },
  );
  return { res, client };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

interface OkBody { data: Record<string, unknown> }
interface ErrorBody { error: { code: string; message: string; details?: Record<string, unknown> } }

describe("POST /attempts/{id}/answers — happy path", () => {
  it("citizen autosave → 200 { savedAt } เท่านั้น · RPC รับ p_session_id จาก claim JWT", async () => {
    const { res, client } = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(Object.keys(body.data).sort()).toEqual(["savedAt"]);
    expect(new Date(String(body.data["savedAt"])).toString()).not.toBe("Invalid Date");
    expect(res.headers.get("x-request-id")).toBe("req-d1-4");
    const call = client._rpcArgs.find((c) => c.fn === "save_answer");
    expect(call?.args).toEqual({
      p_attempt_id: ATTEMPT_ID,
      p_question_id: Q1,
      p_selected_option_ids: [OPT1, OPT2],
      p_session_id: SESSION_ID,
    });
  });

  it("D20-B5: body แอบแถม session_id/is_correct → 400 ERR-VAL-001 ไม่ถึง RPC เลย (r6-L1 strict ขาเข้า) — session_id จาก claim เท่านั้น", async () => {
    const { res, client } = await post({}, {
      ...BODY,
      session_id: "attacker-chosen-session",
      is_correct: true,
      points_earned: 5,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(client._rpcArgs.find((c) => c.fn === "save_answer")).toBeUndefined();
  });
});

describe("POST /attempts/{id}/answers — map ผล RPC save_answer", () => {
  const cases: Array<{ label: string; message: string; code: ErrorCode; status: number }> = [
    {
      label: "ไม่พบ attempt/ข้อ",
      message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)",
      code: "ERR-NF-001",
      status: 404,
    },
    {
      label: "session ไม่ตรงของ attempt (ASM-011)",
      message: "คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ERR-RBAC-001|session_mismatch)",
      code: "ERR-RBAC-001",
      status: 403,
    },
    {
      label: "ส่งข้อสอบแล้ว",
      message: "บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว (ERR-ASM-005)",
      code: "ERR-ASM-005",
      status: 422,
    },
    {
      label: "หมดเวลาสอบ",
      message: "หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม (ERR-ASM-004)",
      code: "ERR-ASM-004",
      status: 422,
    },
    {
      label: "ตัวเลือกไม่อยู่ในข้อนี้",
      message: "ข้อมูลที่ส่งมาไม่ถูกต้อง (ERR-VAL-001)",
      code: "ERR-VAL-001",
      status: 400,
    },
  ];
  for (const c of cases) {
    it(c.label + " → " + String(c.status) + " " + c.code + " (ข้อความจากทะเบียน)", async () => {
      const { res } = await post({ rpcError: { message: c.message } });
      expect(res.status).toBe(c.status);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe(c.code);
      expect(body.error.message).toBe(errorDefinition(c.code).message);
    });
  }

  it("RPC ล้มเหลวโดยไม่มี code ท้ายข้อความ → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    const { res } = await post({ rpcError: { message: "SQLSTATE 42501 permission denied" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("รูปเก่า (ASM-011 — ERR-RBAC-001) ต้องยังไม่ผ่าน parser → 503 opaque (ทิศสกปรก BFF — DCR ASM-011)", async () => {
    const { res } = await post({
      rpcError: { message: "คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ASM-011 — ERR-RBAC-001)" },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("ASM-011");
  });
});

describe("POST /attempts/{id}/answers — auth / rbac / validation", () => {
  it("ไม่ login → 401 ERR-AUTH-001 และไม่เรียก save_answer", async () => {
    const { res, client } = await post({ userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._rpcArgs.some((c) => c.fn === "save_answer")).toBe(false);
  });

  it("บทบาทไม่มี attempt:start → 403 ERR-RBAC-001", async () => {
    const { res, client } = await post({ roles: ["guest-unknown"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(client._rpcArgs.some((c) => c.fn === "save_answer")).toBe(false);
  });

  it("staff aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004", async () => {
    const { res } = await post({ roles: ["staff:exam"], aal: "aal1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("token ใน store ไม่มี claim session_id → 401 ERR-AUTH-001 และไม่เรียก save_answer (fail-closed)", async () => {
    const { res, client } = await post({ claim: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._rpcArgs.some((c) => c.fn === "save_answer")).toBe(false);
  });

  it("ไม่มี session ใน store → 401 ERR-AUTH-001", async () => {
    const { res, client } = await post({ token: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._rpcArgs.some((c) => c.fn === "save_answer")).toBe(false);
  });

  it("path id ไม่ใช่ uuid → 400 ERR-VAL-001 (fields: id) ก่อนถึง RPC", async () => {
    const client = mockClient();
    const res = await POST(
      new Request("http://localhost:3000/api/v1/attempts/nope/answers", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.5" },
        body: JSON.stringify(BODY),
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.["fields"]).toEqual(["id"]);
    expect(client._rpcArgs.some((c) => c.fn === "save_answer")).toBe(false);
  });

  it("choiceIds ว่าง → 400 ERR-VAL-001 (fields: choiceIds)", async () => {
    const { res, client } = await post({}, { ...BODY, choiceIds: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.["fields"]).toContain("choiceIds");
    expect(client._rpcArgs.some((c) => c.fn === "save_answer")).toBe(false);
  });

  it("clientSavedAt ไม่ใช่ ISO datetime → 400 ERR-VAL-001", async () => {
    const { res } = await post({}, { ...BODY, clientSavedAt: "11/9/2026" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("body ไม่ใช่ JSON → 400 ERR-VAL-001 (fields: body)", async () => {
    const { res } = await post({}, "not-json{{");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.["fields"]).toEqual(["body"]);
  });

  it("rate EXAM = 2/min (env) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + Retry-After", async () => {
    const first = await post();
    expect(first.res.status).toBe(200);
    const second = await post();
    expect(second.res.status).toBe(200);
    const third = await post();
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });
});
