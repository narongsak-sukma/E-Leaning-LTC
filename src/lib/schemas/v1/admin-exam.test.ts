/**
 * admin-exam.test — unit test ของ contract หลังบ้านฝั่งข้อสอบ (Wave D · D-3)
 *
 * อ้าง enum/constraint จาก migration จริง (0001 L110-L120 · 0005 L66-L86) —
 * ทุก schema strict (key แปลกปลอมรวมถึง "status" ของ questions/assessments → ERR-VAL-001)
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../../errors";
import {
  ADMIN_ASSESSMENT_STATUSES,
  ADMIN_QUESTION_STATUSES,
  AdminAssessmentResource,
  AssessmentCreateBody,
  AssessmentRuleInput,
  mapAdminExamDbError,
  parseAdminAssessmentsQuery,
  parseAdminExam,
  QuestionBankCreateBody,
  QuestionBankCreateResult,
  QuestionOptionInput,
  QuestionPatchBody,
  QuestionPatchParams,
  QuestionResource,
  toAdminAssessmentResource,
  toQuestionBankResource,
  toQuestionResource,
  type AdminAssessmentRow,
  type QuestionBankRow,
  type QuestionRow,
} from "./admin-exam";

/** ตัวอย่างกติกาที่ผ่านทุก constraint ของ 0005 (time 5-480 · pass 1-100 · attempts > 0) */
const VALID_RULE = {
  passPct: 70,
};

const VALID_OPTION = { optionText: "ตัวเลือกก", isCorrect: true, sortOrder: 0 };

const VALID_QUESTION = {
  type: "single_choice",
  questionText: "ข้อสอบตัวอย่าง",
  options: [VALID_OPTION, { optionText: "ตัวเลือกข", isCorrect: false, sortOrder: 1 }],
};

/** body ขั้นต่ำของ POST /admin/assessments */
function minAssessment(): Record<string, unknown> {
  return {
    courseId: "c0000000-0000-4000-8000-000000000001",
    code: "FIN-01",
    title: "สอบจบหลักสูตร",
  };
}

describe("AssessmentCreateBody / AssessmentRuleInput — POST /admin/assessments", () => {
  it("รับขั้นต่ำ (courseId, code, title) และใส่ default ของกติกาให้ครบ", () => {
    const parsed = AssessmentCreateBody.parse({
      courseId: "c0000000-0000-4000-8000-000000000001",
      code: "FIN-01",
      title: "สอบจบหลักสูตร",
      rules: VALID_RULE,
    });
    expect(parsed.rules?.timeLimitMinutes).toBe(60);
    expect(parsed.rules?.questionCount).toBe(30);
    expect(parsed.rules?.maxAttempts).toBe(3);
    expect(parsed.rules?.attemptCooldownMinutes).toBe(1440);
    expect(parsed.rules?.shuffleQuestions).toBe(true);
    expect(parsed.rules?.proctoringMode).toBe("basic");
  });

  it("strict — ห้ามรับ status จาก body (server-controlled 'draft')", () => {
    expect(() =>
      AssessmentCreateBody.parse({
        courseId: "c0000000-0000-4000-8000-000000000001",
        code: "FIN-01",
        title: "สอบ",
        status: "published",
      }),
    ).toThrow();
  });

  it("timeLimitMinutes นอกช่วง 5-480 → ไม่ผ่าน (0005 L70)", () => {
    for (const bad of [4, 481, 60.5]) {
      expect(() =>
        AssessmentCreateBody.parse({ ...minAssessment(), rules: { ...VALID_RULE, timeLimitMinutes: bad } }),
      ).toThrow();
    }
  });

  it("passPct นอกช่วง 1-100 → ไม่ผ่าน · ไม่มี default ตาม DB (0005 L72)", () => {
    expect(() => AssessmentRuleInput.parse({})).toThrow();
    expect(() => AssessmentRuleInput.parse({ passPct: 0 })).toThrow();
    expect(() => AssessmentRuleInput.parse({ passPct: 101 })).toThrow();
  });
});

describe("QuestionPatchBody — PATCH ข้อสอบ", () => {
  it("รับเฉพาะฟิลด์เนื้อหา + options (ผู้แต่งใส่ is_correct ตอนแก้ได้)", () => {
    const parsed = QuestionPatchBody.parse({
      questionText: "โจทย์แก้ไข",
      points: 2,
      tags: ["กฎหมาย"],
      options: [VALID_OPTION, { optionText: "ตัวเลือกข", isCorrect: false, sortOrder: 1 }],
    });
    expect(parsed.questionText).toBe("โจทย์แก้ไข");
    expect(parsed.options?.[0]?.isCorrect).toBe(true);
    expect(parsed.options?.[1]?.id).toBeUndefined();
  });

  it("strict — ส่ง status มา → ไม่ผ่าน (schema ไม่มีฟิลด์นี้)", () => {
    expect(() => QuestionPatchBody.parse({ status: "active" })).toThrow();
  });

  it("id ของ option ต้องเป็น uuid (มี id = แก้แถวเดิม)", () => {
    expect(() => QuestionOptionInput.parse({ ...VALID_OPTION, id: "nope" })).toThrow();
  });
});

describe("QuestionBankCreateBody — POST /admin/question-banks", () => {
  it("รับ bank + ข้อสอบเริ่มต้น (options พร้อม is_correct)", () => {
    const parsed = QuestionBankCreateBody.parse({
      code: "BANK-01",
      name: "ธนาคารข้อสอบกฎหมายทั่วไป",
      questions: [VALID_QUESTION],
    });
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions?.[0]?.difficulty).toBe("medium");
    expect("status" in (parsed.questions?.[0] ?? {})).toBe(false);
  });

  it("strict — ข้อสอบส่ง status มา → ไม่ผ่าน (สร้างเป็น draft เสมอ)", () => {
    expect(() =>
      QuestionBankCreateBody.parse({
        code: "BANK-01",
        name: "ธนาคาร",
        questions: [{ ...VALID_QUESTION, status: "active" }],
      }),
    ).toThrow();
  });
});

describe("QuestionPatchParams + parseAdminExam — path params", () => {
  it("ผิดรูปแบบ uuid → ERR-VAL-001 + fields", () => {
    try {
      parseAdminExam(QuestionPatchParams, { bankId: "x", questionId: "y" });
      throw new Error("should_not_reach");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const err = error as AppError;
      expect(err.code).toBe("ERR-VAL-001");
      expect(err.details?.["fields"]).toContain("bankId");
    }
  });
});

describe("parseAdminAssessmentsQuery — GET /admin/assessments", () => {
  it("limit/cursor + ฟิลเตอร์ status/courseId", () => {
    const params = new URLSearchParams("limit=5&cursor=abc&status=draft&courseId=c0000000-0000-4000-8000-000000000001");
    const parsed = parseAdminAssessmentsQuery(params);
    expect(parsed.limit).toBe(5);
    expect(parsed.cursor).toBe("abc");
    expect(parsed.status).toBe("draft");
  });

  it("limit เกิน 100 / status นอก enum / key แปลกปลอม → ERR-VAL-001", () => {
    for (const q of ["limit=101", "status=review", "bogus=1"]) {
      try {
        parseAdminAssessmentsQuery(new URLSearchParams(q));
        throw new Error("should_not_reach");
      } catch (error) {
        expect((error as AppError).code).toBe("ERR-VAL-001");
      }
    }
  });
});

describe("mapAdminExamDbError — PostgrestError → ทะเบียน error", () => {
  it("42501 (RLS WITH CHECK) → ERR-RBAC-001 403", () => {
    const err = mapAdminExamDbError({ code: "42501" });
    expect(err.code).toBe("ERR-RBAC-001");
    expect(err.httpStatus).toBe(403);
  });

  it("class 42 อื่น → ERR-RBAC-001", () => {
    expect(mapAdminExamDbError({ code: "42P01" }).code).toBe("ERR-RBAC-001");
  });

  it("23505/23514 (unique/check) และ P0001 (raise ของ guard/trigger) → ERR-VAL-001 400", () => {
    expect(mapAdminExamDbError({ code: "23505" }).code).toBe("ERR-VAL-001");
    expect(mapAdminExamDbError({ code: "23514" }).code).toBe("ERR-VAL-001");
    expect(mapAdminExamDbError({ code: "P0001" }).code).toBe("ERR-VAL-001");
  });

  it("code อื่น → ERR-SYS-002 503 แบบ opaque", () => {
    const err = mapAdminExamDbError({ code: "XX999" });
    expect(err.code).toBe("ERR-SYS-002");
    expect(err.httpStatus).toBe(503);
  });
});

describe("mappers — response ไม่มี is_correct เด็ดขาด", () => {
  const RULE = {
    version: 2,
    pass_pct: 70,
    time_limit_minutes: 90,
    question_count: 30,
    max_attempts: 3,
    attempt_cooldown_minutes: 1440,
    shuffle_questions: true,
    shuffle_options: true,
    proctoring_mode: "basic",
    effective_from: "2026-09-01T00:00:00+00:00",
  };

  it("toAdminAssessmentResource — createdBy จาก course embed + กติกาล่าสุด + passPct (grant 0019)", () => {
    const row = {
      id: "d0000000-0000-4000-8000-000000000001",
      code: "FIN-01",
      title: "สอบจบ",
      description: null,
      course_id: "c0000000-0000-4000-8000-000000000001",
      is_final: true,
      status: "draft",
      created_at: "2026-09-01T00:00:00+00:00",
      course: { id: "c0000000-0000-4000-8000-000000000001", created_by: "a0000000-0000-4000-8000-000000000009" },
      assessment_rules: [RULE],
    } as unknown as AdminAssessmentRow;
    const resource = toAdminAssessmentResource(row);
    expect(resource.createdBy).toBe("a0000000-0000-4000-8000-000000000009");
    expect(resource.rules?.timeLimitMinutes).toBe(90);
    expect(resource.rules?.passPct).toBe(70);
    expect(JSON.stringify(resource).includes("passPct")).toBe(true);
    expect(() => AdminAssessmentResource.parse(resource)).not.toThrow();
  });

  it("toQuestionBankResource — นับจำนวนข้อจาก embed count (embed ว่าง = 0)", () => {
    const row = {
      id: "b0000000-0000-4000-8000-000000000001",
      code: "BANK-01",
      name: "ธนาคารกฎหมายทั่วไป",
      description: null,
      course_id: null,
      category_id: null,
      is_active: true,
      created_at: "2026-09-01T00:00:00+00:00",
      questions: [{ count: 12 }],
    } as unknown as QuestionBankRow;
    const resource = toQuestionBankResource(row);
    expect(resource.questionCount).toBe(12);
    expect(JSON.stringify(resource).includes("is_correct")).toBe(false);
  });

  it("toQuestionResource — options ไม่มี is_correct ทั้ง JSON ของ resource", () => {
    const row = {
      id: "d0000000-0000-4000-8000-000000000001",
      bank_id: "b0000000-0000-4000-8000-000000000001",
      type: "single_choice",
      difficulty: "medium",
      question_text: "โจทย์",
      explanation: null,
      points: 1,
      status: "draft",
      tags: [],
      version: 3,
      created_at: "2026-09-01T00:00:00+00:00",
      question_options: [
        { id: "e0000000-0000-4000-8000-000000000001", option_text: "ตัวเลือกก", sort_order: 0 },
      ],
    } as unknown as QuestionRow;
    const resource = toQuestionResource(row);
    expect(resource.version).toBe(3);
    expect(resource.options[0]?.optionText).toBe("ตัวเลือกก");
    const json = JSON.stringify(resource);
    expect(json.includes("is_correct")).toBe(false);
    expect(json.includes("isCorrect")).toBe(false);
    expect(() => QuestionResource.parse(resource)).not.toThrow();
  });

  it("QuestionBankCreateResult — bank + รายการข้อที่สร้าง (ไม่มี is_correct)", () => {
    const resource = QuestionBankCreateResult.parse({
      id: "b0000000-0000-4000-8000-000000000001",
      code: "BANK-01",
      name: "ธนาคาร",
      description: null,
      courseId: null,
      categoryId: null,
      isActive: true,
      questionCount: 1,
      createdAt: "2026-09-01T00:00:00+00:00",
      questions: [
        { id: "d0000000-0000-4000-8000-000000000001", type: "single_choice", questionText: "โจทย์", points: 1 },
      ],
    });
    expect(resource.questions).toHaveLength(1);
    expect(JSON.stringify(resource).includes("isCorrect")).toBe(false);
  });

  it("enum ตรง migration จริง — assessment_status ไม่มี 'review' · question_status 3 ค่า", () => {
    expect(ADMIN_ASSESSMENT_STATUSES.includes("review" as never)).toBe(false);
    expect(ADMIN_QUESTION_STATUSES).toEqual(["draft", "active", "retired"]);
  });
});
