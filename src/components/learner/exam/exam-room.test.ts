/**
 * exam-room.test (PB-18) — ชนิดข้อในห้องสอบ: radio สำหรับข้อเลือกเดียว
 *
 * ครอบพฤติกรรมตามที่ component สัญญาไว้ในหัวไฟล์ (ส่วนชนิดข้อ):
 * - multiple_choice → input checkbox หลายอันเหมือนเดิม (ไม่มีคำแนะนำ เลือกได้ข้อเดียว)
 * - single_choice / true_false → input radio + name ต่อข้อ + คำแนะนำ "เลือกได้ข้อเดียว"
 *   (a11y/e2e คงแบบแผนเดิม: fieldset + label ครอบ input — .check() ใช้ได้ทั้งสองชนิด)
 * - ข้อเลือกเดียว: เลือกใหม่ = แทนที่ตัวเดิม (replace แทน append) ผ่าน setSingle
 *   ของเอนจิ้น autosave (atomic — gate p0-r1 MAJOR-1) — พิสูจน์กับเอนจิ้นจริง
 *   (createExamAnswerSaver) ว่าทุก payload ที่บันทึกขึ้น server เป็น [ตัวเดียว]
 *   ตรงกับที่ผู้เรียนเห็นบนจอเสมอ ไม่มีค่า transient สองตัวหลุดขึ้นไป
 *
 * หมายเหตุการทดสอบใน node env (ไม่มี DOM): ตามแบบแผน logout-button.test.ts +
 * (learner)/error.test.ts — เรนเดอร์ด้วย renderToStaticMarkup โดย shim useState
 * (ค่าเริ่มต้นต่อ slot ตามลำดับ hook ของ ExamRoom) · useEffect เป็น no-op (phase
 * "ready" อ่าน session จาก slot โดยตรง ไม่ผ่านแคชชุดข้อ) · useRouter/Link เป็น stub
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/** ตัวยึดตำแหน่งของ useState — vi.mock ถูก hoist ก่อนประกาศตัวแปรระดับ module */
const stateShim = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  useState: (initial: unknown): unknown => [initial, (): void => {}],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // slot ตามลำดับ useState ของ ExamRoom: phase, session, answers, currentIdx,
    // flags, remainingMs, dialogOpen, idempotencyKey
    useState: (initial: unknown): unknown => stateShim.useState(initial),
    // ไม่รันเอฟเฟกต์ (อ่านแคช/นาฬิกา) — เทสเรนเดอร์สถานะ ready จาก slot โดยตรง
    useEffect: (): void => {},
  };
});

vi.mock("next/navigation", () => ({
  useRouter: (): { replace: (url: string) => void } => ({ replace: (): void => {} }),
}));

vi.mock("next/link", () => ({
  default: (): null => null,
}));

import { ExamRoom } from "./exam-room";
import { createExamAnswerSaver, type ExamAnswerSaver, type ExamAnswerSnapshot } from "@/lib/exam/exam-answers";
import type { ExamPaperQuestionType, ExamPaperSession } from "@/lib/exam/exam-api";

/** ติดตั้ง useState จำลอง — อ่านค่าจาก slot ตามลำดับการเรียก (ไม่มี slot = ค่าเริ่มต้นจริง) */
stateShim.useState = (initial: unknown): unknown => {
  const value = stateShim.slots[stateShim.cursor] ?? initial;
  stateShim.cursor += 1;
  return [value, (): void => {}];
};

const ATT = "10000000-0000-4000-8000-000000000001";
const Q1 = "30000000-0000-4000-8000-000000000001";
const OPT_A = "40000000-0000-4000-8000-00000000000a";
const OPT_B = "40000000-0000-4000-8000-00000000000b";

/** ชุดข้อ 1 ข้อ 2 ตัวเลือก ตามชนิดที่กำหนด (parse ผ่าน contract ของ exam-api เสมอ) */
function sessionOf(questionType: ExamPaperQuestionType): ExamPaperSession {
  return {
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
        content: {
          version: 1,
          text: "โจทย์ข้อที่ 1",
          options: [
            { id: OPT_A, text: "ก" },
            { id: OPT_B, text: "ข" },
          ],
          type: questionType,
        },
      },
    ],
  };
}

/** เรนเดอร์ห้องสอบสถานะ ready — คืน HTML เป็น string สำหรับตรวจ input/คำแนะนำ */
function renderRoomHtml(questionType: ExamPaperQuestionType): string {
  stateShim.slots = [
    { kind: "ready" },
    sessionOf(questionType),
    {},
    0,
    {},
    60_000,
    false,
    "00000000-0000-4000-8000-000000000009",
  ];
  stateShim.cursor = 0;
  return renderToStaticMarkup(createElement(ExamRoom, { attemptId: ATT }));
}

afterEach(() => {
  stateShim.slots = [];
  stateShim.cursor = 0;
});

describe("ห้องสอบเรนเดอร์ input ตามชนิดข้อ (PB-18)", () => {
  it("multiple_choice = checkbox ทุกตัวเลือก ไม่มีคำแนะนำ (คงพฤติกรรมเดิมเป๊ะ)", () => {
    const html = renderRoomHtml("multiple_choice");
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("เลือกได้ข้อเดียว");
  });

  it("single_choice = radio + name ต่อข้อ + คำแนะนำ เลือกได้ข้อเดียว", () => {
    const html = renderRoomHtml("single_choice");
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('type="checkbox"');
    expect((html.match(new RegExp(`name="exam-choice-${Q1}"`, "g")) ?? []).length).toBe(2);
    expect(html).toContain("เลือกได้ข้อเดียว");
  });

  it("true_false = radio เหมือน single_choice", () => {
    const html = renderRoomHtml("true_false");
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("เลือกได้ข้อเดียว");
  });

  it("a11y คงแบบแผนเดิม: fieldset/legend + label ครอบ input ทุกชนิด (e2e ใช้ label locator)", () => {
    for (const questionType of ["multiple_choice", "single_choice", "true_false"] as const) {
      const html = renderRoomHtml(questionType);
      expect(html).toContain("<fieldset");
      expect(html).toContain("<legend");
      expect((html.match(/<label/g) ?? []).length).toBe(2);
    }
  });
});

/** เอนจิ้น autosave จริง + บันทึกว่า save ถูกเรียกด้วยชุด choiceIds ใด */
function makeSaver(initial: Readonly<Record<string, readonly string[]>>): {
  readonly saver: ExamAnswerSaver;
  readonly saves: { questionId: string; choiceIds: readonly string[] }[];
  readonly snapshot: { current: ExamAnswerSnapshot };
} {
  const saves: { questionId: string; choiceIds: readonly string[] }[] = [];
  const snapshot: { current: ExamAnswerSnapshot } = { current: {} };
  const saver = createExamAnswerSaver(initial, {
    now: () => 1_000_000,
    save: async (questionId, choiceIds) => {
      saves.push({ questionId, choiceIds });
      return { savedAt: "2026-09-12T00:00:00+07:00" };
    },
    onStateChange: (state) => {
      snapshot.current = state;
    },
  });
  return { saver, saves, snapshot };
}

describe("setSingle ของเอนจิ้น autosave (onChange ของข้อเลือกเดียว) — เลือกใหม่ = แทนที่แบบ atomic (PB-18/gate p0-r1 MAJOR-1)", () => {
  it("เลือก B ทับ A: บันทึก [B] ครั้งเดียว — ทุก payload ยาว 1 ตัว ไม่มี [A,B] หลุดขึ้น server", async () => {
    const { saver, saves, snapshot } = makeSaver({ [Q1]: [OPT_A] });
    saver.setSingle(Q1, OPT_B);
    await saver.flushAll();
    expect(snapshot.current[Q1]?.choiceIds).toEqual([OPT_B]);
    expect(saves).toEqual([{ questionId: Q1, choiceIds: [OPT_B] }]);
    for (const save of saves) {
      expect(save.choiceIds).toHaveLength(1);
    }
    saver.dispose();
  });

  it("ยังไม่ได้เลือก ([]): เลือก B = บันทึก [B]", async () => {
    const { saver, saves, snapshot } = makeSaver({ [Q1]: [] });
    saver.setSingle(Q1, OPT_B);
    await saver.flushAll();
    expect(snapshot.current[Q1]?.choiceIds).toEqual([OPT_B]);
    expect(saves).toEqual([{ questionId: Q1, choiceIds: [OPT_B] }]);
    saver.dispose();
  });

  it("seed หลายตัวจาก takeover ([A,B]) แล้วคลิก B = ยุบเหลือ [B] ใน save เดียว", async () => {
    const { saver, saves, snapshot } = makeSaver({ [Q1]: [OPT_A, OPT_B] });
    saver.setSingle(Q1, OPT_B);
    await saver.flushAll();
    expect(snapshot.current[Q1]?.choiceIds).toEqual([OPT_B]);
    expect(saves).toEqual([{ questionId: Q1, choiceIds: [OPT_B] }]);
    saver.dispose();
  });

  it("คลิกตัวที่เลือกอยู่แล้ว (เลือกครบ 1 ตัว) = ไม่เปลี่ยนแปลง ไม่เรียก save", async () => {
    const { saver, saves } = makeSaver({ [Q1]: [OPT_B] });
    saver.setSingle(Q1, OPT_B);
    await saver.flushAll();
    expect(saves).toHaveLength(0);
    expect(saver.hasUnsaved()).toBe(false);
    saver.dispose();
  });
});
