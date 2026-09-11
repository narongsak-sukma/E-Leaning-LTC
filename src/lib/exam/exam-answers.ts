/**
 * exam-answers - เครื่องยนต์บันทึกคำตอบอัตโนมัติ (autosave) ที่ทดสอบได้
 *
 * สัญญา: ทุกครั้งที่ผู้เรียนเปลี่ยนคำตอบ ระบบพยายามบันทึกไป BFF ทันที (DS 7.1
 * "ทุกคลิกตัวเลือก = บันทึกทันที") โดยคุมช่วงห่างขั้นต่ำ 10 วินาทีต่อข้อตาม
 * API-SPECIFICATION 5 หมายเหตุ 3 (throttle ที่ client 10 วินาที/ข้อ - เป็น "ช่วงห่าง
 * ขั้นต่ำ" ไม่ใช่ "รอครบ 10 วิก่อนส่งครั้งแรก")
 *
 * state คำตอบอยู่ในหน้า (in-page) เท่านั้น - ไม่มี localStorage/sessionStorage และไม่มี
 * คิวข้าม reload ตามธง D37-6 (ก): reload กลางสอบ = ไม่มีทางเปิดกระดาษคืน
 *
 * terminal error (ERR-ASM-004 หมดเวลา / ERR-ASM-005 ถูกส่งแล้ว) จากการบันทึก =
 * attempt ปิดแล้วฝั่ง server บันทึกซ้ำไร้ความหมาย — เครื่องยนต์หยุดลองซ้ำแล้ว
 * ส่งรหัสต่อให้ห้องสอบ (flushAll) จัดการตามแต่ละรหัส ส่วน error อื่น (เช่น เน็ต
 * ขาด) ยังเป็นแบบชั่วคราว: dirty ค้าง รอบันทึกซ้ำ
 *
 * ไม่มีเฉลยในโมดูลนี้ทุกทาง - มีแต่ choiceIds ที่ผู้เรียนเลือก (ขาขึ้นอย่างเดียว)
 */
import { ExamApiError } from "./exam-api";

/** รหัส error ที่แปลว่า attempt จบแล้วฝั่ง server — บันทึกซ้ำไม่ได้ผล */
export type ExamTerminalCode = "ERR-ASM-004" | "ERR-ASM-005";

/** ผล flushAll ก่อนส่งข้อสอบ */
export type ExamFlushOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly terminalCode: ExamTerminalCode | null };

/** รหัสนี้เป็น terminal หรือไม่ (narrowing helper) */
function terminalCodeOf(error: unknown): ExamTerminalCode | null {
  if (error instanceof ExamApiError) {
    if (error.code === "ERR-ASM-004" || error.code === "ERR-ASM-005") {
      return error.code;
    }
  }
  return null;
}

/** ช่วงห่างขั้นต่ำของการ autosave ต่อข้อ (API-SPECIFICATION 5 หมายเหตุ 3) */
export const ANSWER_SAVE_MIN_INTERVAL_MS = 10_000;

/** สถานะบันทึกของข้อเดียว - UI อ่านจากตรงนี้ */
export interface ExamAnswerItemSnapshot {
  /** ตัวเลือกที่ผู้เรียนเลือกอยู่ */
  readonly choiceIds: readonly string[];
  /** กำลังบันทึกอยู่ */
  readonly saving: boolean;
  /** บันทึกล่าสุดไม่สำเร็จ - คำตอบยังอยู่ในหน้า รอบันทึกซ้ำตอนเปลี่ยนคำตอบหรือกดส่ง */
  readonly error: boolean;
  /** เวลา savedAt ล่าสุดจาก server (ISO) - null = ยังไม่เคยบันทึกสำเร็จในเซสชันนี้ */
  readonly savedAt: string | null;
}

/** snapshot ที่ UI อ่าน - Record ตาม questionId (ข้อที่ไม่มี = ยังไม่ตอบ) */
export type ExamAnswerSnapshot = Readonly<Record<string, ExamAnswerItemSnapshot>>;

export interface ExamAnswerSaverDeps {
  /** แหล่งเวลา client สำหรับวัด throttle - inject เพื่อการทดสอบ */
  readonly now: () => number;
  /** เรียก POST /attempts/{id}/answers - reject = บันทึกไม่สำเร็จ */
  readonly save: (
    questionId: string,
    choiceIds: readonly string[],
  ) => Promise<{ readonly savedAt: string }>;
  /** แจ้ง snapshot ทุกครั้งที่เปลี่ยน (UI เอาไป setState) */
  readonly onStateChange: (snapshot: ExamAnswerSnapshot) => void;
}

/** ตัวบันทึกคำตอบรายข้อ - หนึ่งอินสแตนซ์ต่อห้องสอบหนึ่งหน้า */
export interface ExamAnswerSaver {
  /** ผู้เรียนเปลี่ยนคำตอบ - เพิ่ม/ถอด choiceId (ข้อละ 1-10 ตัวเลือกตาม API-SPEC 4 #7) */
  toggle(questionId: string, choiceId: string): void;
  /**
   * บังคับบันทึกทุกข้อที่ยังไม่ถูกบันทึก (ก่อน submit) - ข้าม throttle เสมอ
   * ok=false + terminalCode = server ปิด attempt แล้ว (004/005) ให้ห้องสอบจัดการ
   * ok=false + terminalCode=null = ยังมีข้อบันทึกไม่สำเร็จแบบชั่วคราว (เช่น เน็ต)
   */
  flushAll(): Promise<ExamFlushOutcome>;
  /** มีข้อใดที่ยังมีการเปลี่ยนแปลงรอบันทึก */
  hasUnsaved(): boolean;
  /** ยกเลิก timer ทั้งหมด - เรียกตอน unmount */
  dispose(): void;
}

interface AnswerRuntime {
  choiceIds: string[];
  dirty: boolean;
  saving: boolean;
  error: boolean;
  savedAt: string | null;
  lastAttemptMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** เพิ่ม/ถอด choiceId ออกจากรายการที่เลือก (สลับ) - pure */
function applyToggle(current: readonly string[], choiceId: string): string[] {
  if (current.includes(choiceId)) {
    return current.filter((id) => id !== choiceId);
  }
  return [...current, choiceId];
}

/** สร้างตัวบันทึกคำตอบของห้องสอบหนึ่งหน้า */
export function createExamAnswerSaver(
  initial: Readonly<Record<string, readonly string[]>>,
  deps: ExamAnswerSaverDeps,
  minIntervalMs: number = ANSWER_SAVE_MIN_INTERVAL_MS,
): ExamAnswerSaver {
  const runtime = new Map<string, AnswerRuntime>();
  for (const [questionId, choiceIds] of Object.entries(initial)) {
    runtime.set(questionId, {
      choiceIds: [...choiceIds],
      dirty: false,
      saving: false,
      error: false,
      savedAt: null,
      lastAttemptMs: Number.NEGATIVE_INFINITY,
      timer: null,
    });
  }
  const inflight = new Map<string, Promise<void>>();
  let disposed = false;
  /** terminal แรกที่เจอ (ครั้งเดียวพอ) — ให้ flushAll ส่งต่อให้ห้องสอบทันที */
  let terminal: ExamTerminalCode | null = null;

  const emit = (): void => {
    if (disposed) {
      return;
    }
    const snapshot: Record<string, ExamAnswerItemSnapshot> = {};
    for (const [questionId, item] of runtime.entries()) {
      snapshot[questionId] = {
        choiceIds: [...item.choiceIds],
        saving: item.saving,
        error: item.error,
        savedAt: item.savedAt,
      };
    }
    deps.onStateChange(snapshot);
  };

  const attemptSave = (questionId: string): void => {
    if (terminal !== null) {
      // attempt ปิดแล้วฝั่ง server — บันทึกเพิ่มไร้ความหมาย (กันทุกทางเข้า:
      // timer ค้าง / toggle หลังเกิดเหตุ / รอบของ flush)
      return;
    }
    const item = runtime.get(questionId);
    if (item === undefined || item.saving || item.dirty === false) {
      return;
    }
    item.dirty = false;
    item.saving = true;
    item.lastAttemptMs = deps.now();
    emit();
    const choiceIds = [...item.choiceIds];
    const promise = deps
      .save(questionId, choiceIds)
      .then((result) => {
        item.saving = false;
        item.savedAt = result.savedAt;
        if (item.dirty) {
          markDirtyAndSchedule(item, questionId);
        }
        emit();
      })
      .catch((error: unknown) => {
        item.saving = false;
        item.error = true;
        const code = terminalCodeOf(error);
        if (code !== null) {
          // terminal: attempt ปิดแล้วฝั่ง server (หมดเวลา/ถูกส่งแล้ว) — บันทึกซ้ำ
          // ไร้ความหมาย จึงไม่ตั้ง dirty ให้วงรอบ retry ไปเอง (คำตอบยังอยู่ในหน้า)
          item.dirty = false;
          if (terminal === null) {
            terminal = code;
            // ยกเลิก timer + dirty ของทุกข้อทันที — ห้ามยิงเพิ่มอีกแม้ข้ออื่นกำลัง
            // รอ throttle อยู่ (attempt ปิดแล้วสำหรับทุกข้อ ไม่ใช่ข้อเดียว)
            for (const other of runtime.values()) {
              other.dirty = false;
              if (other.timer !== null) {
                clearTimeout(other.timer);
                other.timer = null;
              }
            }
          }
        } else {
          item.dirty = true;
        }
        emit();
      });
    inflight.set(questionId, promise);
  };

  const markDirtyAndSchedule = (item: AnswerRuntime, questionId: string): void => {
    item.dirty = true;
    if (item.saving || item.timer !== null) {
      return;
    }
    const elapsed = deps.now() - item.lastAttemptMs;
    if (elapsed >= minIntervalMs) {
      attemptSave(questionId);
      return;
    }
    item.timer = setTimeout(() => {
      item.timer = null;
      attemptSave(questionId);
    }, minIntervalMs - elapsed);
  };

  const toggle = (questionId: string, choiceId: string): void => {
    if (disposed) {
      return;
    }
    const item = runtime.get(questionId);
    if (item === undefined) {
      return;
    }
    const next = applyToggle(item.choiceIds, choiceId);
    if (next.length === 0) {
      // สัญญา API ขั้นต่ำ 1 ตัวเลือก/ข้อ (API-SPEC 4 #7 · zod min(1)) — ห้ามถอด
      // ตัวเลือกสุดท้ายจนเหลือ 0 เพราะบันทึก [] จะถูกปฏิเสธทุกครั้ง ทำให้ flush
      // ก่อนส่งติดค้างเป็น false และผู้เรียนแก้คำตอบไม่ได้ — เปลี่ยนคำตอบด้วย
      // การเลือกตัวใหม่ก่อนแล้วจึงถอดตัวเดิม
      return;
    }
    if (terminal !== null) {
      // หลังเกิดเหตุ terminal ห้องสอบกำลังปิด — อัปเดตคำตอบในหน้าได้ แต่
      // ห้ามตั้งรอบันทึก/ตั้ง timer เพิ่ม (attempt ปิดแล้วฝั่ง server)
      item.choiceIds = next;
      emit();
      return;
    }
    item.choiceIds = next;
    item.error = false;
    markDirtyAndSchedule(item, questionId);
    // emit ทุกคลิกที่เปลี่ยนคำตอบจริง — แม้ยังอยู่ในช่วง throttle/saving ที่
    // markDirtyAndSchedule ไม่ได้เรียก attemptSave (ซึ่ง emit เอง) เพราะ checkbox
    // เป็น controlled state ถ้าไม่ emit เดี๋ยวนี้ UI จะค้างคำตอบเดิม
    emit();
  };

  const hasUnsaved = (): boolean => {
    for (const item of runtime.values()) {
      if (item.dirty) {
        return true;
      }
    }
    return false;
  };

  const flushAll = async (): Promise<ExamFlushOutcome> => {
    if (disposed) {
      return { ok: true };
    }
    const clearTimers = (): void => {
      for (const item of runtime.values()) {
        if (item.timer !== null) {
          clearTimeout(item.timer);
          item.timer = null;
        }
      }
    };
    // terminal ที่เจอไปแล้ว (แม้รอบก่อน flush) = attempt ปิดแล้ว ห้ามยิงเพิ่ม
    // (เคลียร์ timer ที่อาจติดค้างให้เสร็จสรรก่อนคืนค่า)
    if (terminal !== null) {
      clearTimers();
      return { ok: false, terminalCode: terminal };
    }
    clearTimers();
    for (let pass = 0; pass < 5; pass += 1) {
      // เตะบันทึกทุกข้อ dirty ที่ไม่มี request ค้างทุกรอบ — รวมข้อที่เพิ่งกลายเป็น
      // dirty หลัง request เดิมจบแล้วถูก markDirtyAndSchedule ตั้ง timer ไว้
      // (เราเคลียร์ timer ทิ้งแล้ว จึงบันทึกทันทีแทนการรอ 10 วิ) — ห้ามรอแต่ promise
      // เดิมเพราะ promise นั้นไม่มีคำตอบล่าสุดของข้อนั้นอยู่ด้วย
      for (const [questionId, item] of runtime.entries()) {
        if (item.dirty && item.saving === false) {
          attemptSave(questionId);
        }
      }
      const pending = [...runtime.values()].filter((item) => item.dirty || item.saving);
      if (pending.length === 0) {
        break;
      }
      await Promise.allSettled([...inflight.values()]);
      if (terminal !== null) {
        // เจอ terminal กลาง flush (เช่น หมดเวลาตอนบันทึกข้อท้าย) — หยุดทันที
        break;
      }
      clearTimers();
    }
    if (terminal !== null) {
      return { ok: false, terminalCode: terminal };
    }
    return hasUnsaved() === false ? { ok: true } : { ok: false, terminalCode: null };
  };

  const dispose = (): void => {
    disposed = true;
    for (const item of runtime.values()) {
      if (item.timer !== null) {
        clearTimeout(item.timer);
        item.timer = null;
      }
    }
  };

  return { toggle, flushAll, hasUnsaved, dispose };
}
