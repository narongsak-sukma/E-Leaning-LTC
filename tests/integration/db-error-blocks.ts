/**
 * tests/integration/db-error-blocks.ts — parser บริสุทธิ์ (ไม่แตะ docker/db)
 * ของ db error log สำหรับ evidence-settle fence (Wave H): แยก log ของ container
 * db เป็น "record" ตามหัวบรรทัดของ Postgres แล้วจับคู่ error block ที่ผูก
 * invocation จาก record เดียวเท่านั้น — ERROR + ชื่อ RPC + parameters ต้องอยู่
 * record เดียวกันและมาจาก "แหล่งที่ถูกต้อง" ของ record นั้น
 *
 * ลำดับวิวัฒนาการตาม gate codex:
 * · v6 (r8): มองย้อนหลัง 8 แถว + some() แยก ERROR/ชื่อ RPC → รวมหลักฐานข้าม
 *   block ได้ (r9 พิสูจน์: wrong_rpc_adjacent = matches 1)
 * · v7 (r9): แยก record ตาม PID ของ backend + ref/RPC ต้องอยู่ record เดียว —
 *   ปิดการยืมข้าม block แต่ยัง includes() ทุกแถวของ record (r10 พิสูจน์:
 *   ERROR ข้อความธรรมดาทำหลักฐาน ref/RPC ได้ 3 กรณี)
 * · v8 (r10 เงื่อนไขปิด): "แยกและตรวจ bind parameters จริง โดยอ่าน p_request_id
 *   จาก field ที่ถูกต้อง และตรวจชื่อ RPC แบบตรงตัวจากโครงสร้าง STATEMENT/
 *   function context ภายใน record เดียวกัน" — ref ต้องมาจากการ parse ค่า
 *   bind parameter ($n = '<json>') เป็น JSON แล้วอ่าน field p_request_id เป๊ะ ·
 *   ชื่อ RPC ต้องมาจากบรรทัด CONTEXT/STATEMENT (PL/pgSQL function <rpc>( หรือ
 *   "public"."<rpc"() เท่านั้น ไม่นับข้อความ ERROR และไม่นับค่า parameter
 *
 * รูป header จริง (ตรวจจริง 2026-09-15/16 — docker logs ltc-dev-db -t):
 *   <docker-ts> <ip> <ts> [PID] authenticator@postgres ERROR:  …
 *   <docker-ts> <ip> <ts> [PID] authenticator@postgres CONTEXT:  PL/pgSQL function complete_data_export_job(uuid,…) line 15 at RAISE
 *   <docker-ts> \tunnamed portal with parameters: $1 = '{"p_job_id":"…","p_request_id":"…","p_claim_token":null}'   ← ไร้ header (tab-indent)
 *   <docker-ts> <ip> <ts> [PID] authenticator@postgres STATEMENT:  WITH pgrst_source AS (… "public"."<rpc>"(…) …)
 *   รูป bind parameters ที่พบจริง 3 แบบ: ไร้ header "unnamed portal with
 *   parameters: $n = '…'" · ใน header CONTEXT "unnamed portal parameter $n = '…'"
 *   (error นอก plpgsql เช่น invalid input syntax ที่ cast ของ PostgREST) ·
 *   "DETAIL:  parameters: $n = '…'"
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

/**
 * บรรทัด bind parameters จริง (v8): จับคู่ `$n = '<ค่า>'` เฉพาะแถวที่ระบุ
 * ตัวเองว่าเป็น parameters ของ portal — ค่าอยู่ท้ายแถวใน single quote
 * (greedy ถึง quote ปิดสุดท้ายของแถว) · รูปที่ตรวจได้จริงจาก container
 * (docker logs 2026-09-14/15): ไร้ header `\tunnamed portal with parameters: $n = '…'`
 * (มีโคลอน) · ใน header CONTEXT `CONTEXT:  unnamed portal parameter $n = '…'`
 * (ไร้โคลอน) · `DETAIL:  parameters: $n = '…'` (ตั้งไว้กันเหลือ — ยังไม่เคย
 * ปรากฏจริง) → โคลอนต้อง optional
 */
const PARAM_BINDING_RE =
  /(?:unnamed portal with parameters|unnamed portal parameter|DETAIL:\s+parameters)\s*:?\s*\$(\d+)\s*=\s*'(.*)'\s*$/;

/** CONTEXT ของ plpgsql: `PL/pgSQL function <ชื่อ>(<args>) line N at RAISE` */
const CONTEXT_FUNCTION_RE = /PL\/pgSQL function ([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\s*\(/g;

/**
 * STATEMENT: จุดที่คำสั่งเรียก RPC จริง — wrapper ของ PostgREST v12
 * (`SELECT "public"."<rpc>"(…`) และรูป CALL/FROM ตรง (`CALL public.<rpc>(`)
 */
const STATEMENT_CALL_RES = [
  /"public"\."([A-Za-z_][\w$]*)"\s*\(/g,
  /\b(?:FROM|CALL)\s+(?:"public"\.|public\.)"?([A-Za-z_][\w$]*)"?\s*\(/gi,
] as const;

/**
 * ทุก group-1 ที่ re จับได้ใน ln — ใช้ exec-loop บน clone ของ regex ต้นฉบับ
 * (new RegExp(source, flags) ต่อการเรียก จึงไร้สถานะแชร์กับใคร) · เลี่ยง
 * String.matchAll โดยเจตนา: ตรวจพบจริงว่า matchAll เงียบคืนศูนย์ผลลัพธ์ใน
 * vm context (Node 24 runInNewContext) ขณะ exec ตรง ๆ จับคู่ได้ปกติ — เลือก
 * รูปที่ทำงานเหมือนกันในทุกสภาพแวดล้อม (รวมถึง harness ตรวจสอบภายนอกที่
 * transpile ไฟล์นี้แล้วรันใน vm เช่น gate ของ CTO)
 */
function collectFirstGroups(re: RegExp, ln: string): string[] {
  const probe = new RegExp(re.source, re.flags);
  const found: string[] = [];
  for (let m = probe.exec(ln); m !== null; m = probe.exec(ln)) {
    if (m[1] !== undefined) found.push(m[1]);
    if (probe.lastIndex >= ln.length) break;
  }
  return found;
}

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
 * ค่า p_request_id จาก bind parameters จริงของ record (v8): parse ค่าของ
 * `$n = '…'` เป็น JSON แล้วอ่าน field `p_request_id` เป๊ะ — ข้อความ
 * `"p_request_id":"…"` ที่ปรากฏใน ERROR/ค่า field อื่น (เช่น p_reason)
 * ไม่ถูกนับเพราะไม่ใช่ค่าที่ parse ได้จาก bind parameter · คืน null เมื่อ
 * record ไม่มีแถว bind parameters เลย (ไม่มีหมุดผูก invocation = ปฏิเสธ)
 */
function boundRequestIds(lines: readonly string[]): string[] | null {
  const refs: string[] = [];
  let sawBinding = false;
  for (const ln of lines) {
    const m = PARAM_BINDING_RE.exec(ln);
    if (m === null) continue;
    sawBinding = true;
    try {
      const parsed: unknown = JSON.parse(m[2] as string);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const ref = (parsed as Record<string, unknown>)["p_request_id"];
        if (typeof ref === "string") refs.push(ref);
      }
    } catch {
      // ค่า bind ไม่ใช่ JSON ที่ตรวจได้ → ไม่ให้หลักฐานจาก binding นี้ (fail-closed)
    }
  }
  return sawBinding ? refs : null;
}

/**
 * ชื่อ RPC ที่โครงสร้างของ record ระบุเอง (v8): จากบรรทัด CONTEXT
 * (`PL/pgSQL function <rpc>(`) และ STATEMENT (จุดเรียก RPC ของคำสั่ง)
 * เท่านั้น — ข้อความใน ERROR และค่าใน bind parameters ไม่นับ (r10 กรณี
 * ชื่อ RPC หลุดไปอยู่ใน p_reason ของ RPC อื่น) · ชื่อที่มี schema prefix
 * เก็บทั้งแบบเต็มและแบบตัด prefix
 */
function structuralRpcNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => {
    names.add(name);
    const dot = name.lastIndexOf(".");
    if (dot >= 0) names.add(name.slice(dot + 1));
  };
  for (const ln of lines) {
    // ชื่อ RPC รับเฉพาะจาก "บรรทัด header" ระดับ CONTEXT/STATEMENT (HEADER_RE
    // แยกให้เองว่าแถวนี้เป็น header ระดับใด — แถวไร้ header เช่น parameters
    // ไม่ให้ชื่อ RPC แม้ข้อความจะมีรูปคล้าย)
    const h = HEADER_RE.exec(ln);
    if (h === null) continue;
    const level = h[2] as string;
    if (level === "CONTEXT") {
      for (const name of collectFirstGroups(CONTEXT_FUNCTION_RE, ln)) add(name);
    } else if (level === "STATEMENT") {
      for (const re of STATEMENT_CALL_RES) {
        for (const name of collectFirstGroups(re, ln)) add(name);
      }
    }
  }
  return names;
}

/**
 * จับคู่ "error block ที่ผูก invocation รายตัว" — ต้องครบใน record เดียว
 * (gate waveh-r9) และมาจากแหล่งที่ถูกต้องของ record นั้น (gate waveh-r10):
 * · record เริ่มที่ ERROR (โดยการแยก record)
 * · requestRef ต้องเท่ากับ field `p_request_id` ที่ parse ได้จาก bind
 *   parameters จริงของ record นี้ (ไม่มี bind = ไม่มีหมุด = ปฏิเสธ)
 * · ชื่อ RPC ต้องถูกโครงสร้าง CONTEXT/STATEMENT ของ record นี้ระบุเอง
 */
export function matchDbErrorBlocks(
  rawLines: readonly string[],
  probe: { rpcName: string; requestRef: string },
): DbErrorRecord[] {
  return splitDbErrorRecords(rawLines).filter((rec) => {
    const refs = boundRequestIds(rec.lines);
    if (refs === null || !refs.includes(probe.requestRef)) return false;
    return structuralRpcNames(rec.lines).has(probe.rpcName);
  });
}
