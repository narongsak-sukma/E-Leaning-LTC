/**
 * exam-answers.test — unit test ตัวบันทึกคำตอบอัตโนมัติ (autosave)
 *
 * - คลิกแรกของแต่ละข้อ = บันทึกทันที (DS 7.1) · ครั้งถัดไปห่างขั้นต่ำ 10 วิ/ข้อ
 *   (API-SPECIFICATION 5 หมายเหตุ 3)
 * - เปลี่ยนคำตอบระหว่างบันทึกอยู่ = ตั้ง dirty แล้วบันทึกซ้ำอัตโนมัติหลังรอบแรกจบ
 * - บันทึกไม่สำเร็จ = error flag + dirty ค้าง (คำตอบยังอยู่ในหน้า ธง D37-6 ก)
 * - flushAll ก่อนส่ง: ข้าม throttle เสมอ · สำเร็จครบ = true / มีค้าง = false
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExamAnswerSaver,
  type ExamAnswerSaverDeps,
  type ExamAnswerSnapshot,
} from "./exam-answers";
import { ExamApiError } from "./exam-api";

const Q1 = "30000000-0000-4000-8000-000000000001";
const Q2 = "30000000-0000-4000-8000-000000000002";
const A = "40000000-0000-4000-8000-00000000000a";
const B = "40000000-0000-4000-8000-00000000000b";

function makeDeps(
  saveImpl: (questionId: string, choiceIds: readonly string[]) => Promise<{ savedAt: string }>,
  state: { snapshots: ExamAnswerSnapshot[] },
): ExamAnswerSaverDeps {
  return {
    // Date.now ถูก mock ร่วมกับ setTimeout โดย vi.useFakeTimers - throttle จึงเดินตามเวลาจริงของเทสต์
    now: () => Date.now(),
    save: saveImpl,
    onStateChange: (snapshot) => {
      state.snapshots.push(snapshot);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createExamAnswerSaver", () => {
  it("คลิกแรกของข้อ = บันทึกทันที (ไม่รอ 10 วิ)", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:00+07:00" };
      }, state),
    );
    saver.toggle(Q1, A);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([[Q1, [A]]]);
    expect(state.snapshots.at(-1)?.[Q1]?.savedAt).toBe("2026-09-10T08:00:00+07:00");
  });

  it("เปลี่ยนคำตอบซ้ำในช่วงสั้น ๆ = throttle ที่ 10 วิ/ข้อ แล้วบันทึกค่าล่าสุด", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:01+07:00" };
      }, state),
    );
    saver.toggle(Q1, A); // ทันที
    await vi.advanceTimersByTimeAsync(0);
    saver.toggle(Q1, B); // ทับใน 10 วิ → ตั้ง timer
    await vi.advanceTimersByTimeAsync(9_999);
    expect(saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual([Q1, [A, B]]);
    saver.dispose();
  });

  it("toggle ระหว่างช่วง throttle = emit snapshot ทันทีที่คลิก (UI controlled ห้ามค้าง)", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:07+07:00" };
      }, state),
    );
    saver.toggle(Q1, A);
    await vi.advanceTimersByTimeAsync(0);
    const emitsBefore = state.snapshots.length;
    saver.toggle(Q1, B); // ยังอยู่ในหน้าต่าง 10 วิ — ต้องเห็น [A, B] ทันที ไม่รอ timer
    expect(state.snapshots.length).toBe(emitsBefore + 1);
    expect(state.snapshots.at(-1)?.[Q1]?.choiceIds).toEqual([A, B]);
    saver.dispose();
  });

  it("ถอดตัวเลือกสุดท้าย = no-op (สัญญา API ขั้นต่ำ 1 ตัวเลือก/ข้อ — ห้ามส่ง [])", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:10+07:00" };
      }, state),
    );
    saver.toggle(Q1, A);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([[Q1, [A]]]);
    const emitsBefore = state.snapshots.length;
    saver.toggle(Q1, A); // ถอดตัวสุดท้าย → ต้องเป็น no-op
    expect(state.snapshots.length).toBe(emitsBefore);
    expect(state.snapshots.at(-1)?.[Q1]?.choiceIds).toEqual([A]);
    expect(saver.hasUnsaved()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toHaveLength(1); // ไม่มีการบันทึก [] ขึ้น server เด็ดขาด
    saver.dispose();
  });

  it("ข้อต่างกัน throttle แยกกัน (คลิกแรกของ Q2 ก็ทันที)", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [], [Q2]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:02+07:00" };
      }, state),
    );
    saver.toggle(Q1, A);
    saver.toggle(Q2, B);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([
      [Q1, [A]],
      [Q2, [B]],
    ]);
    saver.dispose();
  });

  it("เปลี่ยนคำตอบระหว่างบันทึกค้างอยู่ = dirty ค้างแล้วบันทึกซ้ำหลังรอบแรกจบ", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    let releaseFirst: ((v: { savedAt: string }) => void) | null = null;
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        if (saves.length === 0) {
          saves.push([q, c]);
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:03+07:00" };
      }, state),
    );
    saver.toggle(Q1, A); // รอบแรกค้าง (inflight)
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(1);
    saver.toggle(Q1, B); // ระหว่าง inflight → dirty
    expect(saves).toHaveLength(1);
    // อ่านผ่าน closure (narrowing ไม่ทะลุขอบเขตฟังก์ชัน - TS จะไม่ตีความว่าเป็น null เสมอ)
    const getRelease = (): ((v: { savedAt: string }) => void) | null => releaseFirst;
    getRelease()?.({ savedAt: "2026-09-10T08:00:04+07:00" });
    // รอบแรกจบ → dirty ถูกตั้งเวลาบันทึกซ้ำตาม throttle "ห่างขั้นต่ำ 10 วิ/ข้อ" จากครั้งล่าสุด
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual([Q1, [A, B]]);
    expect(saver.hasUnsaved()).toBe(false);
    saver.dispose();
  });

  it("บันทึกไม่สำเร็จ = error flag + dirty ค้าง (คำตอบยังอยู่ในหน้า)", async () => {
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async () => {
        throw new Error("network down");
      }, state),
    );
    saver.toggle(Q1, A);
    await vi.advanceTimersByTimeAsync(0);
    const item = state.snapshots.at(-1)?.[Q1];
    expect(item?.error).toBe(true);
    expect(item?.saving).toBe(false);
    expect(item?.choiceIds).toEqual([A]);
    expect(saver.hasUnsaved()).toBe(true);
    saver.dispose();
  });

  it("flushAll: ข้าม throttle บันทึกทุกข้อค้าง แล้วคืน true เมื่อสะอาด", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [], [Q2]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:05+07:00" };
      }, state),
    );
    saver.toggle(Q1, A); // ทันที Q1
    await vi.advanceTimersByTimeAsync(0);
    saver.toggle(Q1, B); // dirty รอ timer
    saver.toggle(Q2, A); // คลิกแรกของ Q2 = ทันทีเช่นกัน
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(2);
    const clean = await saver.flushAll();
    expect(clean).toEqual({ ok: true });
    // Q1 ถูกบันทึกซ้ำอีกครั้งหลัง flush (Q2 สะอาดแล้วจึงไม่บันทึกซ้ำ)
    expect(saves).toHaveLength(3);
    expect(saves.some(([q, c]) => q === Q1 && c.length === 2 && c[1] === B)).toBe(true);
    expect(saver.hasUnsaved()).toBe(false);
    saver.dispose();
  });

  it("flushAll: บันทึกไม่สำเร็จ = คืน false (ผู้เรียนยังกดส่งได้ แต่รู้ว่ามีค้าง)", async () => {
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async () => {
        throw new Error("still down");
      }, state),
    );
    saver.toggle(Q1, A);
    await vi.advanceTimersByTimeAsync(0);
    const clean = await saver.flushAll();
    expect(clean).toEqual({ ok: false, terminalCode: null });
    saver.dispose();
  });

  it("flushAll ระหว่างมี request ค้าง + คำตอบใหม่ = บันทึกค่าล่าสุดทันที คืน true (ไม่รอ timer)", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    let releaseFirst: ((v: { savedAt: string }) => void) | null = null;
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        if (saves.length === 0) {
          saves.push([q, c]);
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:08+07:00" };
      }, state),
    );
    saver.toggle(Q1, A); // รอบแรกค้าง (inflight)
    await vi.advanceTimersByTimeAsync(0);
    saver.toggle(Q1, B); // dirty ระหว่าง inflight
    const flushPromise = saver.flushAll();
    const getRelease = (): ((v: { savedAt: string }) => void) | null => releaseFirst;
    getRelease()?.({ savedAt: "2026-09-10T08:00:09+07:00" });
    const clean = await flushPromise;
    expect(clean).toEqual({ ok: true });
    expect(saves[1]).toEqual([Q1, [A, B]]);
    expect(saver.hasUnsaved()).toBe(false);
    saver.dispose();
  });

  it.each(["ERR-ASM-004", "ERR-ASM-005"] as const)(
    "terminal %s จากการบันทึก = flushAll ส่งรหัสต่อทันที ไม่ลองซ้ำ ไม่ติด dirty",
    async (code) => {
      let saveCalls = 0;
      const state = { snapshots: [] as ExamAnswerSnapshot[] };
      const saver = createExamAnswerSaver(
        { [Q1]: [] },
        makeDeps(async () => {
          saveCalls += 1;
          throw new ExamApiError(code, 409, "จำลอง terminal จาก BFF");
        }, state),
      );
      saver.toggle(Q1, A);
      await vi.advanceTimersByTimeAsync(0);
      const first = await saver.flushAll();
      expect(first).toEqual({ ok: false, terminalCode: code });
      // flush ซ้ำ = short-circuit ด้วย terminal เดิม ห้ามยิงเพิ่ม
      const second = await saver.flushAll();
      expect(second).toEqual({ ok: false, terminalCode: code });
      expect(saveCalls).toBeLessThanOrEqual(2);
      expect(saver.hasUnsaved()).toBe(false);
      expect(state.snapshots.at(-1)?.[Q1]?.choiceIds).toEqual([A]);
      saver.dispose();
    },
  );

  it("terminal ที่ข้อหนึ่ง = ยกเลิก timer ของทุกข้อ + toggle/flush หลังจากนั้นห้ามยิงเพิ่ม", async () => {
    let saveCalls = 0;
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [], [Q2]: [] },
      makeDeps(async (q) => {
        saveCalls += 1;
        if (q === Q2) {
          throw new ExamApiError("ERR-ASM-004", 409, "หมดเวลาสอบ");
        }
        return { savedAt: "2026-09-10T08:00:11+07:00" };
      }, state),
    );
    saver.toggle(Q1, A); // save#1 สำเร็จทันที
    await vi.advanceTimersByTimeAsync(0);
    saver.toggle(Q1, B); // ในหน้าต่าง throttle → ติดตั้ง timer 10 วิค้างไว้
    saver.toggle(Q2, A); // save#2 → terminal 004
    await vi.advanceTimersByTimeAsync(0);
    const flush = await saver.flushAll();
    expect(flush).toEqual({ ok: false, terminalCode: "ERR-ASM-004" });
    expect(saveCalls).toBe(2);
    // timer ของ Q1 ต้องถูกยกเลิกไปแล้ว — ปล่อยเวลาผ่านไป 60 วิ ห้ามมี request ใหม่
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveCalls).toBe(2);
    // toggle หลัง terminal: อัปเดตคำตอบในหน้าได้ แต่ห้ามยิงบันทึก
    saver.toggle(Q1, A); // [A, B] → [B]
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveCalls).toBe(2);
    expect(state.snapshots.at(-1)?.[Q1]?.choiceIds).toEqual([B]);
    expect(saver.hasUnsaved()).toBe(false);
    saver.dispose();
  });

  it("dispose: ยกเลิก timer ค้าง ไม่ emit ต่อ", async () => {
    const saves: Array<[string, readonly string[]]> = [];
    const state = { snapshots: [] as ExamAnswerSnapshot[] };
    const saver = createExamAnswerSaver(
      { [Q1]: [] },
      makeDeps(async (q, c) => {
        saves.push([q, c]);
        return { savedAt: "2026-09-10T08:00:06+07:00" };
      }, state),
    );
    saver.toggle(Q1, A);
    await vi.advanceTimersByTimeAsync(0);
    saver.toggle(Q1, B); // ตั้ง timer รอบที่สอง
    saver.dispose();
    const snapshotsBefore = state.snapshots.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toHaveLength(1);
    expect(state.snapshots.length).toBe(snapshotsBefore);
  });
});
