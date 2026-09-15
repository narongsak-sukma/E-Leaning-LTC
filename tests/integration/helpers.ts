/**
 * tests/integration/helpers.ts — ช่องทางกลางของ integration tests (C-9)
 *
 * - SQL ผ่าน psql ใน container db (docker compose exec) — supabase_admin (superuser)
 * - REST ผ่าน Kong (:8000) = PostgREST/GoTrue จริง ด้วย apikey (anon/service_role)
 * - ผู้ใช้ทดสอบ = GoTrue signup จริง + confirm ผ่าน SQL + login ด้วยรหัสผ่านจริง
 * - ไม่เพิ่ม dependency ใหม่ (node built-in + global fetch + supabase-js ที่มีอยู่)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** บังคับในไฟล์ทดสอบทุกไฟล์: const DB_URL = process.env.TEST_DATABASE_URL; describe.skipIf(!DB_URL) */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const REST_URL = process.env["TEST_SUPABASE_URL"] ?? "http://localhost:8000";
export const ANON_KEY =
  process.env["TEST_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IjAwMDAwMDAwMDAwMDAwMDAwMDAwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU2ODk2MDAsImV4cCI6MTg5MzQ1NjAwMH0.3jsTHD6cIxwRFtwetOAvCHSIQ0Z1xBxfki6n38cwPvk";
export const SERVICE_KEY =
  process.env["TEST_SUPABASE_SERVICE_ROLE_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IjAwMDAwMDAwMDAwMDAwMDAwMDAwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNTY4OTYwMCwiZXhwIjoxODkzNDU2MDAwfQ.4m7tXPHtzmhd8_oafj7Xt0PDZFXn0I1WkNXrxJzwYtQ";
/** GOTRUE_PASSWORD_MIN_LENGTH=12 ใน docker-compose.yml */
export const TEST_PASSWORD = process.env["TEST_USER_PASSWORD"] ?? "Integration#2026";

// ─── SQL (psql ใน container db) ───────────────────────────────────────────────

/** รัน SQL ผ่าน psql ใน container `db` — คืน stdout (psql -At)
 * opts.quiet: เพิ่ม -q เพื่อตัด command tag (UPDATE n/INSERT n) ออกจาก stdout —
 * จำเป็นเมื่อ parse ผล UPDATE…RETURNING (ไม่งั้น "UPDATE 0\n" ทำให้เหมือนมีผลลัพธ์) */
export function psql(sql: string, opts: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        `PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At${
          opts.quiet === true ? " -q" : ""
        }`,
      ],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`psql exit ${code ?? "?"}: ${stderr || stdout}`));
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** รัน SELECT และ parse เป็นรายการแถว (json_agg) — ตัด ; ท้ายคำสั่งก่อน wrap เป็น subquery */
export async function psqlRows<T>(sql: string): Promise<T[]> {
  const inner = sql.trim().replace(/;\s*$/, "");
  const raw = await psql(
    `select coalesce(json_agg(q), '[]'::json)::text from (${inner}) q;`,
  );
  return JSON.parse(raw.trim()) as T[];
}

/** คืนค่า scalar หนึ่งค่า (trim แล้ว) — ใช้กับ select คอลัมน์เดียว */
export async function psqlScalar(sql: string): Promise<string> {
  const raw = await psql(sql);
  const lines = raw.trim().split("\n");
  const last = lines.at(-1) ?? "";
  return last.trim();
}

// ─── REST (PostgREST/GoTrue ผ่าน Kong) ────────────────────────────────────────

export interface RestResult {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  /** id ของ invocation ใน lifecycle ledger (มีเฉพาะ path การเขียนผ่าน httpWrite) */
  readonly invocationId?: string;
  /** opKey ที่ transport กลาง derive ไว้ — ใช้คู่ invocationId ตอน settle เอง */
  readonly opKey?: string;
}

export interface RestCallOptions {
  readonly apiKey?: string;
  readonly token?: string | null;
  /** "auto" (default) = transport ตัดสิน settle เองตาม provenance ·
   * "scenario" = ผู้เรียกถือหลักฐาน terminal และเป็นคน settle เองผ่าน
   * settleScenario() — ใช้กับ dispatch ที่ตัวเทสพิสูจน์สภาพปลายทางเองอยู่แล้ว
   * (เช่น opaque 500 จาก upstream ที่ connection ขาดกลางทาง — Kong log อย่างเดียว
   * พิสูจน์ไม่ได้ว่า TX ไม่ commit เพราะอาจ commit แล้วตายก่อนตอบ — เทสที่
   * snapshot DB ไว้และ assert ไม่เปลี่ยนคือหลักฐานจริง) */
  readonly settleMode?: "auto" | "scenario";
}

/** เรียก REST ผ่าน Kong — apikey default = anon key
 * waveh-r1 M1: "การเขียน" (method ที่ไม่ใช่ GET/HEAD) ต้องผ่าน transport กลาง
 * httpWrite ทุกครั้ง — invocation/attempt row + ua_nonce + settle ตาม completion
 * class ครบทุก dispatch · การอ่าน (GET/HEAD — ไม่มี lifecycle) คง fetch ตรง
 * dynamic import เพราะ test-io นำเข้า helpers อยู่แล้ว (ห้าม static วนรอบ) */
export async function restCall(
  method: string,
  path: string,
  options: RestCallOptions = {},
  body?: unknown,
): Promise<RestResult> {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    const { httpWrite } = await import("./test-io");
    const r = await httpWrite(m, path, body, {
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.settleMode !== undefined ? { settleMode: options.settleMode } : {}),
      label: "restCall",
    });
    return { status: r.status, json: r.json, text: r.text, invocationId: r.invocationId, opKey: r.opKey };
  }
  const headers: Record<string, string> = {
    apikey: options.apiKey ?? ANON_KEY,
    accept: "application/json",
  };
  if (options.token !== undefined && options.token !== null) {
    headers["authorization"] = `Bearer ${options.token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${REST_URL}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

/** ปิด invocation ของ dispatch แบบ settleMode:"scenario" — ผู้เรียกเป็นคน settle
 * เองด้วยหลักฐาน terminal ที่ตัวเทสพิสูจน์ (เช่น opaque 500 ที่ไม่มี rest CLF line
 * ให้ access-log fence ตาม kong500Decision ใช้ตัดสิน — matches===0 จะ poison ทั้งที่
 * เทสถือหลักฐานจริงอยู่)
 *
 * gate waveh-r2/r3/r4/r5/r6/r7 M1 (สะสม): หลักฐานต้องพิสูจน์ "backend จบจริง" และ "ผูกกับ
 * invocation นี้" ทั้งคู่ — เรียงภายในเดียว ห้ามสลับ:
 *  1. probe terminal ก่อน (scenarioTerminalProbe — ขา lock + ขา activity): backend
 *     ยังรันอยู่ = ปฏิเสธทันที ไม่รอ (fail-loud · invocation คง 'running' ให้ audit จับ)
 *  2. ขา upstream-terminal ผูกกับ invocation แยกตาม class ของ response (r4→r8):
 *     หน้าต่างร่วมของทุกขา (fence v6 — gate r8 M1): anchor ที่ "เวลา dispatch"
 *     จริงจาก ledger (attempt.ts — เขียนก่อน fetch ทุกครั้ง จึงเป็นขอบ "ล่าง"
 *     ของเวลาถึง upstream ไม่ใช่ขอบบน) ยาว acq+stmt+margin — บทบาทเหลือเพียง
 *     "ความอดทนของการเฝ้าหลักฐาน" เท่านั้น: ความถูกต้องของ settle ไม่พึ่งค่า
 *     หน้าต่างอีกต่อไป (ครบหน้าต่างไร้หลักฐาน = ปฏิเสธเสมอ) — ยาวไป = ช้าลง
 *     เท่านั้น · สั้นไป = ปฏิเสธก่อน แล้วเรียก settle ใหม่ภายหลังได้ · ค่า
 *     acq (postgrestPoolAcquisitionBoundMs ตรวจสดว่าไม่มี override) และ stmt
 *     (8s ขา ง) ถูกใช้ประกอบความยาวนี้ ไม่ใช่เหตุผลตัดสิน settle (คำสั่ง r8:
 *     สูตร attemptTs+acq+8s+4s ไม่ใช่ขอบบนที่พิสูจน์ — r7 ใช้เป็นขอบบนเกินจริง)
 *     a. status < 0 (abort/network — ไม่มี response ถึงมือ caller): CLF line ของ
 *        nonce (rest) ต้องปรากฏ "หนึ่งแถวพอดี" (completion หรือ cancellation —
 *        line 500 จากการตัดตามขอบเขต role 57014 ก็นับ) = PostgREST serve ครบ
 *        หนึ่งครั้ง · poll ภายในหน้าต่าง dispatch+acq+stmt+margin · >1 แถว =
 *        serve ซ้ำ/กำกวม = ปฏิเสธ · activity ของ RPC นี้โผล่ระหว่าง poll =
 *        statement เพิ่งเริ่ม = ปฏิเสธทันที · ครบหน้าต่างไม่มี line = ปฏิเสธ
 *        (fail-closed — ไม่มี response ในมือจึงไม่มีทางเดินขอบเขตแบบขา b)
 *        singleDispatch ใน manifest ยืนยันไม่มี dispatch ซ้ำของ invocation เดียวกัน
 *     b. status ≥ 0 (response ถึงมือ caller แล้ว — ทุกรูปร่าง body เหมือนกัน):
 *        gate r6 M1.1 ยกเลิกการยกเว้น "JSON body = body-proven โดยโครงสร้าง"
 *        เพราะรูปร่าง body ไม่พิสูจน์แหล่งกำเนิด — ตรวจจริง 2026-09-15 ใน stack
 *        นี้: Kong 2.8.1 สังเคราะห์ gateway error เป็น JSON เองได้ (404 no-route
 *        ตอบ {"message":"no Route matched with those values"} และ 401 key-auth
 *        ตอบ {"message":"Invalid authentication credentials"}) — JSON จึงบอก
 *        ไม่ได้ว่ามาจาก upstream ที่ serve จบหรือ gateway สังเคราะห์ · ทุก
 *        response-in-hand ต้องผ่าน fence เดียวกันครบทุกขา:
 *        (ก) activity fail-fast: ไม่มี pg_stat_activity รัน RPC นี้อยู่ตอนเข้า
 *            fence — เจอ = ปฏิเสธทันที (fail-loud ไม่รอ) · หมุด = correlation
 *            ชื่อ RPC + หน้าต่างหลัง dispatch (ไฟล์รันเรียง — correlation เดียว
 *            กับ scenarioTerminalProbe ที่ gate ยอมรับตั้งแต่ r3 · gate r7
 *            บันทึกยอมรับเป็น activity guard แบบ conservative ภายใต้ serial
 *            invariant) · ตรวจจริง 2026-09-15 (เทส M1-r6 เปิดโปง): PostgREST
 *            ส่ง body เป็น bind param `$1 AS json_data` — literal p_request_id
 *            ไม่ปรากฏใน query text การกรองด้วย requestRef จึงเป็น 0 เสมอ
 *            (ผ่านปลอม) — requestRef เหลือเป็นหมุดราย invocation ใน ledger
 *            binding เท่านั้น (ขา ข′/ข ผูก nonce)
 *        (ข′) หลักฐาน terminal ตรงของ upstream ผูก invocation — fence v6 (gate
 *            r8 M1) สองรูป "หลักแรกที่ปรากฏชนะ" ภายในหน้าต่างเฝ้า:
 *            (i) rest CLF line ของ nonce หนึ่งแถวพอดี (r7 M1.1-1): PostgREST
 *            เขียน line หนึ่งต่อหนึ่ง serve ทุกสถานะ (ตรวจจริง 2026-09-15:
 *            200 · 400-22P02 · 500-57014 · แม้ client abort) = serve ครบ
 *            หนึ่งครั้งของ invocation "นี้" — ไม่อาศัยข้อสมมติ timeout ของ
 *            pooled session (ตอบ gate r7 M1.1-2 ครึ่งหลังด้วย)
 *            (ii) error block ของ db ที่ผูก p_request_id ของ invocation —
 *            รูปเดียวที่ "serve จบแล้วไร้ CLF line" คือ P0002-raise ข้อความ
 *            ไทยที่ gateway ตัดขาคอร์ด (probe 2026-09-15
 *            `.omc/artifacts/probe-p0002-run2.log`: 500 opaque + kong line +
 *            rest เงียบสนิท แต่ db log มี block ERROR/CONTEXT/parameters/
 *            STATEMENT) — เมื่อ log_parameter_max_length_on_error=-1
 *            parameters line พิมพ์ bind $1 เต็มเป็น JSON ที่มี p_request_id =
 *            หมุดผูก invocation รายตัว (dbErrorEvidenceFence) → block ที่ผูก
 *            requestRef หนึ่งก้อน = upstream จบด้วย error ของ invocation นี้จริง
 *            · >1 = กำกวม = ปฏิเสธ · activity ของ RPC นี้โผล่ระหว่าง poll =
 *            statement เพิ่งเริ่มหลังเข้า settle = ปฏิเสธทันที · ครบหน้าต่าง
 *            ยังไร้ทั้งสองรูป = fail-closed ปฏิเสธเสมอ (gate r8 M1 — ทางเดิน
 *            "อนุมานจบจากการไม่เห็น" ของ v5 ถูกถอด) · RPC ไม่มี requestRef ใน
 *            binding = เสียขา (ii) → ครบหน้าต่างไม่มี line = ปฏิเสธเช่นกัน
 *        (ข) kong access line ของ nonce หนึ่งแถวพอดีและ status ตรง res.status
 *            (Kong เขียน line "เมื่อปิด response" — ยังไม่มี line = request ยัง
 *            ค้างในทาง = ห้าม settle แม้ caller ถือ response แล้ว — กันเคส
 *            gateway สังเคราะห์คำตอบก่อน upstream serve) · >1 = กำกวม = ปฏิเสธ
 *        (ค) หน้าต่างหลัง kong line 12 วิ: การปิด response ฝั่ง gateway ไม่ใช่
 *            หลักฐาน completion/cancellation ฝั่ง upstream (gate r6) — statement
 *            ที่ "ยังค้างหรือเพิ่งเริ่มทีหลัง" gateway ปิด ต้องโผล่ใน
 *            pg_stat_activity ภายในหน้าต่างนี้ (poll ทุก 300ms จนครบ 12s —
 *            ห้ามออกเมื่อเจอ line แล้วตรวจครั้งเดียว) · โผล่ในหน้าต่าง = หลักฐาน
 *            ไม่ terminal = ปฏิเสธ
 *        (ง) role bounds ตามจริง ณ เวลา settle สองชั้น (declaration
 *            pg_db_role_setting + effective จาก login จริงฐานะ authenticator —
 *            authenticatorRoleBoundsOk) — gate r7 ถอดหน้าที่เหลือเป็น "ขอบเขต
 *            สนับสนุน" และ r8 ลดบทบาทต่อ: ใช้ประกอบ "ความยาว" หน้าต่างเฝ้าของ
 *            ขา ข′/ค เท่านั้น (หน้าต่างเป็นความอดทน — ไม่ใช่หลักฐาน terminal)
 *            · ขาพฤติกรรมบน pooled session ที่ serve จริงอยู่ที่ guard test
 *            M1-r6/M1-r7 (วัดการตัด ≤9.5s นับจากสังเกต busy ครั้งแรก — execution
 *            context จริงตามเงื่อนไขปิดของ gate r7 M1.1-2)
 *  3. postTerminalAssert (r4): อ่าน-assert snapshot "ใหม่" ตรงนี้เท่านั้น — หลัง
 *     terminal ยืนยันครบทั้งสองขา (อ่านก่อนขา 2 อาจได้ของเก่าขณะ backend ยัง
 *     มีชีวิต — race ที่ r4 จับ) · assert ล้ม = invocation คง 'running' (fail-loud)
 *  4. invocationClose settled — เกิดเมื่อผ่านครบทุกขาเท่านั้น
 */
export async function settleScenario(
  res: RestResult,
  evidence: string,
  terminalProbe: () => Promise<void>,
  postTerminalAssert?: () => Promise<void>,
): Promise<void> {
  const {
    invocationClose,
    manifestByOpKey,
    accessLogFenceAnyStatus,
    dbErrorEvidenceFence,
    kongAccessFence,
    authenticatorRoleBoundsOk,
    postgrestPoolAcquisitionBoundMs,
  } = await import("./test-io");
  if (res.invocationId === undefined || res.opKey === undefined) {
    throw new Error(`scenario dispatch ไม่มี invocationId/opKey กลับมา (${evidence})`);
  }
  // limitation 22: เขียนมือลอยไม่มีสิทธิ์ settle — scenario settle เปิดเฉพาะ opKey
  // ที่อยู่ใน EVIDENCE_SETTLE_MANIFEST (มี touchSet กำกับหลักฐานอยู่แล้ว)
  if (manifestByOpKey(res.opKey) === undefined) {
    throw new Error(`scenario settle ปฏิเสธ: opKey ${res.opKey} ไม่อยู่ใน manifest (${evidence})`);
  }
  // (1) probe terminal ก่อน — โยน = ไม่ settle (r2/r3)
  await terminalProbe();
  // (2) upstream-terminal ผูกกับ invocation นี้ (r4→r8) — แยกตาม class ของ
  // response (doc เต็มด้านบน): a. status<0 = CLF fence ของ rest หน้าต่าง
  // dispatch-anchored · b. status≥0 ทุกรูปร่าง body = fence ขาเดียวกัน (activity
  // fail-fast + หลักฐาน terminal สองรูป ขา ข′ — CLF line ของ nonce หรือ error
  // block ของ db ผูก requestRef + kong line หนึ่งแถว status ตรง + หน้าต่าง 12s
  // หลัง line · role bounds = ประกอบความยาวหน้าต่าง ไม่ใช่หลักฐาน) · nonce/cursor/
  // เวลา dispatch อ่านจาก ledger ของ invocation (แหล่งความจริง — ใช้ได้แม้ dispatch โยน error)
  // evidenceLeg = ขาหลักฐาน terminal ที่พา settle ผ่าน (บันทึกลง ledger ตอน
  // close — M1-r8 pin ว่า P0002 settle ผ่านจริงด้วย error block ของ db)
  let evidenceLeg: "clf-nonce-line" | "db-error-block" | null = null;
  const m = /^rpc:([a-z0-9_]+):(POST|PATCH|PUT|DELETE)$/i.exec(res.opKey);
  if (m !== null) {
    const [rpcName, httpMethod] = [m[1] as string, m[2] as string];
    const [binding] = await psqlRows<{ ua: string | null; requestRef: string | null }>(`
      select payload -> 'binding' ->> 'uaNonce' as ua,
             payload -> 'binding' ->> 'requestRef' as "requestRef"
        from test_infra.lifecycle_ledger
       where kind = 'invocation' and invocation_id = '${res.invocationId}'
       order by ts desc limit 1;`);
    const [attempt] = await psqlRows<{
      cursor: { capturedAt: string; lineCount: number; restStartedAt: string } | null;
      ts: string;
    }>(`
      select payload -> 'logCursor' as cursor, ts::text as ts
        from test_infra.lifecycle_ledger
       where kind = 'attempt' and invocation_id = '${res.invocationId}'
       order by ts desc limit 1;`);
    if (binding?.ua === null || binding === undefined || attempt === undefined) {
      throw new Error(
        `scenario settle ปฏิเสธ: ไม่พบ nonce/attempt ของ invocation ใน ledger — ไม่มีทางพิสูจน์ upstream terminal (${evidence})`,
      );
    }
    // (ง) role bounds สองชั้น: declaration + effective (login ฐานะ authenticator) —
    // r7 ถอดหน้าที่เหลือเป็น "ขอบเขตสนับสนุน" และ hoist มาก่อนแยกขา เพราะเลข
    // คณิตของหน้าต่าง CLF ทั้งสองขา (ด้านล่าง) ใช้ขอบเขต statement 8s นี้
    if (!(await authenticatorRoleBoundsOk())) {
      throw new Error(
        `scenario settle ปฏิเสธ: role authenticator ไม่ถือ statement/lock_timeout=8s ตามจริง (declaration pg_db_role_setting + effective จาก login ฐานะ authenticator) — ขอบเขตเวลาของ statement ใช้พิสูจน์ไม่ได้ (${evidence})`,
      );
    }
    // r7 M1.1-1: หน้าต่าง CLF anchor ที่ "เวลา dispatch จริง" จาก ledger (attempt.ts —
    // attempt row เขียนก่อน fetch ทุกครั้ง) ไม่ใช่นาฬิกาคงที่จากตอนเข้า settle ·
    // ครอบคำขอที่ค้างในคิว pool ของ PostgREST (ไร้ backend ไร้ CLF line จนได้ serve
    // — ตรวจจริง 2026-09-15: dispatch 11 ตัวพร้อมกันบน pool เต็ม 10 → ตัวที่ 11
    // ได้ serve จบ ~dispatch+16s พร้อม line) · คำขอใดที่ยังไม่เริ่มต้องได้ช่อง
    // ≤ dispatch+acq และงานที่เริ่มแล้วต้องจบ ≤ dispatch+acq+stmt (8s ขา ง) ·
    // margin 4s กิน clock skew ระหว่าง host (ledger ts) กับ container (เวลาเขียน
    // CLF line)
    // r8 M1 (fence v6): หน้าต่างนี้เหลือบทบาท "ความอดทนของการเฝ้า" เท่านั้น —
    // ความถูกต้องของ settle ไม่พึ่งค่าขอบเขตอีกต่อไป: ครบหน้าต่างแล้วไม่มี
    // หลักฐาน terminal ที่ผูก invocation (CLF line หรือ error block ของ db) =
    // fail-closed ปฏิเสธเสมอ ไม่มีทางเดิน "อนุมานจบจากการไม่เห็น" (ขา bounds
    // เดิมของ v5 ถูกถอดตาม verdict r8 — attempt.ts เขียนก่อน fetch จึงเป็นขอบ
    // ล่างของเวลาถึง upstream ไม่ใช่ขอบบน) · หน้าต่างสั้นไป = เช็คหลักฐานเร็วไป
    // = ปฏิเสธ (เรียก settle ใหม่ภายหลังได้) · ยาวไป = ช้าลงเท่านั้น
    const attemptTs = Date.parse(attempt.ts);
    if (!Number.isFinite(attemptTs)) {
      throw new Error(
        `scenario settle ปฏิเสธ: อ่านเวลา dispatch (attempt.ts) จาก ledger ไม่ได้ ("${attempt.ts}") — หน้าต่างเฝ้าไม่มี anchor (${evidence})`,
      );
    }
    const acqBoundMs = await postgrestPoolAcquisitionBoundMs();
    const clfDeadline = attemptTs + acqBoundMs + 8_000 + 4_000;
    // activity probe ร่วมของทุกขา — hoist ก่อนแยกขาเพราะขา CLF ทั้งสอง branch
    // ต้องเช็ค "statement เพิ่งเริ่มระหว่างเฝ้าหน้าต่าง" ทุก iteration (r7: คำขอที่
    // ค้างในคิว pool เริ่มทำงานได้หลัง settle เข้ามาแล้ว)
    // หมุดจริงของ stack (ตรวจจริง 2026-09-15 — เทส M1-r6 เปิดโปง): PostgREST ส่ง
    // body เป็น bind param (`WITH pgrst_source AS ... (SELECT $1 AS json_data)`) —
    // literal p_request_id ไม่ปรากฏใน pg_stat_activity.query เลย การกรองด้วย
    // requestRef จึงเป็น 0 เสมอ (ผ่านปลอม) · activity ผูก invocation ด้วย correlation
    // ตามจริง: ชื่อ RPC + หน้าต่างหลัง dispatch (integration config รันไฟล์เรียง —
    // ไม่มีไฟล์อื่นยิง RPC เดียวกันพร้อมกัน — correlation เดียวกับที่ gate ยอมรับ
    // ใน scenarioTerminalProbe ตั้งแต่ r3 · gate r7 บันทึกยอมรับเป็น activity guard
    // แบบ conservative ภายใต้ serial invariant) · requestRef เหลือเป็นหมุดราย
    // invocation ใน ledger binding เท่านั้น (ขา ข′/ข ผูก nonce)
    const rpcBusy = () =>
      psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%${rpcName}%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);
    if (res.status < 0) {
      // a. ไม่มี response ถึงมือ caller (abort/network) — CLF fence ของ rest (r4)
      //    หน้าต่าง r7: anchor ที่เวลา dispatch จริง (acq+stmt+margin) ไม่ใช่นาฬิกา
      //    12s จากตอนเข้า settle — คำขอที่ค้างในคิว pool ไร้ line จนได้ serve ·
      //    ระหว่าง poll เจอ activity ของ RPC นี้ = statement เพิ่งเริ่ม (คำขอพ้นคิว
      //    ภายหลัง) = ปฏิเสธทันที · ครบหน้าต่างไร้ line = fail-closed (ไม่มี response
      //    ในมือ จึงไม่มีทางเดิน "ขอบเขตพิสูจน์ครบ" แบบขา b)
      if (attempt.cursor == null) {
        throw new Error(
          `scenario settle ปฏิเสธ: ไม่มี logCursor ของ invocation ใน ledger — ไม่มีหน้าต่าง access log ให้พิสูจน์ (${evidence})`,
        );
      }
      let fence = { matches: 0, restRestartedInWindow: false };
      for (;;) {
        fence = await accessLogFenceAnyStatus(attempt.cursor, {
          uaNonce: binding.ua,
          method: httpMethod,
          pathNorm: `/rpc/${rpcName}`,
        });
        if (fence.matches > 1) {
          throw new Error(
            `scenario settle ปฏิเสธ: CLF line ของ nonce กำกวม (${fence.matches} แถว) — serve ซ้ำ? (${evidence})`,
          );
        }
        if (fence.restRestartedInWindow) {
          throw new Error(`scenario settle ปฏิเสธ: rest restart ใน window — หลักฐานขาดความต่อเนื่อง (${evidence})`);
        }
        if (fence.matches === 1) break;
        const busyA = await rpcBusy();
        if (busyA !== "0") {
          throw new Error(
            `scenario settle ปฏิเสธ: statement ของ RPC นี้เริ่มขึ้นระหว่างหน้าต่างเฝ้า CLF (pg_stat_activity เห็น ${busyA} ตัว ก่อนมี line ของ nonce) — คำขอพ้นคิว pool ภายหลัง dispatch ยังไม่ terminal (${evidence})`,
          );
        }
        if (Date.now() >= clfDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (fence.matches !== 1) {
        throw new Error(
          `scenario settle ปฏิเสธ: ไม่มี CLF terminal ของ invocation นี้ภายในหน้าต่าง dispatch+acq(${acqBoundMs}ms)+stmt(8s)+margin — upstream ยังไม่จบ (${evidence})`,
        );
      }
      evidenceLeg = "clf-nonce-line";
    } else {
      // b. response-in-hand ทุกรูปร่าง body (gate r6 M1.1: JSON ไม่พิสูจน์แหล่ง
      // กำเนิด — Kong 2.8.1 สังเคราะห์ gateway error เป็น JSON ได้ ตรวจจริง
      // 2026-09-15) → fence สี่ขาเดียวกันทุกครั้ง
      if (attempt.cursor == null) {
        throw new Error(
          `scenario settle ปฏิเสธ: response-in-hand แต่ไม่มี logCursor ของ invocation — ไม่มีขอบเขตหน้าต่าง kong log (${evidence})`,
        );
      }
      // (ก) activity fail-fast — statement ของ invocation นี้กำลังรันอยู่ตอนเข้า
      // fence = ไม่ terminal แน่ ปฏิเสธทันทีไม่รอ (fail-loud · rpcBusy hoist ไว้
      // ก่อนแยกขาแล้ว — doc หมุด correlation เต็มอยู่ที่นั่น)
      const busyNow = await rpcBusy();
      if (busyNow !== "0") {
        throw new Error(
          `scenario settle ปฏิเสธ: statement ของ invocation นี้ยังรันอยู่ (pg_stat_activity เห็น backend รัน ${rpcName} อยู่ ${busyNow} ตัว) (${evidence})`,
        );
      }
      // (ข′) หลักฐาน terminal "ตรง" ของ upstream ผูก invocation นี้ — fence v6
      // (gate r8 M1): หลักฐานสองรูป "หลักแรกที่ปรากฏชนะ" ภายในหน้าต่างเฝ้า
      //  (i) CLF line ของ nonce (rest): PostgREST เขียน line หนึ่งต่อหนึ่ง serve
      //      ทุกสถานะ (ตรวจจริง 2026-09-15: 200 · 400-22P02 · 500-57014 · แม้ client
      //      abort) → line ของ nonce หนึ่งแถว = serve จบหนึ่งครั้งของ invocation นี้
      //      (r7 M1.1-1 — ไม่อาศัยข้อสมมติ timeout ของ pooled session)
      // (ii) error block ของ db ที่ผูก invocation: รูปเดียวที่ "serve จบแล้วไร้
      //      CLF line" คือ P0002-raise ข้อความไทยที่ gateway ตัดขาคอร์ด (probe
      //      2026-09-15 `.omc/artifacts/probe-p0002-run2.log`: 500 opaque + rest
      //      เงียบสนิท + db container มี block ERROR/CONTEXT/parameters/STATEMENT)
      //      — เมื่อ log_parameter_max_length_on_error=-1 parameters line พิมพ์
      //      bind $1 เต็มเป็น JSON ที่มี p_request_id = หมุดผูก invocation รายตัว
      //      (dbErrorEvidenceFence) → block ที่ผูก requestRef หนึ่งก้อน = upstream
      //      จบด้วย error ของ invocation นี้จริง
      //  · ระหว่าง poll เจอ activity ของ RPC นี้ = statement เพิ่งเริ่มหลังเข้า
      //    settle = ปฏิเสธทันที (fail-loud — ทิศสกปรกที่ guard M1-r7 พิสูจน์)
      //  · ครบหน้าต่างแล้วไร้ทั้งสองรูป = fail-closed ปฏิเสธเสมอ (gate r8 M1:
      //    "ขา CLF=0 ต้องปฏิเสธจนมีหลักฐาน completion/cancellation ที่ผูก
      //    invocation") — ทางเดิน "อนุมานจบจากการไม่เห็น" (bounds-walk ของ v5)
      //    ถูกถอด: attempt.ts เขียนก่อน fetch จึงเป็นขอบล่างของเวลาถึง upstream
      //    ไม่ใช่ขอบบน และ role bounds พิสูจน์แค่ session ใหม่ไม่ใช่ pooled session
      //    ที่ serve invocation จริง — ค่าหน้าต่างเหลือความอดทนของการเฝ้าเท่านั้น
      //  · requestRef เป็น null (RPC ไม่รับ p_request_id ใน binding) = เสียขา
      //    (ii) → ครบหน้าต่างไม่มี line = ปฏิเสธเช่นกัน (ไม่มีทางผูก error block)
      let clf = { matches: 0, restRestartedInWindow: false };
      for (;;) {
        clf = await accessLogFenceAnyStatus(attempt.cursor, {
          uaNonce: binding.ua,
          method: httpMethod,
          pathNorm: `/rpc/${rpcName}`,
        });
        if (clf.matches > 1) {
          throw new Error(
            `scenario settle ปฏิเสธ: CLF line ของ nonce กำกวม (${clf.matches} แถว) — serve ซ้ำ? (${evidence})`,
          );
        }
        if (clf.restRestartedInWindow) {
          throw new Error(`scenario settle ปฏิเสธ: rest restart ใน window — หลักฐานขาดความต่อเนื่อง (${evidence})`);
        }
        if (clf.matches === 1) {
          evidenceLeg = "clf-nonce-line";
          break;
        }
        if (binding.requestRef !== null) {
          const dbf = await dbErrorEvidenceFence(attempt.cursor.capturedAt, {
            rpcName,
            requestRef: binding.requestRef,
          });
          if (dbf.dbRestartedInWindow) {
            throw new Error(`scenario settle ปฏิเสธ: db restart ใน window — หลักฐานขาดความต่อเนื่อง (${evidence})`);
          }
          if (dbf.matches > 1) {
            throw new Error(
              `scenario settle ปฏิเสธ: error block ของ db ผูก invocation กำกวม (${dbf.matches} บล็อก) (${evidence})`,
            );
          }
          if (dbf.matches === 1) {
            evidenceLeg = "db-error-block";
            break;
          }
        }
        const busyLeg = await rpcBusy();
        if (busyLeg !== "0") {
          throw new Error(
            `scenario settle ปฏิเสธ: statement ของ RPC นี้เริ่มขึ้นระหว่างหน้าต่างเฝ้า CLF (pg_stat_activity เห็น ${busyLeg} ตัว ก่อนมี line ของ nonce) — response ที่ caller ถือไม่ใช่หลักฐานว่า invocation นี้จบแล้ว (${evidence})`,
          );
        }
        if (Date.now() >= clfDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (evidenceLeg === null) {
        throw new Error(
          `scenario settle ปฏิเสธ: ครบหน้าต่างเฝ้าแล้วไม่มีหลักฐาน terminal ของ upstream ที่ผูก invocation นี้ (ไม่มี CLF line ของ nonce${
            binding.requestRef !== null
              ? ` และไม่มี error block ของ db ที่ผูก p_request_id ${binding.requestRef}`
              : " และ invocation นี้ไม่มี requestRef ให้ผูก error block ของ db"
          }) — fail-closed ไม่ settle (gate r8 M1) (${evidence})`,
        );
      }
      // (ข) kong access line หนึ่งแถวพอดี + status ตรง — poll ภายใน 12s
      const deadline = Date.now() + 12_000;
      let fence: { matches: number; statuses: number[] } = { matches: 0, statuses: [] };
      for (;;) {
        // kong access log บันทึก path "เต็มตามที่ client ส่ง" (ตรวจจริง 2026-09-15:
        // "POST /rest/v1/rpc/complete_data_export_job HTTP/1.1" 500 31) — ต่างจาก CLF
        // ของ rest เองที่เห็น path หลัง strip_path (`/rpc/<name>`) ขา a จึงใช้คนละรูป
        fence = await kongAccessFence(attempt.cursor.capturedAt, {
          uaNonce: binding.ua,
          method: httpMethod,
          pathNorm: `/rest/v1/rpc/${rpcName}`,
        });
        if (fence.matches > 1) {
          throw new Error(
            `scenario settle ปฏิเสธ: kong access line ของ nonce กำกวม (${fence.matches} แถว) — serve ซ้ำ? (${evidence})`,
          );
        }
        if (fence.matches === 1 && fence.statuses[0] !== res.status) {
          throw new Error(
            `scenario settle ปฏิเสธ: kong line status ${fence.statuses[0]} ≠ response ${res.status} ที่ caller ถือ — หลักฐานไม่ผูกกับ invocation นี้ (${evidence})`,
          );
        }
        if (fence.matches === 1 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (fence.matches !== 1) {
        throw new Error(
          `scenario settle ปฏิเสธ: ไม่มี kong access line ของ invocation นี้หลังรอ 12s — gateway ยังไม่ปิด request (ยังค้าง/queued) = ยังไม่ terminal (${evidence})`,
        );
      }
      // (ค) หน้าต่าง 12 วิ "หลัง" kong line — การปิด response ฝั่ง gateway ไม่ใช่
      // หลักฐาน completion/cancellation ฝั่ง upstream: statement ที่ยังค้างหรือ
      // เพิ่งเริ่มทีหลัง gateway ปิด ต้องโผล่ในหน้าต่างนี้ (role bounds 8s รับประกัน
      // ว่า statement ที่เริ่มแล้วต้องจบภายใน 8s — 12s ครอบ) · poll จนครบ deadline
      // ทุก 300ms — ห้ามตรวจครั้งเดียวแล้วออก (gate r6 M1.1-ก) · หมุด activity =
      // correlation ชื่อ RPC ตาม doc ขา (ก)
      const postLineDeadline = Date.now() + 12_000;
      for (;;) {
        const busy = await rpcBusy();
        if (busy !== "0") {
          throw new Error(
            `scenario settle ปฏิเสธ: statement ของ invocation นี้โผล่/ยังรันในหน้าต่าง 12s หลัง kong line (${busy} ตัว) — gateway ปิด response ไปแล้วแต่ upstream ยังไม่ terminal (${evidence})`,
          );
        }
        if (Date.now() >= postLineDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  // (3) snapshot ใหม่หลัง terminal ยืนยันแล้วเท่านั้น (r4 M1)
  if (postTerminalAssert !== undefined) {
    await postTerminalAssert();
  }
  await invocationClose(res.invocationId, res.opKey, "settled", {
    class: "completed-evidenced(rejected|state-changed)",
    transportTarget: "kong-path",
    evidence,
    // ขาหลักฐาน terminal ที่พา settle ผ่าน (M1-r8 pin ว่า P0002 settle ด้วย
    // error block ของ db จริง ไม่ใช่ CLF line)
    ...(evidenceLeg !== null ? { evidenceLeg } : {}),
  });
}

/** probe terminal แบบ lock (ขาเดียว — ใช้ใน guard test พิสูจน์ทิศ "มี TX ถือตาราง"):
 * ยึด lock ระดับตาราง nowait ได้ = ไม่มี TX ค้างถือแถวของตารางนั้นอยู่ (TX ของ RPC
 * ใดจะ commit/rollback ก็ต้องถือ lock จนจบ) — TX อื่นถืออยู่ = NOWAIT 55P03 โยนทันที
 * ต้องครอบ begin/commit เสมอ — ตรวจจริง: LOCK TABLE เปล่า ๆ นอก transaction block
 * โดนปฏิเสธ ("LOCK TABLE can only be used in transaction blocks")
 * หมายเหตุ gate waveh-r3 M1: ขา lock อย่างเดียวพิสูจน์แค่ "ไม่มี lock ขัดแล้ว"
 * ไม่ได้ผูกกับ invocation — backend ที่ยังค้าง "ก่อนถึงตารางเป้าหมาย" (ถูกตาราง
 * ก่อนหน้า/advisory lock ในทางเดินเดียวกัน) มองไม่เห็น → ใช้ scenarioTerminalProbe
 * @param table ชื่อตารางเต็ม schema-qualified — มาจากค่าคงที่ของเทสเท่านั้น (ไม่รับ user input) */
export async function tableTerminalProbe(table: string): Promise<void> {
  await psql(`begin; lock table ${table} in access exclusive mode nowait; commit;`);
}

/** probe terminal ที่สัมพันธ์กับ invocation (gate waveh-r3 M1 · ปรับ r4 M1) — สองขา
 * ต่อเป็นลำดับเดียว ห้ามปล่อย lock ก่อนตรวจ activity (r4 จับ: ถ้า commit ก่อน
 * ตรวจสองรอบ request ที่ยังเข้าคิวอยู่จะพ้นรอบสุดท้ายแล้วเริ่มทำงานภายหลังได้):
 *  ขา lock    : ยึด ACCESS EXCLUSIVE nowait บนตารางเป้าหมาย "ค้างไว้" ตลอดการตรวจ —
 *               backend ที่กำลังจะแตะตารางนี้ต้องเข้าคิวรอเรา → state='active'
 *               เห็นในขา activity ทันที (ไม่ผ่านเงียบ) · TX อื่นถืออยู่ = 55P03 โยน
 *  ขา activity: ไม่มี backend ที่กำลังรัน RPC นี้อยู่ (state 'active' หรือ 'idle in
 *               transaction') — จับ backend ที่ยังไม่ถึงตารางเป้าหมายด้วย (ค้างที่
 *               ตารางก่อนหน้าในทางเดินเดียวกัน ซึ่งขา lock มองไม่เห็น) · ตรวจ
 *               สองรอบห่าง 350ms "ขณะถือ lock" แล้วจึง commit + ตรวจท้ายอีกรอบ
 *               (backend ที่พ้นคิวเราตอน commit ต้องเห็นที่รอบท้าย)
 *  correlation: integration config รันไฟล์เรียง (fileParallelism:false) — backend
 *  ที่ active กับ RPC นี้หลัง dispatch ของเรา = invocation ของเรา (ไม่มีไฟล์อื่น
 *  ยิง RPC เดียวกันพร้อมกัน) · ชั้น upstream-terminal ผูก nonce อยู่ที่ settleScenario
 *  (ขา 2) — probe นี้ตอบโจทย์ "backend จบ + ไม่มี TX ค้าง" · idle (พักใน pool หลัง
 *  TX จบ) ไม่นับ — กัน false positive จาก last-query ที่ค้างใน query text
 *  ขอบเขตตามจริง (ตรวจจริงใน stack 2026-09-15): backend ที่ติด lock ถูกตัดโดย
 *  lock_timeout=8s ของ role authenticator — หน้าต่าง "ยังไม่ terminal" มีขอบเขต
 *  เสมอ แม้เทสไม่ปล่อย blocker เอง
 * @param table   ตารางเป้าหมาย schema-qualified (ค่าคงที่ของเทสเท่านั้น)
 * @param rpcName ชื่อ RPC (ค่าคงที่ — ใช้ substring-match ใน pg_stat_activity.query) */
export async function scenarioTerminalProbe(table: string, rpcName: string): Promise<void> {
  const { startPsqlSession } = await import("./test-io");
  const busyCount = () =>
    psqlScalar(`
      select count(*)::text from pg_stat_activity
       where query like '%${rpcName}%'
         and state in ('active', 'idle in transaction')
         and pid <> pg_backend_pid();`);
  const session = await startPsqlSession("scenario-terminal-probe");
  try {
    await session.exec("begin;");
    await session.exec(`lock table ${table} in access exclusive mode nowait;`);
    for (let round = 0; round < 2; round += 1) {
      const busy = await busyCount();
      if (busy !== "0") {
        throw new Error(
          `scenario probe: backend ยังรัน ${rpcName} อยู่ (${busy} ตัว) — invocation ยังไม่ terminal`,
        );
      }
      if (round === 0) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    await session.exec("commit;");
  } catch (err) {
    // assert กลางทางล้มก็ห้ามทิ้ง lock ค้าง — ปล่อยก่อนโยนต่อเสมอ
    await session.exec("rollback;").catch(() => undefined);
    throw err;
  } finally {
    await session.end();
  }
  // รอบท้ายหลัง commit: backend ที่เพิ่งพ้นคิวของเราและกำลังวิ่งต่อต้องเห็นที่นี่
  const tail = await busyCount();
  if (tail !== "0") {
    throw new Error(
      `scenario probe (tail): backend ยังรัน ${rpcName} อยู่ (${tail} ตัว) — invocation ยังไม่ terminal`,
    );
  }
}

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ────────────────────────────────────────────────

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly accessToken: string;
  /**
   * refresh token จริงของ session ที่ login ได้มา (gate g-p1-r3) — จำเป็นกับเคส
   * regression ของ middleware ที่ต้องการให้ GoTrue ตอบ rotation สำเร็จจริง
   * (ค่าปลอมทำให้ refresh พลาด = ไม่เกิด Set-Cookie จับอะไรไม่ได้) · ห้าม log
   */
  readonly refreshToken: string;
}

/** signup → confirm ผ่าน SQL (MAILER_AUTOCONFIRM=false) → login ด้วยรหัสผ่านจริง */
export async function createTestUser(localPart: string, role?: string): Promise<TestUser> {
  const email = `${localPart}-${Date.now()}@ltc.test`;
  // GoTrue caps emails/hour (over_email_send_rate_limit) - wait 65s and retry (max 3 attempts)
  let signup = await restCall("POST", "/auth/v1/signup", {}, { email, password: TEST_PASSWORD });
  for (let attempt = 1; signup.status === 429 && attempt < 3; attempt += 1) {
    process.stderr.write(
      `signup 429 (over_email_send_rate_limit) - wait 65s then retry (${attempt + 1}/3)\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    signup = await restCall("POST", "/auth/v1/signup", {}, { email, password: TEST_PASSWORD });
  }
  const signupBody = (signup.json ?? {}) as { id?: string; msg?: string };
  if (signup.status >= 400 || typeof signupBody.id !== "string") {
    throw new Error(`signup failed (${signup.status}): ${signup.text.slice(0, 300)}`);
  }
  const userId = signupBody.id;
  // MAILER_AUTOCONFIRM=false — ยืนยันอีเมลฝั่ง DB เพื่อให้ password grant ผ่าน (dev เท่านั้น)
  // note: confirmed_at เป็น GENERATED column จาก email_confirmed_at — อัปเดตเฉพาะ email_confirmed_at
  // note: role ของ JWT ถูกต้องนับจาก signup (PB-6: compose ตั้ง
  //  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated) — ไม่ต้อง patch auth.users.role อีกต่อไป
  await psql(
    `update auth.users set email_confirmed_at = now() where id = '${userId}';`,
  );
  if (role !== undefined) {
    await assignRole(userId, role);
  }
  const login = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email, password: TEST_PASSWORD },
  );
  const loginBody = (login.json ?? {}) as { access_token?: string; refresh_token?: string };
  if (
    login.status >= 400 ||
    typeof loginBody.access_token !== "string" ||
    typeof loginBody.refresh_token !== "string"
  ) {
    throw new Error(`login failed (${login.status}): ${login.text.slice(0, 300)}`);
  }
  return {
    id: userId,
    email,
    accessToken: loginBody.access_token,
    refreshToken: loginBody.refresh_token,
  };
}

/** เพิ่มบทบาทให้ผู้ใช้ทดสอบ (role_assignments — INSERT จริงผ่าน service path เท่านั้นตาม DD §3.1) */
export async function assignRole(userId: string, role: string): Promise<void> {
  await psql(
    `insert into public.role_assignments (user_id, role, granted_by, reason)
     values ('${userId}', '${role}', null, 'integration test (c9)') on conflict do nothing;`,
  );
}

/** ลบข้อมูลของผู้ใช้ทดสอบ — ผ่าน builder กลาง D89-1 (TX เดียว · guard สามชั้น ·
 *  retry 55P03/40P01 · post-guard RAISE เมื่อเหลือแถวอ้างผู้ใช้ — เช่น NOT NULL actor
 *  ที่ suite ต้องเคลียร์เองก่อน) */
export async function deleteTestUser(userId: string): Promise<void> {
  const { runUserCleanupVia } = await import("./cleanup-builder");
  await runUserCleanupVia(psql, [userId]);
}

/** แจ้ง PostgREST โหลด schema cache ใหม่ (หลัง apply migration 0012) */
export async function reloadRestSchema(): Promise<void> {
  await psql("notify pgrst_ddl_watch;");
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

/** คืน uuid ของหลักสูตรจากรหัส */
export async function courseIdByCode(code: string): Promise<string> {
  return psqlScalar(`select id::text from public.courses where code = '${code}' limit 1;`);
}
