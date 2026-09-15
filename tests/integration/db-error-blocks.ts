/**
 * tests/integration/db-error-blocks.ts — parser บริสุทธิ์ (ไม่แตะ docker/db)
 * ของ db error log สำหรับ fence v7 (gate waveh-r9 M1): แยก log ของ container db
 * เป็น "record" ตามหัวบรรทัดของ Postgres แล้วจับคู่ error block ที่ผูก invocation
 * จาก record เดียวเท่านั้น — ERROR + ชื่อ RPC + parameters ต้องอยู่ record
 * เดียวกัน (gate r9: matcher เดิมของ v6 มองย้อน 8 แถวแล้ว some() แยกกัน
 * สามารถรวมหลักฐานจาก block ของ RPC อื่น/invocation อื่นที่อยู่ติดกันได้)
 *
 * รูป header จริง (ตรวจจริง 2026-09-15 — docker compose logs db --timestamps):
 *   ltc-dev-db  | 2026-09-15T14:13:43.947396879Z 172.20.0.6 2026-09-15 14:13:43.947 UTC [1479338] authenticator@postgres ERROR:  …
 *   ltc-dev-db  | 2026-09-15T14:13:43.947396879Z … [1479338] authenticator@postgres CONTEXT:  PL/pgSQL function …
 *   \tunnamed portal with parameters: $1 = '{"p_request_id":"…", …}'   ← ไร้ header (tab-indent)
 *   ltc-dev-db  | … [1479338] authenticator@postgres STATEMENT:  WITH pgrst_source AS (…)
 *
 * กติกาจับกลุ่ม record (PID ในหัวบรรทัด = ตัวระบุ backend session ตามเอกสาร
 * logging ของ PostgreSQL): record ของ fence "เริ่ม" ที่ header ERROR เท่านั้น ·
 * header ถัดไปที่เป็น PID เดียวกันและเป็นระดับบริบทของ error (CONTEXT/
 * STATEMENT/DETAIL/HINT/QUERY) ต่อท้าย record เดิม · header อื่น (PID ต่าง
 * หรือระดับอื่น เช่น LOG/ERROR ใหม่) ปิด record เดิม · แถวไร้ header ต่อท้าย
 * record ปัจจุบัน (มี record เปิดอยู่เท่านั้น)
 */

/** header ของ Postgres: `[PID] user@db LEVEL: ` — LEVEL เป็นระดับที่รู้จักทั้งหมด */
const HEADER_RE =
  /\[(\d+)\] [A-Za-z_][A-Za-z0-9_]*@[A-Za-z_][A-Za-z0-9_.]* (ERROR|CONTEXT|STATEMENT|DETAIL|HINT|QUERY|LOG|WARNING|NOTICE|INFO|FATAL|PANIC): /;

/** ระดับที่เป็น "บริบทต่อเนื่อง" ของ error record เดิม (PID เดียวกัน) */
const CONTINUATION_LEVELS = new Set(["CONTEXT", "STATEMENT", "DETAIL", "HINT", "QUERY"]);

/** error record หนึ่งก้อนของ backend session เดียว (PID เดียวกันตลอด) */
export interface DbErrorRecord {
  readonly pid: number;
  readonly lines: readonly string[];
}

/**
 * แยกแถว log ดิบเป็น error records — เริ่มก้อนใหม่ที่ header ERROR เท่านั้น
 * (LOG/อื่น ๆ ไม่เปิดก้อน) · คืนเฉพาะก้อนที่เริ่มด้วย ERROR
 */
export function splitDbErrorRecords(rawLines: readonly string[]): DbErrorRecord[] {
  const records: DbErrorRecord[] = [];
  let current: { pid: number; lines: string[] } | null = null;
  const closeCurrent = () => {
    if (current !== null) {
      records.push({ pid: current.pid, lines: current.lines });
      current = null;
    }
  };
  for (const ln of rawLines) {
    const h = HEADER_RE.exec(ln);
    if (h !== null) {
      const pid = Number(h[1]);
      const level = h[2] as string;
      if (
        current !== null &&
        pid === current.pid &&
        CONTINUATION_LEVELS.has(level)
      ) {
        // header บริบท PID เดียวกัน = ต่อ record เดิม
        current.lines.push(ln);
        continue;
      }
      // header อื่นปิด record เดิมเสมอ (PID ต่าง = คนละ backend · ERROR/LOG ใหม่ =
      // ข้อความใหม่) แล้วเปิดก้อนใหม่เฉพาะเมื่อเป็น ERROR
      closeCurrent();
      if (level === "ERROR") {
        current = { pid, lines: [ln] };
      }
      continue;
    }
    // แถวไร้ header (tab-indent เช่น parameters line) ต่อท้าย record ปัจจุบัน
    if (current !== null) {
      current.lines.push(ln);
    }
  }
  closeCurrent();
  return records;
}

/**
 * จับคู่ "error block ที่ผูก invocation รายตัว" — ต้องครบใน record เดียว
 * (gate waveh-r9 เงื่อนไขปิด: "ตรวจ ERROR, RPC และ parameters จาก record
 * เดียวกัน"): record เริ่มที่ ERROR (โดยการแยก record) + มี parameters needle
 * `"p_request_id":"<requestRef>"` เป๊ะ + มีชื่อ RPC — ทั้งหมดในก้อนเดียวกัน
 * ห้ามยืมแถวจาก record อื่น (v6 เคยยืมได้แล้ว false-positive ข้าม RPC/invocation)
 */
export function matchDbErrorBlocks(
  rawLines: readonly string[],
  probe: { rpcName: string; requestRef: string },
): DbErrorRecord[] {
  const refNeedle = `"p_request_id":"${probe.requestRef}"`;
  return splitDbErrorRecords(rawLines).filter(
    (rec) =>
      rec.lines.some((l) => l.includes(refNeedle)) &&
      rec.lines.some((l) => l.includes(probe.rpcName)),
  );
}
