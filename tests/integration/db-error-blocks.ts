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
 * · v8 (r10): ref จาก field p_request_id ของ bind ที่ parse ได้ · ชื่อ RPC จาก
 *   บรรทัด header CONTEXT/STATEMENT — แต่ยังไม่จำแนก "ชนิดของบรรทัด" ก่อนอ่าน
 *   (r11 พิสูจน์: ข้อความ ERROR ที่ฝังรูป bind ปลอม / ชื่อฟังก์ชันปลอมใน "ค่า"
 *   bind บนบรรทัด CONTEXT / ชื่อ RPC ใน SQL string literal ของ STATEMENT)
 * · v9 (r11 เงื่อนไขปิด): "แยก header กับ payload และจำแนกชนิด CONTEXT ก่อน
 *   อ่านข้อมูล; รับ bind เฉพาะตำแหน่งโครงสร้างที่ถูกต้อง; ตรวจ function context
 *   จากตำแหน่งจริงและตัด SQL literals/comments ออกจากการหาชื่อ RPC" —
 *   ทุกบรรทัดถูกจำแนก "บทบาท" ก่อน (บทบาท = ระดับ header + ต้นข้อความของ
 *   payload) แล้วจึงอนุญาตให้แต่ละบทบาทให้หลักฐานได้เฉพาะชนิดของมัน:
 *   ERROR ไม่ให้หลักฐานอะไรเลย · bind มาได้จาก 3 ตำแหน่งเท่านั้น (แถวไร้
 *   header ที่เริ่มด้วยรูป portal-parameters · payload ของ CONTEXT ที่เป็น
 *   portal-parameter · payload ของ DETAIL ที่เป็น parameters) · ชื่อ RPC จาก
 *   CONTEXT ได้เฉพาะ payload ที่ "เริ่มด้วย" PL/pgSQL function (ตำแหน่งจริงของ
 *   plpgsql context — ค่า bind ที่ฝังข้อความคล้ายไม่อยู่ตำแหน่งต้น) และจาก
 *   STATEMENT หลังตัด string literal/comment ออกจาก SQL
 *
 * รูป header จริง (ตรวจจริง 2026-09-15/16 — docker logs ltc-dev-db -t):
 *   <docker-ts> <ip> <ts> [PID] authenticator@postgres ERROR:  …
 *   <docker-ts> <ip> <ts> [PID] authenticator@postgres CONTEXT:  PL/pgSQL function complete_data_export_job(uuid,…) line 15 at RAISE
 *   <docker-ts> \tunnamed portal with parameters: $1 = '{"p_job_id":"…","p_request_id":"…","p_claim_token":null}'   ← ไร้ header (tab-indent)
 *   <docker-ts> <ip> <ts> [PID] authenticator@postgres STATEMENT:  WITH pgrst_source AS (… "public"."<rpc>"(…) …)
 *   รูป bind parameters ที่พบจริง 3 ตำแหน่ง: ไร้ header "unnamed portal with
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
 * bind ในแถวไร้ header (v9): แถวต่อเนื่องที่ "ต้นข้อความ" ระบุตัวเองว่าเป็น
 * parameters ของ portal — ค่าอยู่ท้ายแถวใน single quote (greedy ถึง quote
 * ปิดสุดท้ายของแถว) · ตรวจจริงจาก container: `\tunnamed portal with
 * parameters: $n = '…'` (มีโคลอน) · anchor ที่ต้นข้อความ = ข้อความ ERROR
 * ปลอมที่ "มีคำเหล่านี้อยู่ในนั้น" ไม่ผ่าน (r11 MAJOR-1)
 */
const HEADERLESS_PARAMS_RE =
  /^[ \t]*unnamed portal with parameters[ \t]*:?[ \t]*\$(\d+)[ \t]*=[ \t]*'(.*)'[ \t]*$/;

/**
 * bind ใน payload ของ header CONTEXT (v9): รูปที่ตรวจจริง "unnamed portal
 * parameter $n = '…'" (ไร้โคลอน — ทำ optional) · anchor ที่ต้น payload เช่น
 * เดียวกัน — CONTEXT ที่เป็น plpgsql function context จะไม่โดน regex นี้
 */
const CONTEXT_PORTAL_PARAMS_RE =
  /^[ \t]*unnamed portal parameter[ \t]*:?[ \t]*\$(\d+)[ \t]*=[ \t]*'(.*)'[ \t]*$/;

/**
 * bind ใน payload ของ header DETAIL (v9): รูป defensive "parameters: $n = '…'"
 * (ยังไม่เคยปรากฏจริงใน container ของเรา — ตั้งไว้กันเหลือตามเอกสาร Postgres)
 */
const DETAIL_PARAMS_RE =
  /^[ \t]*parameters[ \t]*:?[ \t]*\$(\d+)[ \t]*=[ \t]*'(.*)'[ \t]*$/;

/**
 * CONTEXT ของ plpgsql (v9): payload ต้อง "เริ่มด้วย" `PL/pgSQL function <ชื่อ>(`
 * — นี่คือตำแหน่งจริงที่ Postgres วางชื่อฟังก์ชันของ execution frame ·
 * anchor ต้นข้อความทำให้ชื่อฟังก์ชันปลอมที่ฝังอยู่ "ในค่า bind" ของบรรทัด
 * CONTEXT ชนิด portal-parameters ไม่ผ่าน (r11 MAJOR-2 — ค่าเริ่มด้วย
 * "unnamed portal parameter" ไม่ใช่ "PL/pgSQL function")
 */
const CONTEXT_FUNCTION_AT_START_RE =
  /^[ \t]*PL\/pgSQL function ([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)[ \t]*\(/;

/**
 * STATEMENT: จุดที่คำสั่งเรียก RPC จริง — wrapper ของ PostgREST v12
 * (`SELECT "public"."<rpc>"(…`) และรูป CALL/FROM ตรง (`CALL public.<rpc>(`)
 * · ใช้กับ SQL ที่ตัด string literal/comment ออกแล้วเท่านั้น (ด้านล่าง)
 */
const STATEMENT_CALL_RES = [
  /"public"\."([A-Za-z_][\w$]*)"\s*\(/g,
  /\b(?:FROM|CALL)\s+(?:"public"\.|public\.)"?([A-Za-z_][\w$]*)"?\s*\(/gi,
] as const;

/**
 * ทุก group-1 ที่ re จับได้ใน ln — ใช้ exec-loop บน clone ของ regex ต้นฉบับ
 * (new RegExp(source, flags) ต่อการเรียก จึงไร้สถานะแชร์กับใคร) · เลี่ยง
 * String.matchAll โดยเจตนา: ตรวจพบจริงว่า `[..."abc".matchAll(/a/g)]` ใน
 * บริบทเดียวกันให้ผลต่างกันตาม transpile target ของ harness (ES5 = ศูนย์
 * ผลลัพธ์ · ES2022 = จับได้) — อาการสัมพันธ์กับการ downlevel iterable
 * ของ harness ไม่ใช่ vm เพียงอย่างเดียว (คำแก้ของ CTO รอบ r11) — exec-loop
 * จึงถูกเลือกเพราะให้ผลเหมือนกันทุก target ทุกสภาพแวดล้อม
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

/**
 * ตัดส่วนที่ "เป็นข้อมูล ไม่ใช่โครงสร้างคำสั่ง" ออกจาก SQL ของ STATEMENT
 * (v9): string literal `'…'` (รวม escape `''`) · dollar-quoted string
 * `$tag$…$tag$` · line comment `--…` · block comment `/*…*\/` — แทนที่ด้วย
 * ช่องว่างคั่น · ชื่อ RPC ที่หลบอยู่ในส่วนเหล่านี้ไม่ถูกนับเป็นจุดเรียก
 * RPC (r11 MAJOR-3: `"public"."<rpc>("(` ใน literal/comment = ข้อมูล ไม่ใช่
 * การเรียก) · ชื่อที่อยู่นอกส่วนตัดคือโครงสร้างคำสั่งจริง
 */
function stripSqlDataParts(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(sql.length, i + 2);
      out += " ";
      continue;
    }
    if (ch === "$") {
      // dollar-quoted string: $tag$ … $tag$ (tag ว่างได้ $$…$$)
      const opener = /^\$([A-Za-z_][\w$]*)?\$/.exec(sql.slice(i));
      if (opener !== null) {
        const closer = `$${opener[1] ?? ""}$`;
        const end = sql.indexOf(closer, i + opener[0].length);
        i = end === -1 ? sql.length : end + closer.length;
        out += " ";
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
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

/** บทบาทของบรรทัดใน record หลังแยก header ออกจาก payload (v9) */
interface LineRole {
  readonly level: string | null;
  /**
   * ข้อความของบรรทัด: header → ส่วนหลัง `LEVEL: ` · แถวไร้ header → ส่วน
   * "หลัง tab ตัวสุดท้าย" (docker นำหน้าแถวต่อเนื่องด้วย timestamp ก่อน tab
   * indent — ค่า JSON ของ bind ไม่เคยมีอักขระ tab จริง เพราะ JSON escape
   * เป็น `\t` สองอักขระ จึงตัดที่ tab สุดท้ายได้ปลอดภัย) — คืน null สำหรับ
   * header ที่ยังไม่ถูกนำมาวิเคราะห์
   */
  readonly payload: string | null;
}

const classifyLine = (ln: string): LineRole => {
  const h = HEADER_RE.exec(ln);
  if (h !== null) {
    return { level: h[2] as string, payload: ln.slice(h.index + h[0].length) };
  }
  const lastTab = ln.lastIndexOf("\t");
  return { level: null, payload: lastTab >= 0 ? ln.slice(lastTab + 1) : ln };
};

/**
 * ค่า p_request_id จาก bind parameters จริงของ record (v9): รับ bind เฉพาะ
 * "ตำแหน่งโครงสร้างที่ถูกต้อง" 3 ตำแหน่ง — (1) แถวไร้ header ที่ต้นข้อความ
 * เป็นรูป portal-parameters (2) payload ของ header CONTEXT ชนิด portal-
 * parameter (3) payload ของ header DETAIL ชนิด parameters · ข้อความ ERROR
 * และทุกระดับอื่นไม่ให้ bind เด็ดขาด (r11 MAJOR-1: ข้อความ ERROR ที่ฝังรูป
 * bind ปลอม = ข้อมูล ไม่ใช่ binding) · ค่าที่จับได้ JSON.parse เป็น object
 * แล้วอ่าน field `p_request_id` เป๊ะ · คืน null เมื่อ record ไม่มีแถว bind
 * เลย (ไม่มีหมุดผูก invocation = ปฏิเสธ) · ค่า bind ที่ parse ไม่ได้ไม่ให้
 * หลักฐานจาก binding นั้น (fail-closed)
 */
function boundRequestIds(lines: readonly string[]): string[] | null {
  const refs: string[] = [];
  let sawBinding = false;
  const take = (m: RegExpExecArray | null): void => {
    if (m === null) return;
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
  };
  for (const ln of lines) {
    const { level, payload } = classifyLine(ln);
    if (level === null) {
      take(HEADERLESS_PARAMS_RE.exec(payload as string));
    } else if (level === "CONTEXT") {
      take(CONTEXT_PORTAL_PARAMS_RE.exec(payload as string));
    } else if (level === "DETAIL") {
      take(DETAIL_PARAMS_RE.exec(payload as string));
    }
    // ERROR/STATEMENT/อื่น ๆ = ไม่มีทางเป็นแหล่ง bind (v9)
  }
  return sawBinding ? refs : null;
}

/**
 * ชื่อ RPC ที่โครงสร้างของ record ระบุเอง (v9): ตรวจ function context จาก
 * "ตำแหน่งจริง" — CONTEXT ให้ชื่อได้เฉพาะ payload ที่เริ่มด้วย `PL/pgSQL
 * function <ชื่อ>(` (บรรทัด CONTEXT ชนิด portal-parameters ไม่ให้ชื่อแม้ค่า
 * ฝังข้อความคล้าย — r11 MAJOR-2) · STATEMENT ให้ชื่อจาก SQL ที่ตัด string
 * literal/comment ออกก่อน (r11 MAJOR-3) · ข้อความใน ERROR และแถวไร้ header
 * ไม่นับ · ชื่อที่มี schema prefix เก็บทั้งแบบเต็มและแบบตัด prefix
 */
function structuralRpcNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => {
    names.add(name);
    const dot = name.lastIndexOf(".");
    if (dot >= 0) names.add(name.slice(dot + 1));
  };
  for (const ln of lines) {
    const { level, payload } = classifyLine(ln);
    if (level === "CONTEXT") {
      const m = CONTEXT_FUNCTION_AT_START_RE.exec(payload as string);
      if (m !== null) add(m[1] as string);
    } else if (level === "STATEMENT") {
      const stripped = stripSqlDataParts(payload as string);
      for (const re of STATEMENT_CALL_RES) {
        for (const name of collectFirstGroups(re, stripped)) add(name);
      }
    }
  }
  return names;
}

/**
 * จับคู่ "error block ที่ผูก invocation รายตัว" — ต้องครบใน record เดียว
 * (gate waveh-r9) และมาจากแหล่งที่ถูกต้องของ record นั้น (gate waveh-r10/r11):
 * · record เริ่มที่ ERROR (โดยการแยก record)
 * · requestRef ต้องเท่ากับ field `p_request_id` ที่ parse ได้จาก bind
 *   parameters จริง "ในตำแหน่งที่ถูกต้อง" ของ record นี้ (ไม่มี bind = ไม่มี
 *   หมุด = ปฏิเสธ)
 * · ชื่อ RPC ต้องถูกโครงสร้าง CONTEXT(plpgsql ตำแหน่งต้น)/STATEMENT(ตัด
 *   literal/comment) ของ record นี้ระบุเอง
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
