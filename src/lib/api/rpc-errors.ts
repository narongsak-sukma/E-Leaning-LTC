/**
 * rpc-errors — parser กลางของ error ที่ RPC SECURITY DEFINER โยน (Wave C-11 · 0011_functions.sql)
 *
 * RPC (enroll, record_lesson_progress, record_quiz_attempt) ตรวจเงื่อนไขแล้ว `raise exception`
 * โดยฝัง error code จากทะเบียน lib/errors ไว้**ท้ายข้อความ** รูปแบบ "(ERR-XXX-NNN)" —
 * เดิมแต่ละ route แกะเอง (enroll = regex last-token · record_* = regex anchored) ไม่เหมือนกัน
 * (ธง Phase 1 ของ C-4) — ไฟล์นี้รวมเป็นชุดเดียวแบบ anchored ตามข้อเท็จจริงของ RPC
 * ที่ code อยู่ปิดท้าย message เสมอ
 *
 * caller map ผล undefined เองเป็น error ระบบแบบ opaque (fallback ต่างกันตาม route —
 * enroll → ERR-SYS-002 503, record_lesson_progress/record_quiz_attempt → ERR-SYS-001 500)
 */
import { ERROR_REGISTRY, type ErrorCode } from "../errors";

/** รูป error ที่ supabase rpc คืน — parser อ่านเฉพาะ message (ห้ามตอบข้อความ SQL ออก client — SDS §6.1) */
export interface RpcErrorLike {
  readonly message?: string | null;
}

/** token ทะเบียนปิดท้าย message — "(ERR-XXX-NNN)" เท่านั้น (anchored — ไม่จับ code กลางประโยค) */
const TRAILING_CODE_RE = /\((ERR-[A-Z]+-\d{3})\)$/;

/**
 * แกะ error code จากข้อความ exception ของ RPC — พบรูปแบบและอยู่ในทะเบียน → ErrorCode ·
 * ไม่พบรูปแบบ / code ไม่อยู่ในทะเบียน / message ไม่ใช่ string → undefined
 */
export function parseRpcErrorCode(error: RpcErrorLike | null | undefined): ErrorCode | undefined {
  const message = typeof error?.message === "string" ? error.message : "";
  const code = TRAILING_CODE_RE.exec(message.trim())?.[1];
  if (code === undefined) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(ERROR_REGISTRY, code) ? (code as ErrorCode) : undefined;
}
