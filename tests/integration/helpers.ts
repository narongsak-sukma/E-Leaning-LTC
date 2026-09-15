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
 * gate waveh-r2/r3/r4 M1 (สะสม): หลักฐานต้องพิสูจน์ "backend จบจริง" และ "ผูกกับ
 * invocation นี้" ทั้งคู่ — เรียงภายในเดียว ห้ามสลับ:
 *  1. probe terminal ก่อน (scenarioTerminalProbe — ขา lock + ขา activity): backend
 *     ยังรันอยู่ = ปฏิเสธทันที ไม่รอ (fail-loud · invocation คง 'running' ให้ audit จับ)
 *  2. ขา upstream-terminal ผูกกับ invocation แยกตาม class ของ response (r4 + r5):
 *     a. status < 0 (abort/network — ไม่มี response ถึงมือ caller): CLF line ของ
 *        nonce (rest) ต้องปรากฏ "หนึ่งแถวพอดี" (completion หรือ cancellation —
 *        line 500 จาก lock_timeout 57014 ก็นับ) = PostgREST serve ครบหนึ่งครั้ง ·
 *        line ยังไม่ปรากฏ = upstream ยังไม่ terminal (request อาจยังค้างในคิว —
 *        ห้าม settle) · >1 แถว = serve ซ้ำ/กำกวม = ปฏิเสธ · singleDispatch ใน
 *        manifest ยืนยันไม่มี dispatch ซ้ำของ invocation เดียวกัน
 *     b. status ≥ 0 + body เป็น JSON: upstream serve จบ "โดยโครงสร้าง" — JSON body
 *        ได้มาจาก upstream เท่านั้น (PostgREST อนุกรมผล statement ที่จบแล้วเป็น
 *        response — เขียน body ก่อน statement จบไม่ได้) หรือเป็นการปฏิเสธของ
 *        gateway ก่อนแตะ upstream (key-auth 401 ฯลฯ — ไม่มีงานเริ่มตามหลังได้เลย)
 *        ทั้งคู่จึงไม่ต้อง fence เพิ่ม (gate r5: "response = terminal" ใช้ได้กับ
 *        class นี้ เพราะ code ตรวจที่มาของ body เองแล้ว)
 *     c. status ≥ 0 + body opaque (แกะ JSON ไม่ได้ เช่น 500 "Something went
 *        wrong" ที่ gateway ตัดขาคอร์ดของ P0002-raise): ต้องครบสามขาพิสูจน์ —
 *        (ก) kong access line ของ nonce หนึ่งแถวพอดีและ status ตรง res.status
 *            (Kong เขียน line "เมื่อปิด response" — ยังไม่มี line = request ยัง
 *            ค้างในทาง = ห้าม settle แม้ caller ถือ response แล้ว — กันเคส
 *            gateway สังเคราะห์คำตอบก่อน upstream serve)
 *        (ข) ไม่มี pg_stat_activity ผูก requestRef (p_request_id ของ invocation
 *            นี้ — ปรากฏตรงใน query text ขณะ statement รัน ตรวจจริง) = ไม่มี
 *            statement ของ invocation นี้ยังรันอยู่
 *        (ค) role authenticator ถือ statement_timeout=8s + lock_timeout=8s
 *            ตามจริง (อ่าน pg_db_role_setting ณ เวลา settle) = statement ของ
 *            role นี้มีขอบเขตเวลาเสมอ — หลักฐานเชิงโครงสร้างของ stack นี้
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
  const { invocationClose, manifestByOpKey, accessLogFenceAnyStatus, kongAccessFence, authenticatorRoleBoundsOk } =
    await import("./test-io");
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
  // (2) upstream-terminal ผูกกับ invocation นี้ (r4+r5) — แยกตาม class ของ response
  // (doc เต็มด้านบน): a. status<0 = CLF fence ของ rest · b. status≥0 + JSON body =
  // body-proven โดยโครงสร้าง · c. status≥0 + opaque = kong line หนึ่งแถว status ตรง
  // + ไม่มี activity ผูก requestRef + role bounds ตามจริง · nonce/cursor/requestRef
  // อ่านจาก ledger ของ invocation (แหล่งความจริง — ใช้ได้แม้ dispatch โยน error)
  const m = /^rpc:([a-z0-9_]+):(POST|PATCH|PUT|DELETE)$/i.exec(res.opKey);
  if (m !== null) {
    const [rpcName, httpMethod] = [m[1] as string, m[2] as string];
    const [binding] = await psqlRows<{ ua: string | null; requestRef: string | null }>(`
      select payload -> 'binding' ->> 'uaNonce' as ua,
             payload -> 'binding' ->> 'requestRef' as "requestRef"
        from test_infra.lifecycle_ledger
       where kind = 'invocation' and invocation_id = '${res.invocationId}'
       order by ts desc limit 1;`);
    const [attempt] = await psqlRows<{ cursor: { capturedAt: string; lineCount: number; restStartedAt: string } | null }>(`
      select payload -> 'logCursor' as cursor
        from test_infra.lifecycle_ledger
       where kind = 'attempt' and invocation_id = '${res.invocationId}'
       order by ts desc limit 1;`);
    if (binding?.ua === null || binding === undefined || attempt === undefined) {
      throw new Error(
        `scenario settle ปฏิเสธ: ไม่พบ nonce/attempt ของ invocation ใน ledger — ไม่มีทางพิสูจน์ upstream terminal (${evidence})`,
      );
    }
    if (res.status < 0) {
      // a. ไม่มี response ถึงมือ caller (abort/network) — CLF fence ของ rest (r4)
      if (attempt.cursor == null) {
        throw new Error(
          `scenario settle ปฏิเสธ: ไม่มี logCursor ของ invocation ใน ledger — ไม่มีหน้าต่าง access log ให้พิสูจน์ (${evidence})`,
        );
      }
      const deadline = Date.now() + 12_000; // ครอบ lock_timeout 8s ของ stack (ตรวจจริง)
      let fence = { matches: 0, restRestartedInWindow: false };
      for (;;) {
        fence = await accessLogFenceAnyStatus(attempt.cursor as { capturedAt: string; lineCount: number; restStartedAt: string }, {
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
        if (fence.matches === 1 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (fence.matches !== 1) {
        throw new Error(
          `scenario settle ปฏิเสธ: ไม่มี CLF terminal ของ invocation นี้หลังรอ 12s — upstream ยังไม่จบ (${evidence})`,
        );
      }
    } else if (res.json !== null && typeof res.json === "object") {
      // b. body-proven — JSON body มาจาก upstream ที่ serve จบแล้ว หรือ gateway
      // ปฏิเสธก่อนแตะ upstream ทั้งคู่ = ไม่มีงานเริ่มตามหลังได้ (ไม่ต้อง fence เพิ่ม)
    } else {
      // c. opaque response-in-hand (gate r5 M1) — kong line + requestRef + role bounds
      if (binding.requestRef === null || binding.requestRef === undefined) {
        throw new Error(
          `scenario settle ปฏิเสธ: opaque response แต่ไม่มี requestRef (p_request_id) ของ invocation ใน ledger — ไม่มีหมุดผูก activity (${evidence})`,
        );
      }
      if (attempt.cursor == null) {
        throw new Error(
          `scenario settle ปฏิเสธ: opaque response แต่ไม่มี logCursor ของ invocation — ไม่มีขอบเขตหน้าต่าง kong log (${evidence})`,
        );
      }
      if (!(await authenticatorRoleBoundsOk())) {
        throw new Error(
          `scenario settle ปฏิเสธ: role authenticator ไม่ถือ statement/lock_timeout=8s ตามจริง (pg_db_role_setting) — ขอบเขตเวลาของ statement ใช้พิสูจน์ไม่ได้ (${evidence})`,
        );
      }
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
      const busy = await psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%${binding.requestRef}%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);
      if (busy !== "0") {
        throw new Error(
          `scenario settle ปฏิเสธ: statement ของ invocation นี้ยังรันอยู่ (pg_stat_activity เห็น p_request_id ของ invocation นี้ ${busy} ตัว) (${evidence})`,
        );
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
