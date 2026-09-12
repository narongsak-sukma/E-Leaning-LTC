/**
 * relative-time — เวลาสัมพัทธ์ภาษาไทยของหน้าแจ้งเตือน (Wave E Phase 4 · NTF-001)
 *
 * ลำดับชั้นตามสัญญาของ lane D: วินาที → นาที → ชั่วโมง → วัน → เดือน → ปี (แสดงเป็นวันที่จริงแบบ
 * พุทธศักราช — แบบเดียวกับ formatCycleDateThai DS §9 I18N-003):
 * - < 1 นาที           → "เมื่อสักครู่"
 * - 1–59 นาที          → "N นาทีที่แล้ว"
 * - 1–23 ชั่วโมง        → "N ชั่วโมงที่แล้ว"
 * - 1–29 วัน           → "N วันที่แล้ว"
 * - 1–11 เดือน (30 วัน/เดือน) → "N เดือนที่แล้ว"
 * - ≥ 365 วัน          → วันที่แบบพุทธศักราช เช่น "5 มีนาคม 2568"
 * - เวลาอนาคต (นาฬิกาเครื่องผู้ใช้เพี้ยน) = ยึดเพดาน "เมื่อสักครู่" — ห้ามแสดงเวลาติดลบ
 * - วันที่ไม่ถูกต้อง = "—" (ไม่ throw — ข้อความเพี้ยนแค่ช่องเวลา ไม่พังทั้งหน้า)
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** เพดานของแต่ละชั้น (เข้มงวด "<") — ปีใช้ 365 วันเป็นเส้นแบ่งเดียวกับการนับเดือน 30 วัน */
const MINUTE_CEILING = MS_PER_MINUTE;
const HOUR_CEILING = 60 * MS_PER_MINUTE;
const DAY_CEILING = 24 * HOUR_CEILING;
const MONTH_CEILING = 30 * MS_PER_DAY;
const YEAR_CEILING = 365 * MS_PER_DAY;

/** วันที่แบบพุทธศักราช "5 มีนาคม 2568" — DS §9 I18N-003 (แบบเดียวกับ formatCycleDateThai) */
function formatDateThai(date: Date): string {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    calendar: "buddhist",
  }).format(date);
}

/**
 * เวลาสัมพัทธ์ภาษาไทยจาก ISO timestamp ของ BFF — pure function (รับ now แยกเพื่อ test)
 * · ผู้เรียกต้องส่ง created_at ที่ BFF zod-validate แล้ว (ISO 8601) — ค่าอื่น = "—"
 */
export function formatRelativeThai(iso: string, now: Date): string {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return "—";
  }
  const elapsed = now.getTime() - time;
  if (elapsed < MINUTE_CEILING) {
    // ครอบคลุมทั้งเวลาอนาคตและช่วงวินาที — ทั้งคู่แสดง "เมื่อสักครู่"
    return "เมื่อสักครู่";
  }
  if (elapsed < HOUR_CEILING) {
    return `${Math.floor(elapsed / MS_PER_MINUTE)} นาทีที่แล้ว`;
  }
  if (elapsed < DAY_CEILING) {
    return `${Math.floor(elapsed / MS_PER_HOUR)} ชั่วโมงที่แล้ว`;
  }
  if (elapsed < MONTH_CEILING) {
    return `${Math.floor(elapsed / MS_PER_DAY)} วันที่แล้ว`;
  }
  if (elapsed < YEAR_CEILING) {
    return `${Math.floor(elapsed / (30 * MS_PER_DAY))} เดือนที่แล้ว`;
  }
  return formatDateThai(date);
}
