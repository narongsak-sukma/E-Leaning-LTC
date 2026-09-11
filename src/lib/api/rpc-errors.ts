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
 *
 * 0019-r1 (Wave D): RPC ธุรกิจของ D-3/D-4 (admin_update_question, admin_*_certificate,
 * record_certificate_verification) ฝังเหตุผลเจาะจงเพิ่มเป็น "(ERR-XXX-NNN|reason)" —
 * parser รองรับทั้งสองรูป (เหตุผลเป็นทางเลือก · แบบเดิมตรวจ code เฉยๆ ใช้ต่อได้)
 */
import { ERROR_REGISTRY, type ErrorCode } from "../errors";

/** รูป error ที่ supabase rpc คืน — parser อ่านเฉพาะ message (ห้ามตอบข้อความ SQL ออก client — SDS §6.1) */
export interface RpcErrorLike {
  readonly message?: string | null;
}

/** token ทะเบียนปิดท้าย message — "(ERR-XXX-NNN)" หรือ "(ERR-XXX-NNN|reason)" (anchored) */
const TRAILING_CODE_RE = /\((ERR-[A-Z]+-\d{3})(?:\|([a-z0-9_]+))?\)$/;

/** ผลแกะแบบละเอียด — reason เป็น null เมื่อ message ไม่ได้แนบเหตุผล */
export interface RpcErrorCodeDetailed {
  readonly code: ErrorCode;
  readonly reason: string | null;
}

/**
 * แกะ error code + เหตุผลจากข้อความ exception ของ RPC — พบรูปแบบและ code อยู่ในทะเบียน →
 * {code, reason} · ไม่พบรูปแบบ / code ไม่อยู่ในทะเบียน / message ไม่ใช่ string → undefined
 */
export function parseRpcErrorCodeDetailed(
  error: RpcErrorLike | null | undefined,
): RpcErrorCodeDetailed | undefined {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const matched = TRAILING_CODE_RE.exec(message);
  if (matched === null) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(ERROR_REGISTRY, matched[1] as string)) {
    return undefined;
  }
  return {
    code: matched[1] as ErrorCode,
    reason: typeof matched[2] === "string" ? matched[2] : null,
  };
}

/**
 * แกะ error code จากข้อความ exception ของ RPC — พบรูปแบบและอยู่ในทะเบียน → ErrorCode ·
 * ไม่พบรูปแบบ / code ไม่อยู่ในทะเบียน / message ไม่ใช่ string → undefined
 */
export function parseRpcErrorCode(error: RpcErrorLike | null | undefined): ErrorCode | undefined {
  return parseRpcErrorCodeDetailed(error)?.code;
}
