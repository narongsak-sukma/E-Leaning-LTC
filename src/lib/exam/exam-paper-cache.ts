/**
 * exam-paper-cache - แคชชุดข้อสอบในหน่วยความจำของหน้า (client memory เท่านั้น)
 *
 * เหตุผลที่มี: ชุดข้อสอบ (ไร้เฉลย) ได้จาก POST /assessments/{id}/attempts เพียงทางเดียว
 * (ธง D37-6) - reload กลางสอบแล้ว POST ใหม่จะโดน ERR-ASM-002 ตราบ attempt in_progress
 * แคชนี้จึงเป็นสะพานพาชุดข้อจากหน้ากติกา (ตอนกดเริ่มสอบ) ไปส่งให้ห้องสอบ
 * ที่อยู่อีก route หนึ่ง โดย client navigation ใน JS context เดียวกัน
 *
 * ขอบเขตความปลอดภัย: อยู่ในหน่วยความจำของแท็บปัจจุบันเท่านั้น - ห้ามมี localStorage/
 * sessionStorage/IndexedDB เด็ดขาด (reload/แท็บใหม่ = แคชหาย = fail-closed ตามธง)
 * หมายเหตุ: "หน่วยความจำ" ที่ถูกต้องคือหน่วยความจำของแท็บปัจจุบัน (tab-scoped)
 */
import type { ExamPaperSession } from "./exam-api";

/** หนึ่งรายการในแคช - ชุดข้อ + offset นาฬิกา server/client ที่จับตอนรับ response */
export interface ExamPaperCacheEntry {
  readonly session: ExamPaperSession;
  /** offset = เวลา server - เวลา client ตอนรับ response (มิลลิวินาที) - ต้องเป็นจำนวนจริง */
  readonly serverOffsetMs: number;
}

/** แคชระดับโมดูล - มีชีวิตเท่า JS context ของแท็บ ห้ามทำ persistence ใด ๆ */
const cache = new Map<string, ExamPaperCacheEntry>();

/** เก็บชุดข้อของ attempt (ทับของเดิมถ้ามี) */
export function storeExamPaper(entry: ExamPaperCacheEntry): void {
  cache.set(entry.session.attemptId, entry);
}

/** อ่านชุดข้อตาม attemptId - ไม่พบ = null (ผู้เรียกต้อง fail-closed ไม่เดา) */
export function readExamPaper(attemptId: string): ExamPaperCacheEntry | null {
  return cache.get(attemptId) ?? null;
}

/** ลบชุดข้อออกจากแคช (เรียกหลัง submit สำเร็จ) */
export function clearExamPaper(attemptId: string): void {
  cache.delete(attemptId);
}

/** ล้างทั้งแคช - สำหรับ test เท่านั้น */
export function clearAllExamPapers(): void {
  cache.clear();
}
