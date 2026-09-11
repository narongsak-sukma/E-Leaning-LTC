/**
 * exam-api.test — unit test ชั้นข้อมูล client ของการสอบ
 *
 * - URL builders ตรง API-SPECIFICATION 3.5
 * - startAttempt: 201 ตามสัญญา → parse ผ่าน · คีย์เกินสัญญา (strict) → ERR-SYS-001
 * - error envelope 1.3: ERR-ASM-002 (ธง D37-6) → ExamApiError code/status ถูกต้อง
 * - network fail → ERR-SYS-001 status 0 (fail-closed)
 * - saveAttemptAnswer: body มีเฉพาะ questionId/choiceIds/clientSavedAt
 * - submitAttempt: ส่ง header Idempotency-Key + body unansweredQuestionIds
 *   · ผลตอบ (คะแนน) ไม่ถูก parse ที่ client แม้ BFF ตอบมา (ธง lead ข้อ 3/4)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessmentDetailUrl,
  attemptAnswersUrl,
  attemptStartUrl,
  attemptSubmitUrl,
  myAttemptsUrl,
  saveAttemptAnswer,
  startAttempt,
  submitAttempt,
  ExamApiError,
} from "./exam-api";

const ATT = "10000000-0000-4000-8000-000000000001";
const ASMT = "20000000-0000-4000-8000-000000000002";
const Q1 = "30000000-0000-4000-8000-000000000001";
const OPT_A = "40000000-0000-4000-8000-00000000000a";
const OPT_B = "40000000-0000-4000-8000-00000000000b";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function sessionPayload(extra: Record<string, unknown> = {}): unknown {
  return {
    data: {
      attemptId: ATT,
      status: "in_progress",
      deadlineAt: "2026-09-10T09:00:00+07:00",
      serverTime: "2026-09-10T08:00:00+07:00",
      questionCount: 1,
      questions: [
        {
          questionId: Q1,
          seq: 1,
          selectedOptionIds: null,
          answeredAt: null,
          content: { version: 1, text: "ข้อที่ 1", options: [
            { id: OPT_A, text: "ก" },
            { id: OPT_B, text: "ข" },
          ] },
        },
      ],
      ...extra,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("URL builders", () => {
  it("สร้าง URL ตาม API-SPECIFICATION 3.5", () => {
    expect(assessmentDetailUrl(ASMT)).toBe(`/api/v1/assessments/${ASMT}`);
    expect(attemptStartUrl(ASMT)).toBe(`/api/v1/assessments/${ASMT}/attempts`);
    expect(attemptAnswersUrl(ATT)).toBe(`/api/v1/attempts/${ATT}/answers`);
    expect(attemptSubmitUrl(ATT)).toBe(`/api/v1/attempts/${ATT}/submit`);
    expect(myAttemptsUrl(undefined)).toBe("/api/v1/me/attempts?limit=100");
    expect(myAttemptsUrl("abc")).toBe("/api/v1/me/attempts?limit=100&cursor=abc");
  });
});

describe("startAttempt", () => {
  it("201 ตามสัญญา = ได้หน้าต่างสอบ (ไร้เฉลย)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, sessionPayload()));
    vi.stubGlobal("fetch", fetchMock);
    const session = await startAttempt(ASMT, { origin: "http://test.local" });
    expect(session.attemptId).toBe(ATT);
    expect(session.status).toBe("in_progress");
    expect(session.questions).toHaveLength(1);
    expect(session.questions[0]?.content.options).toHaveLength(2);
    expect(session.takeover).toBeUndefined();
  });

  it("201 พร้อม takeover = true (lease หมดอายุ ฝั่ง RPC อนุญาต)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(201, sessionPayload({ takeover: true }))));
    const session = await startAttempt(ASMT, { origin: "http://test.local" });
    expect(session.takeover).toBe(true);
  });

  it("คีย์เกินสัญญา (strict) = fail-closed เป็น ERR-SYS-001", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(201, sessionPayload({ hacky: 1 }))));
    await expect(startAttempt(ASMT, { origin: "http://test.local" })).rejects.toMatchObject({
      code: "ERR-SYS-001",
    });
  });

  it("409 ERR-ASM-002 (มี attempt ค้าง) = ExamApiError code ถูกต้อง (ธง D37-6)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, { error: { code: "ERR-ASM-002", message: "มีการสอบที่ยังไม่จบอยู่แล้ว" } }),
      ),
    );
    const error = await startAttempt(ASMT, { origin: "http://test.local" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExamApiError);
    expect((error as ExamApiError).code).toBe("ERR-ASM-002");
    expect((error as ExamApiError).status).toBe(409);
  });

  it("network fail = ERR-SYS-001 status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const error = await startAttempt(ASMT, { origin: "http://test.local" }).catch(
      (e: unknown) => e,
    );
    expect((error as ExamApiError).code).toBe("ERR-SYS-001");
    expect((error as ExamApiError).status).toBe(0);
  });

  it("ฝั่ง server (มี origin) ส่ง header x-ltc-bff-internal · ฝั่ง browser ไม่ส่ง", async () => {
    const serverFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(201, sessionPayload()),
    );
    vi.stubGlobal("fetch", serverFetch);
    await startAttempt(ASMT, { origin: "http://test.local" });
    const init = serverFetch.mock.calls[0]?.[1];
    expect(((init?.headers ?? {}) as Record<string, string>)["x-ltc-bff-internal"]).toBe("1");
  });
});

describe("saveAttemptAnswer", () => {
  it("body มีเฉพาะ questionId + choiceIds + clientSavedAt และคืน savedAt จาก server", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { data: { savedAt: "2026-09-10T08:00:05+07:00" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await saveAttemptAnswer(ATT, Q1, [OPT_A], { origin: "http://test.local" });
    expect(result.savedAt).toBe("2026-09-10T08:00:05+07:00");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["choiceIds", "clientSavedAt", "questionId"]);
    expect(body.questionId).toBe(Q1);
    expect(body.choiceIds).toEqual([OPT_A]);
    expect(typeof body.clientSavedAt).toBe("string");
  });

  it("ตอบไม่ตรงสัญญา (savedAt หาย) = fail-closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: {} })),
    );
    await expect(
      saveAttemptAnswer(ATT, Q1, [OPT_A], { origin: "http://test.local" }),
    ).rejects.toMatchObject({ code: "ERR-SYS-001" });
  });
});

describe("submitAttempt", () => {
  it("ส่ง header Idempotency-Key (uuid) + body unansweredQuestionIds เท่านั้น", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          attemptId: ATT,
          status: "passed",
          scorePct: 80,
          passed: true,
          questionCount: 1,
          totalPoints: 10,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await submitAttempt(ATT, [Q1], "99000000-0000-4000-8000-000000000009", {
      origin: "http://test.local",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(init.headers["idempotency-key"]).toBe("99000000-0000-4000-8000-000000000009");
    expect(JSON.parse(init.body)).toEqual({ unansweredQuestionIds: [Q1] });
  });

  it("ธง lead ข้อ 4: submit ไม่ parse คะแนนที่ client - resolve เป็น void แม้ body มีคะแนน", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: { scorePct: 99, passed: true } })),
    );
    const result = await submitAttempt(ATT, [], "99000000-0000-4000-8000-000000000009", {
      origin: "http://test.local",
    });
    expect(result).toBeUndefined();
  });
});
