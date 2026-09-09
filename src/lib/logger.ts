/**
 * logger — structured JSON ไป stdout + PII filter แบบ allowlist (SDS §6.2)
 *
 * - เขียนได้เฉพาะฟิลด์ใน allowlist — ฟิลด์อื่นทั้งหมดถูกตัดทิ้งก่อนเขียน (SDS §6.2)
 * - อ้างผู้ใช้ด้วย user_id เสมอ ห้าม email/ชื่อ/เลขบัตร/เลขใบอนุญาต (brief §8)
 * - PII filter เปิดทุก environment; ระดับ log ตาม LOG_LEVEL (dev=debug, prod=info)
 * - log ไฟล์ไม่ใช่หลักฐานตรวจสอบ — action สำคัญเขียน audit_logs ผ่าน audit service (Wave C)
 */
import type { AppConfig } from "./config";

export type LogLevel = AppConfig["logLevel"];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** allowlist ตาม SDS §6.2 — รวม ts/level/msg ที่ logger ใส่ให้เอง */
const ALLOWED_FIELDS = ["request_id", "route", "user_id", "duration_ms", "status"] as const;
export type LogField = (typeof ALLOWED_FIELDS)[number];
export type LogFields = { [K in LogField]?: string | number };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** write fn แยกไว้เพื่อให้ทดสอบได้ (default: console.log ไป stdout) */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => console.log(line),
): Logger {
  const shouldLog = (atLevel: LogLevel) => LEVEL_ORDER[atLevel] >= LEVEL_ORDER[level];
  const emit = (atLevel: LogLevel, msg: string, fields?: LogFields) => {
    if (!shouldLog(atLevel)) {
      return;
    }
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: atLevel,
      msg,
    };
    for (const key of ALLOWED_FIELDS) {
      const value = fields?.[key];
      if (value !== undefined) {
        entry[key] = value;
      }
    }
    write(JSON.stringify(entry));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
