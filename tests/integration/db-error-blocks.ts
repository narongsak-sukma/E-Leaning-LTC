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
 * `$tag$…$tag$` · line comment `--…` · block comment — แทนที่ด้วยช่องว่าง
 * คั่น · ชื่อ RPC ที่หลบอยู่ในส่วนเหล่านี้ไม่ถูกนับเป็นจุดเรียก RPC
 * (r11 MAJOR-3: `"public"."<rpc>("(` ใน literal/comment = ข้อมูล ไม่ใช่
 * การเรียก) · ชื่อที่อยู่นอกส่วนตัดคือโครงสร้างคำสั่งจริง
 * (v10): ตาม lexical structure ของ PostgreSQL จริงสองข้อ (r12 พิสูจน์
 * ด้วย transpile-mock ว่า v9 หลุดทั้งคู่): (1) escape string `E'…'` —
 * backslash เป็น escape ภายใน (`\'` ไม่ปิด string · `\\` เป็น backslash
 * เดียว) ต่างจาก `'…'` ธรรมดาที่ `''` เป็นทางเดียว (2) block comment
 * ซ้อนกันได้ — `/* a /* b *\/ c *\/` ปิดที่ `*\/` ตัวที่ทำให้ระดับกลับเป็น
 * ศูนย์ ไม่ใช่ตัวแรก
 * (v11): escape string ต่อข้าม newline ได้ (r13 พิสูจน์แบบเดียวกัน) —
 * `E'a'` ตามด้วย whitespace ที่มี newline แล้ว `'b…'` เป็น string เดียว
 * โดย `E` เขียนเฉพาะส่วนแรก escape semantics คงอยู่ตลอด (§4.1.2.2 ·
 * quotecontinue ของ scan.l อยู่ในโหมด xe ต่อ) · ของ `'…'` ธรรมดาไม่ต้อง
 * ตรวจจุดต่อ: ในโหมดธรรมดา `\'` ปิด string อยู่แล้วทั้งสองการตีความ
 * (v12): ตัวคั่นจุดต่อตาม quotecontinue ของ scan.l จริง (r14 พิสูจน์ว่า
 * space/tab/CR/LF อย่างเดียวยังไม่ครบ): `horiz_whitespace* newline
 * special_whitespace*` แล้ว `'` — horiz มี line comment `--…` และ form
 * feed · newline คือ `[\n\r]` (CR ลำพังนับเป็น newline) · special มี
 * newline เพิ่มและ line comment · **ไม่มี block comment** ใน quotecontinue
 * (v13): line comment "นอก string" จบที่ CR หรือ LF (r15 พิสูจน์: เดิม
 * หยุดเฉพาะ LF จึงกลืน `, E'prefix'` ที่อยู่หลัง CR เข้า comment จนถึง LF
 * ถัดไป — quote แรกหาย ส่วนต่อกลายเป็น string ธรรมดา ชื่อ RPC ใน literal
 * จึงรั่วออกมาเป็นจุดเรียก) — ใช้ lineCommentEnd เดียวกับตัวคั่นจุดต่อ
 * (v14): tag ของ dollar-quote ตาม dolqdelim ของ scan.l จริง (r16 พิสูจน์:
 * เดิม `[A-Za-z_][\w$]*` จำกัด ASCII จึงไม่รู้จัก tag อักขระสูง เช่น `$ก$`
 * และ greedy กิน `$` เข้า tag จน closer `$tag$` กลายเป็นส่วนของ opener
 * `$tag$abc$tag$` หาไม่เจอ กลืนโค้ดที่เหลือทั้งหมด) — dolq_start =
 * `[A-Za-z\200-\377_]` · dolq_cont = `[A-Za-z\200-\377_0-9]` ห้าม `$` ใน
 * tag (ต่างจาก ident_cont ที่มี `\$`) — `\200-\377` = byte สูง = อักขระ
 * non-ASCII ใด ๆ (ใน JS คือ code unit ≥ U+0080 รวม surrogate ครบทั้งคู่)
 * (v15): "$" ที่ติดกับ identifier เป็น "ส่วนของชื่อ" ไม่ใช่ตัวเปิด dollar-quote
 * (r17 พิสูจน์: v14 เปิด literal จาก `$tag$` ใน alias `a$tag$` — closer ไปเจอ
 * ตัวเปิดจริง ชื่อ RPC ใน literal จริงจึงรั่ยเป็นจุดเรียก และตัวปิดจริงกลายเป็น
 * opener เดินกลืน FROM ของเจ้าของ · รูป quoted identifier `"$tag$"` ก็โดนเช่นกัน)
 * — scan.l ใช้ longest-match: {identifier} = ident_start{ident_cont}* โดย
 * ident_cont = `[A-Za-z\200-\377_0-9\$]` มี `\$` ด้วย → `a$tag$` เป็น
 * identifier เดียว (PG 15 §4.1.2.4) — จึงต้องกิน identifier ทั้ง token (ทั้ง
 * แบบไร้ quote และแบบ `"…"` ที่ `""` = quote ในชื่อ) ออกมาก่อนแตะการตีความ
 * dollar-quote
 * (v16): quoted identifier ที่ส่งต่อเป็นโค้ดต้องไม่รั่ย "ข้อความภายในชื่อ"
 * (r18 พิสูจน์: v15 emit ข้อความตรง ๆ ทั้ง token ทำให้ `"x' FROM
 * public.<rpc>($1) 'y"` — ชื่อเดียวตาม §4.1.1 — ถูก STATEMENT_CALL_RES
 * จับเป็นจุดเรียกปลอม 1 ทั้งสองรูป record) — คลี่ escape `""` แล้วส่งชื่อ
 * ต่อเฉพาะที่ประกอบจากอักขระ identifier ล้วน ๆ (ไม่มี `"` `.` `(` แม้ตัวเดียว —
 * อักขระทั้งสามที่ pattern การเรียกต้องมี จึงก่อรูปการเรียกไม่ได้เอง · ไม่อ้าง
 * "ไม่มี whitespace โดยนิยาม" เพราะช่วง non-ASCII ของ class รวม NBSP U+00A0 —
 * gate r19 MINOR-2) ชื่ออื่นแทนที่ทั้ง token ด้วย `""`
 * (identifier เปล่า — โครงสร้างคงเดิม ชื่อหาย = ไม่ให้หลักฐาน)
 */
/** line comment `--{non_newline}*` — คืนตำแหน่งหลัง comment (ไม่กินตัวจบบรรทัด) */
function lineCommentEnd(sql: string, p: number): number {
  let q = p + 2;
  while (q < sql.length && sql[q] !== "\n" && sql[q] !== "\r") q += 1;
  return q;
}

/**
 * ตัวคั่น quotecontinue ตาม scan.l ของ PostgreSQL 15 จริง (r14 พิสูจน์:
 * รูป space/tab/CR/LF อย่างเดียวยังไม่ครบ): `horiz_whitespace* newline
 * special_whitespace*` แล้วเปิด string ต่อด้วย `'` — horiz_whitespace =
 * `[ \t\f]` หรือ line comment · newline = `[\n\r]` ตัวเดียวบังคับ (CRLF ส่วน
 * LF เป็น special_whitespace) · special_whitespace = `[ \t\n\r\f]` หรือ line
 * comment · **ไม่มี block comment ใน quotecontinue** ของ PG 15 · คืนตำแหน่ง
 * หลังตัวคั่น หรือ -1 เมื่อไม่ใช่รูปประกอบ (ผู้เรียกตรวจ `'` ที่ตำแหน่งนั้น)
 */
function skipQuoteContinueSeparator(sql: string, p: number): number {
  let q = p;
  // horiz_whitespace*
  for (;;) {
    if (q < sql.length && (sql[q] === " " || sql[q] === "\t" || sql[q] === "\f")) {
      q += 1;
      continue;
    }
    if (q + 1 < sql.length && sql[q] === "-" && sql[q + 1] === "-") {
      q = lineCommentEnd(sql, q);
      continue;
    }
    break;
  }
  // newline หนึ่งตัว — บังคับ
  if (q >= sql.length || (sql[q] !== "\n" && sql[q] !== "\r")) return -1;
  q += 1;
  // special_whitespace*
  for (;;) {
    if (
      q < sql.length &&
      (sql[q] === " " || sql[q] === "\t" || sql[q] === "\n" || sql[q] === "\r" || sql[q] === "\f")
    ) {
      q += 1;
      continue;
    }
    if (q + 1 < sql.length && sql[q] === "-" && sql[q + 1] === "-") {
      q = lineCommentEnd(sql, q);
      continue;
    }
    break;
  }
  return q;
}

/**
 * (v16) ชื่อ quoted identifier ที่ "ส่งต่อเป็นโค้ด" ได้: ประกอบจากอักขระของ
 * identifier ล้วน ๆ (ident_cont ของ scan.l — รวม `\$` และอักขระ non-ASCII) —
 * ชื่อแบบนี้ไม่มี `"` `.` `(` แม้ตัวเดียว ซึ่งเป็นอักขระที่ pattern การเรียก
 * ทั้งสองของ STATEMENT_CALL_RES ต้องมี จึงไม่มีทางก่อรูป `"public"\."<rpc>"(`
 * หรือ `FROM|CALL … (` ขึ้นเอง (หมายเหตุ gate r19 MINOR-2: ไม่อ้าง "ไม่มี
 * whitespace โดยนิยาม" — ช่วง non-ASCII ของ class รวม NBSP U+00A0 ที่เป็น
 * whitespace การอ้างขาด `"` `.` `(` เพียงสามตัวจึงเพียงพอและตรงความจริง)
 * (r18: v15 ส่งข้อความตรง ๆ ต่อจนข้อความในชื่อกลายเป็นแหล่งจับการเรียกปลอม)
 * · ชื่ออื่น (มีอักขระนอกชุดนี้แม้ตัวเดียวหลังคลี่ `""`) ถูกแทนที่ทั้ง token
 * ด้วย `""` — `"pu'blic"` จึงไม่ปลอมตัวเป็น schema `public` ได้ (แทนที่ทั้ง
 * token ไม่ใช่ตัดอักขระทิ้ง: การตัดจะเย็น `pu'blic` เป็น `public`)
 */
const QUOTED_IDENT_NAME_RE = /^[A-Za-z_\u0080-\uFFFF0-9$]*$/;

function stripSqlDataParts(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // escape string E'…' / e'…': backslash-escape ใช้ได้เฉพาะรูปนี้ (PG docs
    // lexical structure) — `'…'` ธรรมดาไม่ยกเว้น backslash (การอ่านเกิน
    // จะกลืนโค้ดจริงที่ตามมา = ทิศ over-reject ที่เลี่ยงไว้)
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          // จุดต่อข้าม newline (r13/r14 MAJOR) ตาม quotecontinue ของ scan.l
          // จริง: ตัวคั่น = horiz_whitespace* newline special_whitespace* (มี
          // line comment และ form feed ได้ · newline = [\n\r]) แล้ว `'` เปิด
          // ส่วนถัดไป — escape semantics คงอยู่ตลอด (E เขียนเฉพาะส่วนแรก ·
          // xqs กลับโหมด xe) · `'…'` ธรรมดาไม่ต้องมีขานี้: ตำแหน่ง quote ปิด
          // ตรงกันทั้งการตีความต่อกันหรือแยก จึงไม่เปลี่ยนผล strip
          const sep = skipQuoteContinueSeparator(sql, i + 1);
          if (sep >= 0 && sql[sep] === "'") {
            i = sep + 1;
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
      // comment = --{non_newline}* · non_newline = [^\n\r] — จบที่ CR หรือ LF
      // ตัวใดตัวหนึ่งก่อนถึงตัวหลัง (r15: เดิมหยุดเฉพาะ LF จึงกลืนโค้ดหลัง CR
      // เข้า comment จนถึง LF ถัดไป) · ไม่กินตัวจบบรรทัด — คงพฤติกรรมเดิม
      i = lineCommentEnd(sql, i);
      out += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      // block comment ซ้อนกันได้: นับระดับ — ปิดเมื่อระดับกลับเป็นศูนย์
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (/[A-Za-z_\u0080-\uFFFF]/.test(ch ?? "")) {
      // (v15) identifier ไร้ quote — กินทั้งชื่อออกมาเป็นโค้ดก่อนแตะ "$" ของ
      // dollar-quote: scan.l ใช้ longest-match โดย ident_cont = [A-Za-z\200-
      // \377_0-9\$] มี "$" ด้วย → `a$tag$` เป็น identifier เดียว ไม่ใช่ alias
      // ตามด้วยตัวเปิด literal (r17: v14 เปิด literal จาก "$" ใน alias แล้ว
      // closer ไปเจอตัวเปิดจริง ชื่อ RPC ใน literal จึงรั่ยเป็นจุดเรียก และ
      // ตัวปิดจริงกลายเป็น opener กลืน FROM ของเจ้าของจริง)
      let j = i + 1;
      while (j < sql.length && /[A-Za-z_\u0080-\uFFFF0-9$]/.test(sql[j] ?? "")) j += 1;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      // (v15) quoted identifier "…" — ชื่อใน quote จะมีอักขระใดก็ได้รวม "$" ("" =
      // quote ในชื่อ) กินทั้ง token ออกมา (ชื่อ RPC ใน STATEMENT เป็นรูปนี้) ·
      // v14 ปล่อย "$" ข้างในเข้า branch dollar-quote จน `"$tag$"` เปิด literal
      // หา closer ไม่เจอแล้วกลืนโค้ดที่ตามมาทั้งหมด
      // (v16) การส่งต่อเป็นโค้ดต้องไม่ปล่อยข้อความ "ภายในชื่อ" ออกไปให้
      // STATEMENT_CALL_RES ตีความเป็น keyword/การเรียกฟังก์ชันได้ (r18: v15
      // ส่งตรง ๆ จน `"x' FROM public.<rpc>($1) 'y"` กลายเป็นจุดเรียกปลอม) —
      // คลี่ escape `""` เป็น `"` แล้วส่งชื่อต่อเฉพาะที่ประกอบจากอักขระ
      // identifier ล้วน ๆ ไม่งั้นแทนที่ทั้ง token ด้วย `""`
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      const name = closed ? sql.slice(i + 1, j - 1).replace(/""/g, '"') : "";
      out += QUOTED_IDENT_NAME_RE.test(name) ? `"${name}"` : '""';
      i = j;
      continue;
    }
    if (ch === "$") {
      // dollar-quoted string: $tag$ … $tag$ (tag ว่างได้ $$…$$) · tag ตาม
      // dolqdelim ของ scan.l: \$({dolq_start}{dolq_cont}*)?\$ — dolq_start =
      // [A-Za-z\200-\377_] · dolq_cont = [A-Za-z\200-\377_0-9] ห้าม "$" ใน tag
      // (r16: เดิม [A-Za-z_][\w$]* ไม่รู้จัก tag อักขระสูง และกิน "$" เข้า tag
      // จน closer หาย กลืนโค้ดที่เหลือ) — \200-\377 = อักขระ non-ASCII ใด ๆ
      const opener = /^\$([A-Za-z_\u0080-\uFFFF][A-Za-z_\u0080-\uFFFF0-9]*)?\$/.exec(
        sql.slice(i),
      );
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
