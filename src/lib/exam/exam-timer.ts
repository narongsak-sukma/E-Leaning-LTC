/**
 * exam-timer — คณิตของนาฬิกาสอบจากเวลา server ล้วน (ธง lead: "timer จาก server เท่านั้น")
 *
 * หลักการ: ห้ามใช้นาฬิกา client เป็น "เวลาสอบ" — client เชื่อเฉพาะคู่ serverTime/deadlineAt
 * ที่ BFF ตอบ แล้ววัด "เวลาที่ผ่านไป" ของเครื่องตัวเองเป็นวินาทีถอยหลังจาก anchor:
 *   serverNow(t) ≈ t + offsetMs   (offsetMs = parse(serverTime) − เวลา client ตอนรับ response)
 *   remaining(t) = parse(deadlineAt) − serverNow(t)
 * นาฬิกา client จึงใช้เป็นแค่ "ไม้บรรทัดวัดช่วง" ไม่ใช่แหล่งความจริงของเวลา — ถูกต้องแม้
 * นาฬิกาเครื่องเพี้ยน ตราบใดที่ความยาวช่วงวัดถูก (ตัดสินหมดเวลาจริงเป็นฝั่ง RPC ด้วย expires_at เสมอ)
 *
 * ตัวเลข thresholds (15/5 นาที) ตาม DESIGN-SYSTEM §7.1 (ธง U5 — ค่าเริ่มต้น)
 */

/** เหลือ ≤ 15 นาที → โทนเตือน (warning) ตาม DS §7.1 */
export const EXAM_TIMER_WARN_REMAINING_MS = 15 * 60 * 1000;

/** เหลือ ≤ 5 นาที → โทนอันตราย (danger) ตาม DS §7.1 */
export const EXAM_TIMER_DANGER_REMAINING_MS = 5 * 60 * 1000;

export type ExamTimerTone = "normal" | "warning" | "danger";

/**
 * คำนวณ offset (มิลลิวินาที) ระหว่างนาฬิกา server กับนาฬิกา client ณ จุดรับ response —
 * offset = เวลา server − เวลา client · parse ไม่ได้ = null (ผู้เรียกต้อง fail-closed)
 */
export function serverOffsetMsOf(serverIso: string, clientNowMs: number): number | null {
  const serverMs = Date.parse(serverIso);
  if (Number.isNaN(serverMs)) {
    return null;
  }
  return serverMs - clientNowMs;
}

/**
 * เวลาที่เหลือ (มิลลิวินาที) ณ เวลา client ปัจจุบัน — จากคู่ deadlineAt/offsetMs ที่
 * มาจาก server · parse deadline ไม่ได้ = null (fail-closed ไม่เดาเป็น 0)
 */
export function remainingMsOf(
  deadlineIso: string,
  offsetMs: number,
  clientNowMs: number,
): number | null {
  const deadlineMs = Date.parse(deadlineIso);
  if (Number.isNaN(deadlineMs)) {
    return null;
  }
  return deadlineMs - (clientNowMs + offsetMs);
}

/** ตัดเวลาติดลบเหลือ 0 — ใช้แสดงผลเท่านั้น (สถานะหมดเวลาจริงดูจาก remaining ≤ 0) */
export function clampRemainingMs(ms: number): number {
  return Math.max(0, ms);
}

/**
 * โทนของนาฬิกาตามเวลาที่เหลือ — normal / warning (≤15 น.) / danger (≤5 น. หรือหมดเวลา)
 * (แจ้งด้วยข้อความประกอบเสมอ ไม่ใช่สีอย่างเดียว ตาม A11y checklist หน้า exam)
 */
export function examTimerTone(remainingMs: number): ExamTimerTone {
  if (remainingMs <= EXAM_TIMER_DANGER_REMAINING_MS) {
    return "danger";
  }
  if (remainingMs <= EXAM_TIMER_WARN_REMAINING_MS) {
    return "warning";
  }
  return "normal";
}

/** รูปแบบนาฬิกา HH:MM:SS (ตัดวินาทีเศษ — tabular-nums ที่ชั้นแสดงผล) */
export function formatExamClock(remainingMs: number): string {
  const totalSeconds = clampRemainingMs(Math.floor(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * เวลา HH:MM ของ ISO สำหรับป้าย "บันทึกล่าสุด" — ISO ผิดรูป = null (ไม่เดา)
 * (savedAt เป็นเวลา server — แสดงในเขมาเวลาของเครื่องผู้ใช้เพื่อการสื่อสารเท่านั้น
 * ไม่ใช่การใช้นาฬิกา client ตัดสินหมดเวลา)
 */
export function formatSavedAtTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return date.toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }
}
