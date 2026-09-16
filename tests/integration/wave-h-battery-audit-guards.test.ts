/**
 * wave-h-battery-audit-guards.test.ts — two-way proof ของกันชนสองตัวที่ closing gate
 * waveh-r1 เป็น MAJOR (M3/M4) [#94] + กันชน scenario-settle ของ waveh-r2 M1
 *
 * M3 · audit-lifecycle-ledger: เดิม poisoned/unresolved ล้มเฉพาะ --expect-clean —
 *   `--truncate` ลำพังจึง audit ผ่านแล้วลบหลักฐาน poison ทิ้งได้ ขัด limitation 5
 *   (poison = เคลียร์มือพร้อม intent เท่านั้น) · แถม audit บนชุด invocation ว่างเปล่า
 *   คืน ok:true (ผ่านปลอม — เกิดจริงกับ audit-e2e รอบ r3: invocations:0)
 * M4 · battery-run: เดิม --keep-going ปิด fail-fast ทุก stage — health ล้มแล้วยัง
 *   ปล่อย e2e ออกไป ขัดลำดับ D-f-7 (integration → health 200 → e2e) ที่ตัวผลลัพธ์
 * M1 (waveh-r2) · settleScenario: หลักฐาน terminal ต้องพิสูจน์ด้วย probe — TX ค้าง
 *   (มี holder ถือ lock ตาราง) = ปฏิเสธ settle คง running ให้ audit จับ · ปล่อยแล้ว
 *   = settle ได้ — พิสูจน์บน dispatch จริง (P0002 opaque 500 บน job ที่ไม่มีอยู่)
 * M1 (waveh-r3) · ขา lock อย่างเดียวไม่พอ: request ค้าง "ก่อนถึงตารางเป้าหมาย"
 *   (ถูกตารางแรกในทางเดิน RPC บล็อก) มองไม่เห็นด้วย lock-only — scenarioTerminalProbe
 *   เพิ่มขา pg_stat_activity ผูกกับ invocation ของ RPC นั้น · พิสูจน์ด้วย request จริง
 *   ที่ค้างอยู่: settle ต้องถูกปฏิเสธจนกว่า request จะวิ่งจบจริง
 * M1 (waveh-r4) · probe ต้อง (ก) ถือ lock ตลอดการตรวจ activity (ปล่อยก่อนตรวจ =
 *   request ที่ยังเข้าคิวจนพ้นรอบสุดท้ายแล้วเริ่มทำงานภายหลังได้) (ข) มีหลักฐาน
 *   completion ผูกกับ invocation — CLF line ของ ua_nonce หนึ่งแถวพอดี = PostgREST
 *   serve ครบหนึ่งครั้ง (ตรวจจริง: เขียน line แม้ client abort) (ค) อ่าน snapshot
 *   "ใหม่" หลัง terminal ยืนยันเท่านั้น (postTerminalAssert) · เคสพิสูจน์ = invocation
 *   เดียว: client จบด้วย abort ขณะ backend ยังค้างก่อนตาราง (PostgREST ไม่ cancel
 *   ตาม client — ตรวจจริง) → settle ปฏิเสธ · ปล่อย blocker → งานจบจริง (nonce CLF
 *   ปรากฏ) → snapshot ใหม่ → settle ผ่าน
 * M1 (waveh-r5) · เส้นตาย "response = terminal" ใช้กับ opaque response ไม่ได้แบบ
 *   ไม่มีเงื่อนไข — code ต้องตรวจ "ที่มาของ response" เอง: JSON body = body-proven
 *   โดยโครงสร้าง · opaque ต้องครบสามขา (kong line หนึ่งแถว status ตรง + ไม่มี
 *   pg_stat_activity ผูก p_request_id ของ invocation + role authenticator
 *   ถือ timeout 8s/8s ตามจริง) · เคสพิสูจน์ = D1 ถือ 500 opaque ไว้ในมือขณะ D2
 *   ของ RPC เดียวกันยังค้าง → settle D1 ปฏิเสธ (ขา activity) จน D2 จบจริง → ผ่าน
 *   gate สามขา + snapshot ใหม่ · ทิศสกปรกของ fence: อ้าง status ไม่ตรง kong line
 *   = หลักฐานไม่ผูกกัน = ปฏิเสธ
 * M1 (waveh-r6) · (1) JSON body ไม่พิสูจน์แหล่งกำเนิด — ตรวจจริง: Kong 2.8.1
 *   สังเคราะห์ gateway error เป็น JSON (404/401 = {"message":...}) การยกเว้น
 *   "JSON = body-proven" จึงถูกยกเลิก — response-in-hand ทุกรูปร่างผ่าน fence
 *   เดียวกัน (2) fence ต้องเฝ้าหน้าต่าง "หลัง" kong line ครบ 12s (การปิด
 *   response ฝั่ง gateway ≠ upstream terminal — statement อาจเพิ่งเริ่มทีหลัง)
 *   (3) role bounds ต้องเป็นค่า effective ไม่ใช่แค่ default ใน catalog (ALTER
 *   ROLE มีผลกับ session ใหม่เท่านั้น) · เคสพิสูจน์ = invocation เดียว: ถือ
 *   response (สังเคราะห์โดย gateway ก่อน upstream serve) ขณะ upstream ของ
 *   "ตัวเอง" ยังค้าง (ผูก p_request_id รายตัว) โดย probe ที่ใช้ "ผ่าน" (lock-only
 *   บนตารางเป้าหมาย) = การปฏิเสธต้องเกิดจาก fence เอง ไม่ใช่ probe · lock ยัง
 *   ถูกถือ → lock_timeout ตัดจริง ~8s (ขาพฤติกรรมของ role bounds บน pool
 *   session ที่ serve จริง) → response จริงมาถึง → settle ผ่านทุกขา + snapshot ใหม่
 * M1 (waveh-r7) · (1) หน้าต่างของ fence ต้อง anchor ที่ "เวลา dispatch จริง" ไม่ใช่
 *   นาฬิกาคงที่จากตอนเข้า settle — คำขอที่ค้างในคิว pool ของ PostgREST (pool=10
 *   ไม่มี override — ตรวจสดด้วย postgrestPoolAcquisitionBoundMs) ไร้ backend ไร้
 *   CLF line จนได้ serve: activity ณ ตอนเข้า + kong line + หน้าต่างคงที่เห็น
 *   "มันเพิ่งเริ่มทีหลัง" ไม่ได้ · แก้ด้วยขา CLF (ข′) หน้าต่าง dispatch+acq+stmt+
 *   margin + in-poll activity (2) ขอบเขต timeout ต้องพิสูจน์ใน execution context
 *   ที่เกี่ยวข้อง — role bounds เหลือเป็นขอบเขตสนับสนุน ส่วน pooled session ที่
 *   serve จริงพิสูจน์ด้วยขาพฤติกรรม (วัดการตัด ≤9.5s จากสังเกต busy ครั้งแรก ·
 *   errcode 57014 ใช้ร่วมกัน statement/lock — ไม่ฟันธงตัวตัด) · เคสพิสูจน์ = เติม
 *   pool ให้เต็มด้วย holder 10 ตัว (RPC ต่างชื่อ = มองไม่เห็นใน busy filter ของ
 *   X) → X ตัวที่ 11 ค้างในคิว (busy=0 + CLF 0 แถว = "ยังไม่เริ่ม RPC" ตาม
 *   เงื่อนไขปิดของ gate) → dirty settle ถือ response ปลอม 504 ขณะ X ยังไม่เริ่ม
 *   → fence ปฏิเสธเองเมื่อ X ได้ slot เริ่ม statement ระหว่างเฝ้า → ทุกตัวถูกตัด
 *   โดยขอบเขตเวลาของ role → settle จริงครบทุกขา + snapshot ใหม่
 * M1 (waveh-r8) · ขา CLF=0 ของ response-in-hand ห้าม settle โดย "อนุมานจบจาก
 *   การไม่เห็น" — v5 เดินต่อเมื่อครบหน้าต่างไร้ line ไร้ activity (bounds-walk)
 *   ซึ่ง verdict r8 ตัดสินว่าเป็นการอนุมานไม่ใช่หลักฐาน (attempt.ts เขียนก่อน
 *   fetch = ขอบล่าง · role bounds พิสูจน์แค่ session ใหม่) · แก้ด้วย fence v6:
 *   หลักฐาน terminal สองรูป "หลักแรกที่ปรากฏชนะ" — CLF line ของ nonce หรือ
 *   error block ของ db ผูก p_request_id (P0002 ข้อความไทยที่ gateway ตัดขาคอร์ด
 *   มี block ใน db log เมื่อ log_parameter_max_length_on_error=-1 — probe
 *   run2) · ครบหน้าต่างไร้ทั้งสอง = fail-closed ปฏิเสธ · two-way: ทิศ ก
 *   dispatch จริง P0002 → settle ผ่านด้วยขา db-error-block (ledger close บันทึก
 *   evidenceLeg="db-error-block") · ทิศ ข invocation ปลอมไร้หลักฐาน → ปฏิเสธ
 *   ด้วยข้อความ "ไม่มีหลักฐาน terminal ของ upstream ที่ผูก invocation" → ปิด
 *   poisoned + เคลียร์มือตาม limitation 5
 * M1 (waveh-r9) · ขา db-error-block ต้องผูก invocation "จาก record เดียว" — v6
 *   มองย้อน 8 แถวแล้ว some() แยกกัน จึงประกอบ "ERROR จาก block หนึ่ง + ชื่อ RPC
 *   จาก STATEMENT ของ block ก่อนหน้า + parameters ของ block อื่น" เป็นหลักฐาน
 *   ปลอมได้ (codex พิสูจน์ด้วย input จำลองรอบ r9: matches=1) และ requestRef
 *   ไม่ได้รับประกันว่าเป็นของ invocation เดียว · แก้ด้วย fence v7: parser
 *   PID-grouped (db-error-blocks.ts) ยอมเฉพาะ ERROR+RPC+parameters ครบใน record
 *   เดียว + หน้าต่าง anchor ที่ attempt.ts + collision check จาก ledger (ref
 *   ซ้ำ invocation อื่น = ปฏิเสธ) · two-way: pure regression บน input จำลองรูป
 *   log จริง (codex scenario → 0 บน v7 / v6 = 1) · live ทิศ ก dispatch จริงสอง
 *   ตัวใช้ p_request_id เดียวกัน → ตัวที่สองต้องปฏิเสธ "requestRef ซ้ำกับ
 *   invocation อื่น" (v6 settle ผ่าน) · live ทิศ ข invocation ปลอม opKey
 *   complete_data_export_job อ้าง requestRef ของ admin_revoke_role จริง → ปฏิเสธ
 *   ด้วยชั้น collision (หลักฐานของ invocation อื่นห้ามถูกอ้างข้าม invocation/RPC)
 *
 * two-way proof ตาม [[regression-test-two-way-proof]] ระดับฟังก์ชัน: ทิศสกปรก/ล้ม
 * ต้องถูกปฏิเสธ ทิศสะอาด/ผ่านต้องไปต่อ — ผูกกับ audit()/shouldBreakAfter ของ script
 * จริง (import ตรง ไม่ใช่สำเนา) จึงเป็นหลักฐานถาวรใน battery ทุกรอบ ไม่ใช่ probe ครั้งเดียว
 */
import { beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env["TEST_DATABASE_URL"];

type InvLastRow = { invocation_id?: string | null; op_key?: string | null; status?: string | null };
type AuditData = { invLast: InvLastRow[]; settle: unknown[]; guardRefusals: number };
type AuditResult = { failures: string[]; invocations: number; guardRefusals: number };
type AuditFn = (data: AuditData, runIds: string[], expectClean: boolean, truncate?: boolean) => AuditResult;
type ShouldBreakFn = (result: { id: string; code: number; ms: number }, keepGoing: boolean) => boolean;

let audit: AuditFn;
let shouldBreakAfter: ShouldBreakFn;

beforeAll(async () => {
  // import จาก script จริง — main() ไม่รันเพราะ direct-run guard ของ script เอง
  const auditMod = (await import("../../scripts/audit-lifecycle-ledger.mjs")) as { audit: AuditFn };
  const batteryMod = (await import("../../scripts/battery-run.mjs")) as {
    shouldBreakAfter: ShouldBreakFn;
  };
  audit = auditMod.audit;
  shouldBreakAfter = batteryMod.shouldBreakAfter;
});

const inv = (status: string): InvLastRow => ({
  invocation_id: "11111111-2222-4333-8444-555555555555",
  op_key: "test-op",
  status,
});

describe("M3 · audit-lifecycle-ledger ห้ามลบ/ผ่านหลักฐาน poison (two-way)", () => {
  it("ทิศ 1: สถานะล่าสุด poisoned + --truncate = audit ล้ม พร้อมทางเคลียร์มือ (limitation 5)", () => {
    const r = audit({ invLast: [inv("poisoned")], settle: [], guardRefusals: 0 }, ["r1"], false, true);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toContain("ห้าม truncate หลักฐาน poisoned/unresolved");
    expect(r.failures[0]).toContain("limitation 5");
  });

  it("ทิศ 1: สถานะล่าสุด unresolved + --truncate = ล้มเช่นกัน", () => {
    const r = audit({ invLast: [inv("unresolved")], settle: [], guardRefusals: 0 }, ["r1"], false, true);
    expect(r.failures.length).toBe(1);
  });

  it("ทิศ 1 (กฎเดิมคงอยู่): running leftover ล้มทุกโหมด แม้ไม่มี flag ใด", () => {
    for (const [ec, tr] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const r = audit({ invLast: [inv("running")], settle: [], guardRefusals: 0 }, ["r1"], ec, tr);
      expect(r.failures.length).toBe(1);
      expect(r.failures[0]).toContain("leftover ห้ามทิ้งค้าง");
    }
  });

  it("ทิศ 2: settled ครบ + --truncate (ไม่มี --expect-clean) = ผ่าน — ทาง truncate ที่ชอบธรรมยังใช้ได้", () => {
    const r = audit({ invLast: [inv("settled")], settle: [], guardRefusals: 0 }, ["r1"], false, true);
    expect(r.failures).toEqual([]);
  });

  it("ทิศ 2 (เดิมคงอยู่): ไม่มี flag ใด + settled = ผ่าน (audit อ่านอย่างเดียว)", () => {
    const r = audit({ invLast: [inv("settled")], settle: [], guardRefusals: 0 }, ["r1"], false, false);
    expect(r.failures).toEqual([]);
  });

  it("ผ่านปลอมปิด: --expect-clean บนชุด invocation ว่างเปล่า = ล้ม (audit-e2e r3 เคย ok:true ที่ invocations:0)", () => {
    const r = audit({ invLast: [], settle: [], guardRefusals: 0 }, ["e2e"], true, false);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toContain("ผ่านปลอม");
  });
});

describe("M4 · battery-run health ล้มห้ามปล่อย e2e แม้ --keep-going (two-way)", () => {
  it("ทิศ 1: health ล้ม + keep-going = หยุดทันที (เดิมไปต่อไป e2e)", () => {
    expect(shouldBreakAfter({ id: "health", code: 1, ms: 1000 }, true)).toBe(true);
  });

  it("ทิศ 2: health ผ่าน + keep-going = ไปต่อถึง e2e ได้", () => {
    expect(shouldBreakAfter({ id: "health", code: 0, ms: 1000 }, true)).toBe(false);
  });

  it("พฤติกรรมเดิมคงอยู่: stage อื่นล้ม + keep-going = ไปต่อ · ล้มไร้ keep-going = หยุด · ผ่าน = ไปต่อ", () => {
    expect(shouldBreakAfter({ id: "unit", code: 1, ms: 1 }, true)).toBe(false);
    expect(shouldBreakAfter({ id: "integration", code: 1, ms: 1 }, true)).toBe(false);
    expect(shouldBreakAfter({ id: "unit", code: 1, ms: 1 }, false)).toBe(true);
    expect(shouldBreakAfter({ id: "e2e", code: 0, ms: 1 }, true)).toBe(false);
  });
});

// ─── M1 (gate waveh-r9): parser ของขา db-error-block ต้องผูกหลักฐานจาก record ──
// เดียว (PID-grouped) — pure regression บน input จำลอง "รูป header จริง" ที่ตรวจ
// จาก container จริง 2026-09-15 (docker compose logs db --timestamps): แถว header
// มี `[PID] user@db LEVEL:` ทุกข้อความของ Postgres · แถวต่อ (parameters) tab-indent
// ไร้ header · ทิศสกปรกหลัก = scenario ที่ codex ใช้พิสูจน์ v6 หลอก (matches=1):
// block ของ complete_data_export_job (ref อื่น) ตามด้วย block ของ RPC อื่นที่ถือ
// ref เป้าหมาย — v6 ยืม "ERROR + STATEMENT ชื่อ RPC" จากสองก้อน · v7 ต้องปฏิเสธ ·
// r10 เพิ่ม 3 กรณี false-positive ของ v7 (ref/RPC จากข้อความ ERROR หรือค่า
// p_reason ของ bind — codex transpile-mock ได้ matches=1 ทั้งสาม) → v8 ต้อง
// ปฏิเสธทั้งหมดโดย genuine ยังผ่านทั้งรูปมี STATEMENT และรูป live ไร้ STATEMENT
describe("M1 (waveh-r9→r10) · db error-block parser ผูกหลักฐานจาก record เดียวและแหล่งที่ถูกต้อง (two-way บน input จำลองรูป log จริง)", () => {
  const hdr = (pid: number, level: string, msg: string) =>
    `ltc-dev-db  | 2026-09-15T14:13:43.947396879Z 172.20.0.6 2026-09-15 14:13:43.947 UTC [${pid}] authenticator@postgres ${level}:  ${msg}`;
  const cont = (msg: string) => `\t${msg}`;
  const params = (ref: string) =>
    cont(`unnamed portal with parameters: $1 = '{"p_job_id":"00000000-0000-4000-8000-000000000942","p_request_id":"${ref}"}'`);
  /** bind $1 ค่า JSON ใด ๆ (r10: พิสูจน์การอ่าน field จากค่าที่ parse ได้ ไม่ใช่การ grep ข้อความ) */
  const paramsJson = (value: unknown) =>
    cont(`unnamed portal with parameters: $1 = '${JSON.stringify(value)}'`);

  it("ทิศ ก: block จริง (ERROR+CONTEXT+parameters+STATEMENT record เดียว) → match 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(101, "LOG", "duration: 1.2 ms statement: SELECT 1"),
      hdr(101, "ERROR", "ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)"),
      hdr(101, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      params("ref-x"),
      hdr(101, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."complete_data_export_job"(...) ...)'),
    ];
    const m = matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" });
    expect(m, "block ที่ครบทั้งสามหลักฐานใน record เดียวต้อง match").toHaveLength(1);
    expect(m[0]?.pid).toBe(101);
  });

  it("ทิศ ข (codex scenario): block ของ RPC เป้าหมาย (ref อื่น) ตามด้วย block ของ RPC อื่นที่ถือ ref เป้าหมาย → ต้อง 0 (v6 = 1)", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      // block ก้อนที่ 1: RPC เป้าหมาย แต่ ref อื่น
      hdr(101, "ERROR", "ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)"),
      hdr(101, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      params("ref-other"),
      hdr(101, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."complete_data_export_job"(...) ...)'),
      // block ก้อนที่ 2 (PID ใหม่ = backend session ใหม่): RPC อื่น ถือ ref เป้าหมาย
      hdr(202, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(202, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(202, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."admin_revoke_role"(...) ...)'),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ห้ามยืม ERROR ของก้อนที่ 2 มาประกอบกับ STATEMENT ชื่อ RPC ของก้อนที่ 1 — v6 ทำแบบนี้ (codex r9: matches=1)",
    ).toHaveLength(0);
    // ทิศตรงข้ามยังต้องจับได้: probe ของ RPC ที่ถือ ref จริง (record เดียวกันครบ)
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
  });

  it("ทิศ ค: STATEMENT ของ PID อื่นปิด record ก่อน parameters → หลักฐานข้าม session ไม่นับ", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(101, "ERROR", "ข้อผิดพลาดของ session 101"),
      hdr(303, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."complete_data_export_job"(...) ...)'),
      params("ref-x"),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "parameters ที่มาหลัง header ของ PID อื่นต้องไม่ถูกเย็บเข้า record ของ ERROR เดิม",
    ).toHaveLength(0);
  });

  it("ทิศ ง: ระดับไม่ใช่ ERROR (LOG) ไม่เปิด record — parameters+RPC ใน LOG ไม่นับ + แยก invocation ของ RPC เดียวกันด้วย ref", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const logOnly = [
      hdr(404, "LOG", 'execute fetch_from_cursor: "complete_data_export_job"'),
      params("ref-x"),
    ];
    expect(
      matchDbErrorBlocks(logOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "record ของ fence เริ่มที่ ERROR เท่านั้น — LOG แม้มี needle ครบก็ไม่ใช่หลักฐาน terminal",
    ).toHaveLength(0);
    // RPC เดียวกัน สอง invocation (สอง ref): probe ต้องจับเฉพาะ record ที่ถือ ref นั้น
    const two = [
      hdr(501, "ERROR", "ไม่พบงานส่งออก (ก้อนของ ref-1)"),
      hdr(501, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      params("ref-1"),
      hdr(502, "ERROR", "ไม่พบงานส่งออก (ก้อนของ ref-2)"),
      hdr(502, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      params("ref-2"),
    ];
    const m2 = matchDbErrorBlocks(two, { rpcName: "complete_data_export_job", requestRef: "ref-2" });
    expect(m2).toHaveLength(1);
    expect(m2[0]?.pid).toBe(502);
    expect(m2[0]?.lines.join("\n")).toContain('"p_request_id":"ref-2"');
    expect(m2[0]?.lines.join("\n")).not.toContain('"p_request_id":"ref-1"');
  });

  // ─── r10 (gate waveh-r10 M1): v7 ยัง includes() ทุกแถวของ record จึงรับ
  // "ข้อความธรรมดา" เป็นหลักฐาน ref/RPC ได้ 3 กรณี (codex พิสูจน์ด้วย
  // transpile-mock จริง: ทั้งสามกรณี v7 ได้ matches=1) — v8 ต้องปฏิเสธทั้งหมด:
  // ref มาจาก field p_request_id ของ bind ที่ parse ได้เท่านั้น · ชื่อ RPC มาจาก
  // บรรทัด CONTEXT/STATEMENT ของ record เท่านั้น (ไม่ใช่ข้อความ ERROR / ค่า param)

  it("ทิศ จ (r10 กรณี 3): ERROR ฝัง ref/RPC เป้าหมายในข้อความ แต่ไร้ bind parameters → 0 (v7 = 1)", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const spoof = JSON.stringify({ p_request_id: "ref-x", rpc: "complete_data_export_job" });
    const lines = [
      hdr(202, "ERROR", `invalid input syntax for type uuid: "${spoof}"`),
      hdr(202, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      hdr(202, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."complete_data_export_job"(...) ...)'),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ไร้ bind parameters = ไร้หมุดผูก invocation — ข้อความ ERROR ที่สะท้อนค่าข้อมูลไม่ใช่หลักฐาน (r10: v7 ได้ 1)",
    ).toHaveLength(0);
  });

  it("ทิศ ฉ (r10 กรณี 4 — ตัวอย่างของ codex): ERROR สะท้อน ref/RPC เป้าหมาย แต่ bind จริง (รูป header CONTEXT) ถือ ref อื่น และ STATEMENT เรียก RPC อื่น → 0 (v7 = 1) · เจ้าของจริงยัง match 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const spoof = JSON.stringify({ p_request_id: "ref-x", rpc: "complete_data_export_job" });
    const lines = [
      hdr(202, "ERROR", `invalid input syntax for type uuid: "${spoof}"`),
      // รูป parameters ใน header CONTEXT (จับจริงจาก container 2026-09-14:
      // "CONTEXT:  unnamed portal parameter $1 = '…'" ไร้โคลอน) — bind จริงถือ ref อื่น
      hdr(
        202,
        "CONTEXT",
        `unnamed portal parameter $1 = '${JSON.stringify({
          p_user_id: spoof,
          p_role: "instructor",
          p_reason: "m1r10-guard",
          p_request_id: "ref-other",
        })}'`,
      ),
      hdr(202, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."admin_revoke_role"(...) ...)'),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ref-x อยู่ในข้อความ ERROR เท่านั้น ไม่ใช่ field p_request_id ของ bind จริง (r10: v7 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-other" }),
      "เจ้าของจริงของ record (bind ถือ ref-other + STATEMENT เรียก admin_revoke_role) ยังต้อง match — ไม่ over-reject",
    ).toHaveLength(1);
  });

  it("ทิศ ช (r10 กรณี 5): ชื่อ RPC เป้าหมายอยู่เฉพาะในค่า p_reason ของ bind parameters → 0 (v7 = 1) · RPC จริงของ record ยัง match 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(202, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(202, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      paramsJson({ p_request_id: "ref-x", p_reason: "โปรดเรียก complete_data_export_job แทน" }),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ชื่อ RPC ในค่า p_reason เป็นข้อมูล ไม่ใช่โครงสร้างของ record — ต้องมาจาก CONTEXT/STATEMENT เท่านั้น (r10: v7 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "record เดียวกัน: bind ถือ ref-x เป๊ะ + CONTEXT ระบุ admin_revoke_role = ของจริงต้องผ่าน",
    ).toHaveLength(1);
  });

  // ─── r11 (gate waveh-r11 MAJOR): v8 ยังไม่จำแนก "บทบาทของบรรทัด" ก่อนอ่าน —
  // ข้อความ ERROR ที่ฝังรูป bind ปลอม / ชื่อฟังก์ชันปลอมใน "ค่า" bind บนบรรทัด
  // CONTEXT ชนิด portal-parameters / ชื่อ RPC ใน SQL string literal ของ
  // STATEMENT — codex transpile-mock จริง: ทั้งสี่กรณี v8 ได้ matches=1 —
  // v9 จำแนกบทบาทก่อน (ERROR ไม่ให้หลักฐานเลย · bind เฉพาะ 3 ตำแหน่ง
  // โครงสร้าง · ชื่อ RPC จาก CONTEXT เฉพาะ payload ที่ "เริ่มด้วย" PL/pgSQL
  // function · STATEMENT ตัด literal/comment ก่อนหา)

  it("ทิศ ญ (r11 MAJOR-1a): ข้อความ ERROR ฝังรูป bind ปลอม ไร้ bind จริง → 0 (v8 = 1)", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(707, "ERROR", `failure unnamed portal with parameters: $1 = '${JSON.stringify({ p_request_id: "ref-x" })}'`),
      hdr(707, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      hdr(707, "STATEMENT", 'WITH pgrst_source AS (SELECT ... "public"."complete_data_export_job"(...) ...)'),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ข้อความของ ERROR เป็นข้อมูล ไม่ใช่แถว bind parameters — การ parse JSON สำเร็จไม่พิสูจน์แหล่งที่มา (r11: v8 ได้ 1)",
    ).toHaveLength(0);
  });

  it("ทิศ ฎ (r11 MAJOR-1b): ERROR ฝัง bind ปลอม ref เป้าหมาย แต่ bind จริงถือ ref อื่น → 0 (v8 = 1) · เจ้าของจริงยัง match 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(808, "ERROR", `failure unnamed portal with parameters: $1 = '${JSON.stringify({ p_request_id: "ref-x" })}'`),
      hdr(808, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 42 at RAISE"),
      params("ref-other"),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "bind เดียวที่ผูก invocation จริงคือ ref-other — ห้ามใช้ ref จากข้อความ ERROR (r11: v8 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-other" }),
      "เจ้าของ bind จริง (ref-other) ของ record เดียวกันยังต้อง match — ไม่ over-reject",
    ).toHaveLength(1);
  });

  it("ทิศ ฏ (r11 MAJOR-2): ชื่อฟังก์ชันปลอมในค่า bind บนบรรทัด CONTEXT ชนิด portal-parameters → 0 (v8 = 1) · RPC จริงจาก STATEMENT = 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(909, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(
        909,
        "CONTEXT",
        `unnamed portal parameter $1 = '${JSON.stringify({
          p_user_id: "invalid",
          p_reason: "PL/pgSQL function complete_data_export_job(uuid)",
          p_request_id: "ref-x",
        })}'`,
      ),
      hdr(909, "STATEMENT", 'WITH pgrst_source AS (SELECT * FROM "public"."admin_revoke_role"($1)) ...'),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "CONTEXT ชนิด portal-parameters ต้องให้เฉพาะค่า bind — ชื่อฟังก์ชันที่ฝังในค่า p_reason เป็นข้อมูล ไม่ใช่ execution frame (r11: v8 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "RPC ที่ STATEMENT เรียกจริง (หลังตัด literal/comment) + bind ถือ ref-x เป๊ะ = เจ้าของจริงต้องผ่าน",
    ).toHaveLength(1);
  });

  it("ทิศ ฐ (r11 MAJOR-3): ชื่อ RPC ใน SQL string literal/comment ของ STATEMENT → 0 (v8 = 1) · จุดเรียกจริง = 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1010, "ERROR", "ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)"),
      hdr(1010, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1010,
        "STATEMENT",
        `SELECT 'ดูเหมือน "public"."complete_data_export_job"(...) แต่เป็น literal' AS note, /* "public"."fake_rpc"( */ 1 AS x FROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ชื่อ RPC ใน string literal ของ STATEMENT เป็นข้อมูล ไม่ใช่จุดเรียก (r11: v8 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "fake_rpc", requestRef: "ref-x" }),
      "ชื่อ RPC ใน block comment ของ STATEMENT ก็เป็นข้อมูลเช่นกัน",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "จุดเรียกจริงนอก literal/comment ยังต้อง match — ไม่ over-reject",
    ).toHaveLength(1);
  });

  // ─── r12 (gate waveh-r12 MAJOR): stripSqlDataParts ยังไม่ตรง lexical
  // structure ของ PostgreSQL สองข้อ — codex transpile-mock จริง: (1) escape
  // string E'…' ที่ \' ไม่ปิด string → v9 ปิด literal ก่อนตำแหน่งจริง จึงนับ
  // ชื่อ RPC ใน literal เป็นจุดเรียก และกลืนโค้ดจริงที่ตามมาเข้า string ที่
  // เปิดผิด (เจ้าของจริงหาย — ทิศ STATEMENT-only) (2) block comment ซ้อนกัน
  // ได้ → v9 หยุดที่ */ แรก จึงนับชื่อใน outer comment เป็นจุดเรียก — v10
  // แก้ scanner ตามเอกสาร PG (E-string backslash-escape + นับระดับ comment)

  it("ทิศ ฑ (r12 MAJOR-1): ชื่อ RPC ใน escape string E'…\\'…' → 0 (v9 = 1) · เจ้าของจริงจาก STATEMENT หลัง literal ที่ถูกต้อง = 1 (v9 กลืนหาย)", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1201, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1201, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1201,
        "STATEMENT",
        `SELECT E'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ชื่อใน E'…\\'…' escape string เป็นข้อมูล — \\' ไม่ปิด string (PG lexical structure · r12: v9 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "เจ้าของจริง (FROM หลัง literal ปิดที่ quote จริง) ต้อง match",
    ).toHaveLength(1);
    // ทิศ STATEMENT-only (ไร้ CONTEXT — STATEMENT เป็นแหล่งชื่อเดียว): v9 เปิด
    // string ผิดที่ \\' แล้วกลืน FROM ของเจ้าของเข้า string ที่เปิดตามมา = 0 —
    // v10 ต้องกู้เจ้าของจริงคืนได้ (1) โดยชื่อปลอมยัง 0
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: ชื่อเจ้าของมาจาก STATEMENT เท่านั้น — v9 กลืนหาย (r12 ตารางผลตรวจซ้ำ: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  it("ทิศ ฒ (r12 MAJOR-2): ชื่อ RPC ใน block comment ซ้อน → 0 (v9 = 1) · จุดเรียกจริงหลัง comment ที่ปิดครบทุกระดับ = 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1202, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1202, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1202,
        "STATEMENT",
        `SELECT 1 /* outer /* inner */\n"public"."complete_data_export_job"($1) */\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "comment ของ PG ซ้อนกันได้ — ชื่อใน outer comment (หลัง */ ของ inner) เป็นข้อมูล (r12: v9 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "จุดเรียกจริงนอก comment = เจ้าของจริงต้องผ่าน",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: STATEMENT เพียงแหล่งเดียวก็ต้องได้เจ้าของจริง",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  // ─── r13 (gate waveh-r13 MAJOR): escape string ที่ "ต่อข้าม newline" —
  // PostgreSQL ให้ string literal ต่อกันเป็น string เดียวเมื่อคั่นด้วย
  // whitespace ที่มี newline อย่างน้อยหนึ่งตัว (§4.1.2.2 · quotecontinue ของ
  // scan.l อยู่ในโหมด xe ต่อ) โดย E เขียนเฉพาะส่วนแรก escape semantics คงอยู่
  // ตลอด string — v10 ปิด escape mode ที่ quote ของส่วนแรกแล้วอ่านส่วนต่อเป็น
  // string ธรรมดา → \' ในส่วนต่อปิด string ก่อนตำแหน่งจริง (codex วัดจริง:
  // เป้าหมายปลอม 1 ทั้งรูปเต็มและ STATEMENT-only · เจ้าของจริง STATEMENT-only 0)
  // — v11 ตรวจจุดต่อที่ quote ทุกตัวในโหมด E-string

  it("ทิศ ณ (r13 MAJOR): ชื่อ RPC ใน escape string ที่ต่อข้าม newline (E ส่วนแรกเท่านั้น) → 0 (v10 = 1) · เจ้าของจริง = 1 ทั้งสองรูป (STATEMENT-only v10 = 0)", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1203, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1203, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1203,
        "STATEMENT",
        `SELECT E'prefix'\n'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "escape semantics คงอยู่ตลอด string ที่ต่อกันข้าม newline — ชื่อใน literal เป็นข้อมูล (r13: v10 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "FROM หลัง literal ที่ปิดที่ quote จริง = เจ้าของจริงต้อง match",
    ).toHaveLength(1);
    // ทิศ STATEMENT-only (ไร้ CONTEXT): v10 ปิด escape mode ที่ quote แรกแล้ว
    // กลืน FROM ของเจ้าของเข้า string ธรรมดาที่เปิดตามมา (เจ้าของ 0 ตามตาราง
    // ผลตรวจซ้ำของ codex) — v11 ต้องกู้คืน 1 โดยชื่อปลอมยัง 0
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริงจาก STATEMENT เพียงแหล่งเดียว — v10 กลืนหาย (r13 ตารางผลตรวจซ้ำ: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  // ─── r14 (gate waveh-r14 MAJOR): ตัวคั่นจุดต่อของ v11 (space/tab/CR/LF
  // อย่างเดียว) ยังไม่ครบตาม quotecontinue ของ scan.l จริง — PG 15: separator
  // = horiz_whitespace* newline special_whitespace* (horiz มี form feed \f
  // และ line comment `--…` · newline = [\n\r] ตัวเดียวบังคับ — CR ลำพังนับ ·
  // special มี newline และ line comment เพิ่ม · ไม่มี block comment) แล้ว
  // เปิด string ต่อด้วย ' — codex วัดจริง: เป้าหมายปลอม 1 ทั้งรูปเต็มและ
  // STATEMENT-only · เจ้าของจริง STATEMENT-only 0 ใน 4 รูปตัวคั่น — v12
  // แยก skipQuoteContinueSeparator ตาม grammar นี้

  it("ทิศ ด (r14 MAJOR-1): จุดต่อที่คั่นด้วย line comment + LF — `E'prefix' -- c\\n'abc\\'…'` → ชื่อปลอม 0 (v11 = 1) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1204, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1204, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1204,
        "STATEMENT",
        `SELECT E'prefix' -- continuation\n'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "horiz_whitespace ของ quotecontinue มี line comment — ชื่อใน literal ต่อกันข้าม ` -- c\\n` เป็นข้อมูล (r14: v11 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "FROM หลัง literal ที่ปิดที่ quote จริง = เจ้าของจริงต้อง match",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริงจาก STATEMENT เพียงแหล่งเดียว — v11 กลืนหาย (r14 ตารางผลตรวจซ้ำ: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  it("ทิศ ต (r14 MAJOR-2): จุดต่อที่คั่นด้วย CR ลำพัง — `E'prefix'\\r'abc\\'…'` → ชื่อปลอม 0 (v11 = 1) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1205, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1205, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1205,
        "STATEMENT",
        `SELECT E'prefix'\r'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "newline ของ scan.l คือ [\\n\\r] — CR ลำพังเป็นตัวจบบรรทัดได้ (r14: v11 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริง — v11 กลืนหาย (r14: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  it("ทิศ ถ (r14 MAJOR-3): จุดต่อที่คั่นด้วย form feed + LF — `E'prefix'\\f\\n'abc\\'…'` → ชื่อปลอม 0 (v11 = 1) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1206, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1206, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1206,
        "STATEMENT",
        `SELECT E'prefix'\f\n'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "horiz_space ของ scan.l มี form feed (\\f) — ชื่อใน literal ที่ต่อกันเป็นข้อมูล (r14: v11 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริง — v11 กลืนหาย (r14: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  it("ทิศ ท (r14 MAJOR-4): จุดต่อที่คั่นด้วย LF + line comment + LF — `E'prefix'\\n -- c\\n'abc\\'…'` → ชื่อปลอม 0 (v11 = 1) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1207, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1207, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1207,
        "STATEMENT",
        `SELECT E'prefix'\n -- continuation\n'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "special_whitespace ของ quotecontinue มี line comment — ชื่อใน literal ที่ต่อกันเป็นข้อมูล (r14: v11 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริง — v11 กลืนหาย (r14: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
  });

  // ─── r15 (gate waveh-r15 MAJOR): line comment "นอก string" ของ v12 หยุดเฉพาะ
  // LF ขณะที่ comment ของ PG 15 = `--{non_newline}*` · non_newline = [^\n\r] —
  // จบได้ทั้ง CR และ LF — comment ที่จบที่ CR ทำให้โค้ดหลัง CR ถูกกลืนเข้า comment
  // ไปจนถึง LF ถัดไป (ตัวอย่างของ codex: `SELECT 1 -- c\r, E'prefix'\n'abc\'…'`)
  // → quote แรกของ E-string หาย ส่วนต่อถูกอ่านเป็น string ธรรมดา: \' ปิดก่อน
  // ตำแหน่งจริง ชื่อปลอมรั่วออกมาเป็นจุดเรียก + เจ้าของจริงถูกกลืนในรูป
  // STATEMENT-only — v13 ใช้ lineCommentEnd (CR-aware) ที่ branch comment หลัก

  it("ทิศ ธ (r15 MAJOR): line comment จบที่ CR — โค้ดหลัง CR เป็นโค้ดจริง `SELECT 1 -- c\\r, E'prefix'\\n'abc\\'…'` → ชื่อปลอม 0 (v12 = 1) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1208, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1208, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1208,
        "STATEMENT",
        `SELECT 1 -- c\r, E'prefix'\n'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "comment ของ PG จบที่ CR (non_newline = [^\\n\\r]) — `, E'prefix'` หลัง CR เป็นโค้ดจริง จุดต่อข้าม \\n พาชื่อปลอมอยู่ใน literal (r15: v12 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "FROM หลัง literal ที่ปิดที่ quote จริง = เจ้าของจริงต้อง match",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริงจาก STATEMENT เพียงแหล่งเดียว — v12 กลืนหาย (r15 ตารางผลตรวจซ้ำ: 1 → 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
    // ขอบเขต: comment ที่จบที่ CR ของ CRLF — v12 ก็ผ่านอยู่แล้ว (LF ถัดจาก CR
    // เป็นตัวจบของ v12 เพียงหนึ่งอักขระ) = คุมว่า v13 ไม่หักกรณีนี้
    const crlf = [
      hdr(1209, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1209, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1209,
        "STATEMENT",
        `SELECT 1 -- c\r\n, E'prefix'\n'abc\\' "public"."complete_data_export_job"($1) rest'\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(crlf, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(crlf, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
  });

  // ─── r16 (gate waveh-r16 MAJOR): tag ของ dollar-quote ผิด dolqdelim ของ
  // scan.l สองทาง — เดิม `[A-Za-z_][\w$]*` (1) จำกัด ASCII จึงไม่รู้จัก tag
  // อักขระสูง (dolq_start = [A-Za-z\200-\377_] รับอักขระ non-ASCII เช่น `$ก$`)
  // → ข้อความใน quote ถูกอ่านเป็นโค้ด ชื่อปลอมรั่ยเป็นจุดเรียก (2) greedy กิน
  // `$` เข้า tag ขณะที่ dolq_cont = [A-Za-z\200-\377_0-9] ห้าม `$` → opener
  // กลืน closer `$tag$` เข้าไปใน tag `$tag$abc$tag$` หา closer ไม่เจอ กลืน
  // โค้ดที่เหลือทั้งหมด (เจ้าของจริงหายในรูป STATEMENT-only) — v14 แก้ tag
  // ตาม dolq_start/dolq_cont จริง

  it("ทิศ น (r16 MAJOR-1): tag dollar-quote อักขระสูง — `$ก$ … $ก$` → ชื่อปลอม 0 (v13 = 1 ทั้งสองรูป) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1210, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1210, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1210,
        "STATEMENT",
        `SELECT $ก$ "public"."complete_data_export_job"($1) $ก$\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "dolq_start ของ scan.l รับอักขระสูง (\\200-\\377) — ชื่อใน dollar-quote ที่มี tag ไทยเป็นข้อมูล (r16: v13 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "FROM หลัง literal ที่ปิดที่ $ก$ ตัวปิดจริง = เจ้าของจริงต้อง match",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ไร้ CONTEXT: ชื่อปลอมจาก STATEMENT เพียงแหล่งเดียวก็ต้อง 0 — v13 รั่ย (r16 ตารางผลตรวจซ้ำ: 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริงจาก STATEMENT เพียงแหล่งเดียว — v13 ยังได้อยู่ (FROM มองเห็น) ต้องคง 1",
    ).toHaveLength(1);
  });

  it("ทิศ บ (r16 MAJOR-2): `$` ใน tag ห้าม — `$tag$abc$tag$` ปิดที่ closer จริง → เจ้าของจริง STATEMENT-only 1 (v13 = 0) · ไม่มีชื่อปลอม", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1211, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1211, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1211,
        "STATEMENT",
        `SELECT $tag$abc$tag$\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "CONTEXT มีชื่ออยู่แล้ว (รูปเต็มผ่านทั้งสองเวอร์ชัน)",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "dolq_cont ห้าม $ — tag ต้องหยุดที่ tag เอง หา closer $tag$ เจอ ไม่กลืน FROM (r16: v13 กลืนหาย ตารางผลตรวจซ้ำ 1 → 0 กลับทิศ)",
    ).toHaveLength(1);
    // คุมขอบเขต: tag ว่าง ($$) และ tag ASCII ยังเป็น literal เหมือนเดิม — v13 ก็ผ่าน
    const emptyTag = [
      hdr(1212, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1212, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1212,
        "STATEMENT",
        `SELECT $$ "public"."complete_data_export_job"($1) $$\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(emptyTag, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "tag ว่าง $$…$$ ยังเป็น literal — ชื่อปลอม 0 ทั้งสองเวอร์ชัน",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks([emptyTag[0], emptyTag[2], emptyTag[3]] as typeof emptyTag, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
  });

  // ─── r17 (gate waveh-r17 MAJOR): "$" ที่ติดกับ identifier เป็น "ส่วนของชื่อ"
  // ไม่ใช่ตัวเปิด dollar-quote — scan.l ใช้ longest-match: {identifier} =
  // ident_start{ident_cont}* โดย ident_cont = [A-Za-z\200-\377_0-9\$] มี `\$` ด้วย
  // → alias `a$tag$` เป็น identifier เดียว (PG 15 §4.1.2.4) — v14 เปิด literal จาก
  // `$tag$` ใน alias: closer ไปเจอตัวเปิดจริง ชื่อ RPC ใน literal จริงจึงรั่ยเป็น
  // จุดเรียก (ปลอม 1 ทั้งสองรูป record) และตัวปิดจริงกลายเป็น opener เดินกลืน
  // FROM ของเจ้าของจริง (เจ้าของ STATEMENT-only 0) · รูป quoted identifier
  // `"$tag$"` ก็โดนเช่นกัน: v14 ปล่อย `"` ผ่านแล้ว "$" ข้างในเข้า branch dollar-quote
  // หา closer ไม่เจอ กลืนโค้ดที่เหลือทั้งหมด — v15 กิน identifier ทั้ง token (ทั้ง
  // แบบไร้ quote และแบบ `"…"` ที่ `""` = quote ในชื่อ) ออกมาก่อนแตะการตีความ
  // dollar-quote

  it("ทิศ ป (r17 MAJOR-1): alias ผูก `$` — `a$tag$` เป็น identifier เดียว ตัวเปิด literal จริงคือ `$tag$` หลัง comma → ชื่อปลอม 0 (v14 = 1 ทั้งสองรูป) · เจ้าของจริง 1 ทั้งสองรูป (v14 STATEMENT-only = 0)", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1213, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1213, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1213,
        "STATEMENT",
        `SELECT 1 AS a$tag$,\n$tag$ "public"."complete_data_export_job"($1) $tag$\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ident_cont มี $ — `$tag$` ใน alias เป็นส่วนของชื่อ ไม่ใช่ตัวเปิด literal: literal จริงเริ่มที่ $tag$ หลัง comma ชื่อปลอมอยู่ใน literal = ข้อมูล (r17: v14 ได้ 1 ทั้งสองรูป)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "FROM หลัง literal ที่ปิดที่ $tag$ ตัวปิดจริง = เจ้าของจริงต้อง match",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ไร้ CONTEXT: ชื่อปลอมจาก STATEMENT เพียงแหล่งเดียวก็ต้อง 0 — v14 รั่ย (r17 ตารางผลตรวจซ้ำ: 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: v14 ตัวปิดจริงกลายเป็น opener กลืน FROM ของเจ้าของ (r17 ตารางผลตรวจซ้ำ: 1 → 0 กลับทิศ) — v15 ต้องกู้คืน 1",
    ).toHaveLength(1);
  });

  it("ทิศ ผ (r17 MAJOR-2): quoted identifier `\"$tag$\"` และ alias `a$tag$` ไร้ literal — เจ้าของจริง STATEMENT-only 1 (v14 = 0) · quoted ident ที่มี `\"\"` ในชื่อก็จบที่ quote ปิดจริง", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const mk = (pid: number, aliasExpr: string) => [
      hdr(pid, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(pid, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(pid, "STATEMENT", `SELECT 1 AS ${aliasExpr}\nFROM "public"."admin_revoke_role"($1)`),
    ];
    const unq = mk(1214, "a$tag$");
    const quo = mk(1215, '"$tag$"');
    // รูปเต็ม (CONTEXT มีชื่ออยู่แล้ว — ผ่านทั้งสองเวอร์ชัน)
    expect(
      matchDbErrorBlocks(unq, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks(quo, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
    ).toHaveLength(1);
    // STATEMENT-only (ไร้ CONTEXT): v14 กลืน FROM ทั้งสองรูป (unq: alias `$tag$`
    // เปิด literal หา closer ไม่เจอ · quo: "$" ใน quoted ident เปิด literal กลืน
    // ทั้งบรรทัด) = 0 — v15 กิน identifier ทั้ง token ก่อน = 1
    expect(
      matchDbErrorBlocks([unq[0], unq[2], unq[3]] as typeof unq, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: `a$tag$` เป็น identifier เดียว — FROM เป็นโค้ด (r17 ตารางผลตรวจซ้ำ: v14 ได้ 0)",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks([quo[0], quo[2], quo[3]] as typeof quo, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: ชื่อใน quote มีอักขระใดก็ได้รวม $ — token จบที่ quote ปิด (r17 ตารางผลตรวจซ้ำ: v14 ได้ 0)",
    ).toHaveLength(1);
    // ขอบเขต quoted ident: `""` ในชื่อ = quote หนึ่งตัว — token ต้องจบที่ quote
    // ปิดจริง ไม่ใช่ที่ `$tag$` แรกที่พบข้างใน (v14 กลืนทั้งบรรทัด = 0)
    const dq = mk(1216, '"x""y$tag$"');
    expect(
      matchDbErrorBlocks([dq[0], dq[2], dq[3]] as typeof dq, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "`\"\"` = quote ในชื่อ — quoted identifier กิน token เดียวจบที่ quote ปิดจริง FROM ยังเป็นโค้ด",
    ).toHaveLength(1);
  });

  // ─── r18 (gate waveh-r18 MAJOR): branch quoted identifier ของ v15 กิน token
  // ครบแต่ emit ข้อความตรง ๆ ต่อ ทำให้ STATEMENT_CALL_RES ตีความข้อความภายใน
  // ชื่อเป็น keyword/การเรียกฟังก์ชันได้ — `"x' FROM public.<rpc>($1) 'y"` เป็น
  // alias เดียวตาม §4.1.1 (quoted identifier ฝังอักขระใดก็ได้) แต่ v15 ได้ชื่อ
  // ปลอม 1 ทั้งสองรูป record — v16 คลี่ escape `""` แล้วส่งชื่อต่อเฉพาะที่
  // ประกอบจากอักขระ identifier ล้วน ๆ ชื่ออื่นแทนที่ทั้ง token ด้วย `""`

  it("ทิศ ฝ (r18 MAJOR-1): ชื่อปลอมใน quoted identifier `\"x' FROM … ($1) 'y\"` — ข้อความในชื่อไม่ใช่การเรียก → ชื่อปลอม 0 ทั้งสองรูป (v15 = 1/1) · เจ้าของจริง 1 ทั้งสองรูป", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const lines = [
      hdr(1217, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1217, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(
        1217,
        "STATEMENT",
        `SELECT 1 AS "x' FROM public.complete_data_export_job($1) 'y"\nFROM "public"."admin_revoke_role"($1)`,
      ),
    ];
    expect(
      matchDbErrorBlocks(lines, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "\"x' FROM … ($1) 'y\" เป็นชื่อเดียว (§4.1.1) — ข้อความภายในชื่อไม่ใช่ keyword/การเรียก (r18 ตารางผลตรวจซ้ำ: v15 ได้ 1 เต็ม/STATEMENT-only)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(lines, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "FROM ของเจ้าของจริงเป็นโค้ดนอก quoted identifier — ยัง match 1 ทั้งสองเวอร์ชัน (r18: v15/v14 ได้ 1/1)",
    ).toHaveLength(1);
    const stmtOnly = [lines[0], lines[2], lines[3]] as typeof lines;
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ไร้ CONTEXT: STATEMENT เป็นแหล่งเดียวก็ต้อง 0 — v15 รั่ย (r18 ตาราง: 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(stmtOnly, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริงจาก STATEMENT เพียงแหล่งเดียว = 1",
    ).toHaveLength(1);
  });

  it("ทิศ ฟ (r18 MAJOR-2): รูป `\"x-- FROM … ($1)\"` ผลเดียวกันทั้งสองรูป record · ชื่อที่มีอักขระนอก identifier แทนที่ทั้ง token ด้วย `\"\"` — `\"pu'blic\"` ไม่ปลอมตัวเป็น schema public ได้", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    const mk = (pid: number, aliasExpr: string) => [
      hdr(pid, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(pid, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(pid, "STATEMENT", `SELECT 1 AS ${aliasExpr}\nFROM "public"."admin_revoke_role"($1)`),
    ];
    const dash = mk(1218, '"x-- FROM public.complete_data_export_job($1)"');
    expect(
      matchDbErrorBlocks(dash, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "`--` ในชื่อไม่เปิด comment และข้อความทั้งชื่อไม่ใช่การเรียก — รูปเต็มก็ต้อง 0 (r18: v15 ได้ 1)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks(dash, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "เจ้าของจริงรูปเต็ม = 1 ทั้งสองเวอร์ชัน",
    ).toHaveLength(1);
    expect(
      matchDbErrorBlocks([dash[0], dash[2], dash[3]] as typeof dash, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "ไร้ CONTEXT: STATEMENT เพียงแหล่งเดียวต้อง 0 — v15 รั่ย (r18: อีกตัวอย่างที่ให้ผลเหมือนกัน)",
    ).toHaveLength(0);
    expect(
      matchDbErrorBlocks([dash[0], dash[2], dash[3]] as typeof dash, { rpcName: "admin_revoke_role", requestRef: "ref-x" }),
      "ไร้ CONTEXT: เจ้าของจริง = 1",
    ).toHaveLength(1);
    // ขอบเขตการแทนที่: แทนที่ "ทั้ง token" ไม่ใช่ตัดอักขระนอก identifier ทิ้ง —
    // การตัดจะเย็น `"pu'blic"` เป็น `"public"` แล้ว `"public"."<rpc>"(` กลายเป็น
    // จุดเรียกของ schema public (ปลอม) — แทนที่ทั้ง token ให้ `""` จึงเงียบ
    const masquerade = [
      hdr(1219, "ERROR", "ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)"),
      hdr(1219, "CONTEXT", "PL/pgSQL function admin_revoke_role(uuid,text,text,text) line 50 at RAISE"),
      params("ref-x"),
      hdr(1219, "STATEMENT", `SELECT 1 AS "pu'blic"."complete_data_export_job"($1)`),
    ];
    expect(
      matchDbErrorBlocks([masquerade[0], masquerade[2], masquerade[3]] as typeof masquerade, { rpcName: "complete_data_export_job", requestRef: "ref-x" }),
      "schema `\"pu'blic\"` ≠ public — ชื่อที่มีอักขระนอก identifier ต้องหายทั้ง token ไม่กลายเป็น `\"public\"` ในสายตา regex",
    ).toHaveLength(0);
  });

  it("ทิศ ก2 (รูปจริงจาก live stack 2026-09-15): genuine P0002 = ERROR+CONTEXT+parameters ไร้ STATEMENT → ยัง match 1", async () => {
    const { matchDbErrorBlocks } = await import("./db-error-blocks");
    // record จริงที่จับได้จาก container (probe-p0002-run2 / M1-r9 live): RAISE ผ่าน
    // PostgREST มี ERROR + CONTEXT(PL/pgSQL function) + parameters ไร้ header
    // เท่านั้น — v8 ห้าม over-reject เพราะไม่บังคับ STATEMENT (ชื่อ RPC มาจาก
    // CONTEXT ของ plpgsql ได้)
    const lines = [
      hdr(1452373, "ERROR", "ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)"),
      hdr(1452373, "CONTEXT", "PL/pgSQL function complete_data_export_job(uuid,uuid,integer,text,uuid) line 15 at RAISE"),
      params("probe-p0002-req-1"),
    ];
    const m = matchDbErrorBlocks(lines, {
      rpcName: "complete_data_export_job",
      requestRef: "probe-p0002-req-1",
    });
    expect(m, "genuine รูป live (ไร้ STATEMENT) ต้องผ่าน — v8 อ่านชื่อ RPC จาก CONTEXT ของ plpgsql").toHaveLength(1);
    expect(m[0]?.pid).toBe(1452373);
  });
});

// ─── M1 (gate waveh-r2): settleScenario ปฏิเสธเมื่อ probe terminal ล้ม ─────────
// dispatch จริงแบบ scenario (P0002 opaque 500 บน job ที่ไม่มีอยู่ — TX abort ไม่แตะ
// ข้อมูลใคร) แล้วพิสูจน์สองทิศด้วย holder จริง: มี TX ถือ lock ตารางงาน = probe ล้ม
// → settle ถูกปฏิเสธ invocation คง 'running' · ปล่อย lock = probe ผ่าน → settle ได้

describe.skipIf(!DB_URL)("M1 (waveh-r2) · settleScenario ต้องพิสูจน์ terminal ก่อน settle (two-way บน dispatch จริง)", () => {
  it("TX ถือ lock ตารางงาน = ปฏิเสธ settle คง running · ปล่อยแล้ว = settle ได้", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { restCall, settleScenario, tableTerminalProbe, psqlScalar, SERVICE_KEY } =
      await import("./helpers");
    const res = await restCall(
      "POST",
      "/rest/v1/rpc/complete_data_export_job",
      { apiKey: SERVICE_KEY, token: SERVICE_KEY, settleMode: "scenario" },
      {
        p_job_id: "00000000-0000-4000-8000-0000000000f1", // job ที่ไม่มีอยู่ → P0002 opaque 500
        p_file_media_id: "00000000-0000-4000-8000-0000000000f2",
        p_chunks: 1,
        p_request_id: crypto.randomUUID(),
        p_claim_token: crypto.randomUUID(),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.invocationId).toBeDefined();
    const invStatus = async () =>
      psqlScalar(`
        select payload ->> 'status' from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${res.invocationId}'
         order by ts desc, id desc limit 1;`);

    const { startPsqlSession } = await import("./test-io");
    const session = await startPsqlSession("scenario-guard-lock-holder");
    try {
      await session.exec("begin;");
      await session.exec("lock table public.data_export_jobs in access exclusive mode;");
      // ทิศล้ม: backend "ยังไม่จบ" (มี holder) — settle ต้องถูกปฏิเสธ ไม่ใช่เขียน settled ทิ้ง
      await expect(
        settleScenario(res, "guard-neg-backend-busy", () => tableTerminalProbe("public.data_export_jobs")),
      ).rejects.toThrow(/could not obtain lock on relation/i);
      expect(await invStatus()).toBe("running");
    } finally {
      // rollback ครั้งเดียวตรงนี้ (ปล่อย lock เสมอ แม้ assert กลางทางล้ม)
      await session.exec("rollback;");
      await session.end();
    }
    // ทิศผ่าน: ไม่มี holder แล้ว — probe ผ่าน → settle ได้
    await settleScenario(res, "guard-neg-terminal-proven(lock-free)", () =>
      tableTerminalProbe("public.data_export_jobs"));
    expect(await invStatus()).toBe("settled");
  }, 75_000);

  // ─── M1 (gate waveh-r3): ช่องว่างของ lock-only — request ค้าง "ก่อนถึงตารางเป้าหมาย" ──
  // complete_data_export_job แตะ public.data_export_jobs ก่อน (select … for update
  // 0039:104) แล้วจึงแตะ event_outbox/audit_logs ทีหลัง — ถือ ACCESS EXCLUSIVE บน
  // data_export_jobs ไว้ = request จริง (D2) ค้างอยู่ก่อนตารางเป้าหมาย (event_outbox)
  //  · กลางนั้น ยังต้องปฏิเสธ settle ของ invocation อื่นที่รอหลักฐานอยู่ (D1) —
  //    lock-only probe บน event_outbox "ผ่าน" (หลุดรอด = ช่องว่างที่ gate จับ) แต่
  //    scenarioTerminalProbe (lock + pg_stat_activity) ต้องจับ backend ที่ค้างอยู่
  //    ได้ → settleScenario ปฏิเสธ ไม่เขียน settled ก่อนงานจบ
  //  · ปล่อย blocker → D2 วิ่งจบ (P0002 opaque 500) → activity เคลียร์ → settle
  //    ทั้ง D1/D2 ผ่าน ไม่ทิ้ง running ค้าง
  it("request เดิมค้างก่อนถึงตารางเป้าหมาย = ปฏิเสธ settle ด้วยขา activity (ช่องว่าง lock-only ของ waveh-r3 M1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { REPO_ROOT, restCall, settleScenario, tableTerminalProbe, scenarioTerminalProbe, psqlScalar, SERVICE_KEY } =
      await import("./helpers");
    // หยุด mailer กัน phantom ของ busy-count รายชื่อ RPC: dev worker ยิง
    // complete_data_export_job เองเป็นรอบ (~15-30s · ตรวจจริง 2026-09-15: PID
    // เดียวยิงซ้ำ และบล็อกบน lock ของเทสจนโดน role bounds ตัด) — busyCount กรอง
    // ด้วยชื่อ RPC จึงไม่แยก backend ของเทสกับของ worker (pattern M1-r7/8/9 ·
    // เจอจริง guards rerun รอบ r20 ที่ M1-r4)
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();
    const dispatchBody = () => ({
      p_job_id: "00000000-0000-4000-8000-0000000000f3", // job ไม่มีอยู่ → P0002 opaque 500
      p_file_media_id: "00000000-0000-4000-8000-0000000000f4",
      p_chunks: 1,
      p_request_id: crypto.randomUUID(),
      p_claim_token: crypto.randomUUID(),
    });
    // D1: invocation ที่ตอบกลับมาแล้ว (ถือค้างรอหลักฐาน — ตัวที่จะถูกพยายาม settle)
    const d1 = await restCall(
      "POST",
      "/rest/v1/rpc/complete_data_export_job",
      { apiKey: SERVICE_KEY, token: SERVICE_KEY, settleMode: "scenario" },
      dispatchBody(),
    );
    expect(d1.status).toBeGreaterThanOrEqual(500);
    expect(d1.invocationId).toBeDefined();
    const invStatus = (id: string | undefined) =>
      psqlScalar(`
        select payload ->> 'status' from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${id}'
         order by ts desc, id desc limit 1;`);
    const probe = () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job");

    const { startPsqlSession } = await import("./test-io");
    const session = await startPsqlSession("scenario-guard-pretable-holder");
    try {
      await session.exec("begin;");
      await session.exec("lock table public.data_export_jobs in access exclusive mode;");
      // D2: ยิงแล้ว "ห้าม await" — ค้างรอ lock ตารางแรกของทางเดิน RPC อยู่
      const d2 = restCall(
        "POST",
        "/rest/v1/rpc/complete_data_export_job",
        { apiKey: SERVICE_KEY, token: SERVICE_KEY, settleMode: "scenario" },
        dispatchBody(),
      );
      // รอ backend ของ D2 ปรากฏจริงใน pg_stat_activity — หลักฐานว่ามันกำลังทำงาน
      // อยู่ "ก่อนตารางเป้าหมาย" (ยังไม่เคยแตะ event_outbox เลย)
      let busy = "0";
      for (let i = 0; i < 50 && busy === "0"; i += 1) {
        busy = await psqlScalar(`
          select count(*)::text from pg_stat_activity
           where query like '%complete_data_export_job%'
             and state in ('active', 'idle in transaction')
             and pid <> pg_backend_pid();`);
        if (busy === "0") await new Promise((r) => setTimeout(r, 100));
      }
      expect(busy, "D2 ต้องค้างเป็น backend active จริงก่อนตรวจขั้นถัดไป").toBe("1");
      // ช่องว่างที่ gate r3 จับ (แสดงเป็นหลักฐานในเทส): lock-only probe บนตาราง
      // เป้าหมาย "ผ่าน" แม้ invocation ของ RPC นี้ยังไม่จบ — เพราะมันยังไม่ถึงตาราง
      await tableTerminalProbe("public.event_outbox");
      // ขั้นตรวจจริง: settle ต้องถูกปฏิเสธด้วยขา activity (probe โยน = ไม่มี
      // invocationClose เกิดเลย) และ D1 ยัง 'running'
      await expect(settleScenario(d1, "guard-pretable-must-refuse", probe)).rejects.toThrow(
        /ยังรัน complete_data_export_job อยู่/,
      );
      expect(await invStatus(d1.invocationId)).toBe("running");
      // ปล่อย blocker → D2 วิ่งจบ (P0002 → opaque 500)
      await session.exec("rollback;");
      const d2res = await d2;
      expect(d2res.status).toBeGreaterThanOrEqual(500);
      expect(d2res.invocationId).toBeDefined();
      // ตอนนี้ terminal จริงทั้งสองขา → settle D1 และ D2 ผ่าน (ไม่ทิ้ง running)
      await settleScenario(d1, "guard-pretable-terminal-proven(activity-clear)", probe);
      expect(await invStatus(d1.invocationId)).toBe("settled");
      await settleScenario(d2res, "guard-pretable-d2-settled", probe);
      expect(await invStatus(d2res.invocationId)).toBe("settled");
    } finally {
      await session.exec("rollback;");
      await session.end();
      await startMailer().catch((err) => {
        process.stderr.write(`m1r3: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }
  }, 120_000);

  // ─── M1 (gate waveh-r4): invocation เดียว — client จบแล้วแต่ backend ยังค้าง ────
  // รูปเคสที่ r4 สั่ง (ต่างจาก r3 ที่ settle D1 ขณะ D2 ค้าง): invocation เดียว
  // ที่ "client ได้จบฝั่งตัวเองแล้ว" (abort หลังเห็น backend ค้างจริง) ขณะ backend
  // ของ invocation นั้นยังค้างอยู่ก่อนตารางเป้าหมาย (ติด lock ตารางแรก
  // data_export_jobs) — พิสูจน์ด้วย pg_stat_activity จริง · ผ่าน stack จริง:
  // PostgREST ไม่ cancel query ตาม client ที่หายไป (วัดจริง: backend ยัง active
  // หลัง abort) และถูกตัดโดย lock_timeout=8s ของ role authenticator (ขอบเขต
  // ตามจริง) · settle ต้องปฏิเสธขณะงานยังไม่จบ และผ่านก็ต่อเมื่อ (1) probe
  // terminal (2) CLF line ของ nonce หนึ่งแถวพอดี (= PostgREST serve ครบหนึ่งครั้ง —
  // cancellation ผูกกับ invocation นี้: line 500 ของ 57014) แล้วจึง (3) อ่าน
  // snapshot ใหม่หลังงานจบจริง และ (4) settle
  it("invocation เดียว: client จบ (abort) ขณะ backend ค้างก่อนตาราง = ปฏิเสธ settle · ยกเลิกโดย lock_timeout (nonce-CLF) + snapshot ใหม่ → settle ผ่าน (waveh-r4 M1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { REPO_ROOT, settleScenario, scenarioTerminalProbe, psqlScalar, SERVICE_KEY } = await import("./helpers");
    const { httpWrite, startPsqlSession } = await import("./test-io");
    // หยุด mailer กัน phantom ของ busy-count (pattern M1-r7/8/9 · เจอจริง guards
    // rerun r20 ที่ M1-r4 นี้เอง: backend ของ worker ค้าง lock อยู่ในนาม RPC เดียว
    // กับของเทส ทำให้ assert "backend ยัง active หลัง abort" นับตัวผิด)
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();
    const jobId = "00000000-0000-4000-8000-0000000000f5"; // ไม่มีอยู่ → P0002 เมื่อได้วิ่ง
    const invocationId = crypto.randomUUID();
    const invStatus = () =>
      psqlScalar(`
        select payload ->> 'status' from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${invocationId}'
         order by ts desc, id desc limit 1;`);
    const busyCount = () =>
      psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%complete_data_export_job%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);
    const probe = () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job");
    const resStub = {
      status: -1,
      json: null,
      text: "",
      invocationId,
      opKey: "rpc:complete_data_export_job:POST",
    } as const;

    const session = await startPsqlSession("scenario-guard-abort-holder");
    const abort = new AbortController();
    try {
      await session.exec("begin;");
      await session.exec("lock table public.data_export_jobs in access exclusive mode;");
      // dispatch จริงผ่าน transport กลาง (invocationId เรากำหนด — abort จะโยน error
      // ไม่มี res กลับมา จึงต้องรู้ id ล่วงหน้า) — ยังไม่ abort: รอหลักฐานว่า backend
      // ของ invocation นี้ขึ้นจริงและติด lock ตารางแรก (ก่อนตารางเป้าหมาย) เสียก่อน
      const dispatch = httpWrite(
        "POST",
        "/rest/v1/rpc/complete_data_export_job",
        {
          p_job_id: jobId,
          p_file_media_id: "00000000-0000-4000-8000-0000000000f6",
          p_chunks: 1,
          p_request_id: crypto.randomUUID(),
          p_claim_token: crypto.randomUUID(),
        },
        {
          apiKey: SERVICE_KEY,
          token: SERVICE_KEY,
          settleMode: "scenario",
          invocationId,
          label: "m1r4-abort",
          signal: abort.signal,
        },
      );
      let busy = "0";
      for (let i = 0; i < 50 && busy === "0"; i += 1) {
        busy = await busyCount();
        if (busy === "0") await new Promise((r) => setTimeout(r, 100));
      }
      expect(busy, "backend ของ invocation นี้ต้องขึ้นจริงและติด lock ตารางแรก").toBe("1");
      // client จบตอนนี้ (abort หลังเห็น backend ค้าง — ไม่ใช่ตามนาฬิกา) · งานติด lock
      // อยู่ ≥ อีก ~6s (lock_timeout 8s) การ abort จึงตกช่วง "backend ยังค้าง" แน่นอน
      abort.abort();
      let clientErr: unknown;
      try {
        await dispatch;
      } catch (err) {
        clientErr = err;
      }
      expect(String(clientErr), "client ต้องจบด้วย abort error").toMatch(/abort/i);
      // backend ยังค้างต่อแม้ client จบแล้ว (ตรวจจริง: PostgREST ไม่ cancel ตาม client)
      expect(await busyCount(), "backend ต้องยัง active หลัง client abort").toBe("1");
      expect(await invStatus()).toBe("running");

      // settle ขณะงานยังไม่จบ = ปฏิเสธ (probe โยนก่อนขาอื่น) — invocation ยัง 'running'
      await expect(
        settleScenario(resStub, "guard-r4-must-refuse-while-hung", probe),
      ).rejects.toThrow(/ยังรัน complete_data_export_job อยู่/);
      expect(await invStatus()).toBe("running");

      // ไม่ปล่อย blocker — ปล่อยให้กลไกจริงของ stack ตัดงานเอง: lock_timeout=8s ของ
      // role authenticator ยกเลิก statement (57014) → PostgREST serve ครบ = CLF line
      // 500 พร้อม nonce ปรากฏ (cancellation evidence ผูกกับ invocation นี้ — ตรวจจริง:
      // line ของ P0002-raise ข้อความไทยถูก gateway ตัดไม่มี line เลย ส่วน line ของ
      // 57014 cancel มีเสมอ) · poll จน backend จบ (มีขอบเขต 8s เสมอ) — ตลอดช่วงนี้
      // blocker ยังถือ lock อยู่ = การยกเลิกเกิดจาก stack เอง ไม่ใช่เพราะเราปล่อย
      for (let i = 0; i < 120 && busy !== "0"; i += 1) {
        busy = await busyCount();
        if (busy !== "0") await new Promise((r) => setTimeout(r, 100));
      }
      expect(busy, "backend ต้องถูก lock_timeout ตัดเองภายใน ~8s").toBe("0");

      // การยกเลิกพิสูจน์แล้ว (busy=0 ขณะ lock ยังถูกถือ) — ปล่อย holder เพื่อให้อ่าน
      // snapshot ของตารางที่มันถือไว้ได้: ปล่อยตรงนี้ไม่สร้างงานใหม่ (request เดียวของ
      // invocation นี้ถูกยกเลิกไปแล้ว CLF line เขียนแล้ว · dispatch ถูก abort ฝั่ง
      // client · manifest singleDispatch) — settle#2 พิสูจน์ terminal ซ้ำทุกขาหลังจากนี้
      await session.exec("rollback;");

      // terminal ยืนยันครบแล้ว (probe + nonce-CLF cancellation line) → snapshot
      // "ใหม่" อ่านหลังงานจบจริง (r4 ข้อ ค) → settle ผ่าน
      await settleScenario(resStub, "guard-r4-terminal-proven(nonce-clf+probe)", probe, async () => {
        expect(
          await psqlScalar(`select count(*)::text from public.data_export_jobs where id = '${jobId}';`),
          "งานไม่มีอยู่จริงต้องไม่ถูกสร้าง (statement ถูกยกเลิกก่อนแตะข้อมูล)",
        ).toBe("0");
      });
      expect(await invStatus()).toBe("settled");
    } finally {
      await session.exec("rollback;");
      await session.end();
      await startMailer().catch((err) => {
        process.stderr.write(`m1r4: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }
  }, 90_000);

  // ─── M1 (gate waveh-r5): response ถึงมือ caller แล้ว (opaque) ยังต้องพิสูจน์ terminal ──
  // r5 จับ: เส้นตายเดิม "response = upstream serve จบ" อ้าย่างเดียวไม่พอสำหรับ
  // opaque response — code ต้องตรวจที่มาของ response เอง (D-f-13) · รูปเคส: D1 ถือ
  // 500 opaque ไว้ในมือ (body "Something went wrong" ที่ Kong ตัดขาคอร์ด — แกะ
  // JSON ไม่ได้) ขณะ D2 ของ RPC เดียวกันยังค้าง "ก่อนตารางเป้าหมาย" → settle D1
  // ต้องปฏิเสธ (ขา activity ของ probe โยนก่อนขาอื่น) จน D2 จบจริง → settle D2/D1
  // ผ่าน gate opaque สามขา (kong line หนึ่งแถว status ตรง + ไม่มี activity ผูก
  // requestRef + role bounds 8s/8s) · ทิศสกปรกของ fence เอง: D3 จบจริง (kong line
  // status 500) แต่ settle อ้าง status 502 = หลักฐานไม่ผูกกับ invocation = ปฏิเสธ
  it("response-in-hand ขณะงานอื่นของ RPC เดียวกันยังค้าง = ปฏิเสธ settle · งานจบ + snapshot ใหม่ = ผ่าน · อ้าง status ไม่ตรง kong line = ปฏิเสธ (waveh-r5 M1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { REPO_ROOT, restCall, settleScenario, scenarioTerminalProbe, psqlScalar, SERVICE_KEY } =
      await import("./helpers");
    const { httpWrite, startPsqlSession } = await import("./test-io");
    // หยุด mailer กัน phantom ของ busy-count รายชื่อ RPC (pattern M1-r7/8/9 ·
    // กลไกเดียวกับที่เจอจริงที่ M1-r4 รอบ r20 — busyCount ไม่แยก backend ของ
    // เทสกับ dev worker ที่ยิง RPC เดียวกันเป็นรอบ)
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();
    const jobId = "00000000-0000-4000-8000-0000000000f7"; // ไม่มีอยู่ → P0002 opaque 500
    const dispatchBody = () => ({
      p_job_id: jobId,
      p_file_media_id: "00000000-0000-4000-8000-0000000000f8",
      p_chunks: 1,
      p_request_id: crypto.randomUUID(), // หมุด audit correlation ราย invocation (บันทึกใน binding ของ ledger)
      p_claim_token: crypto.randomUUID(),
    });
    const invStatus = (id: string | undefined) =>
      psqlScalar(`
        select payload ->> 'status' from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${id}'
         order by ts desc, id desc limit 1;`);
    const busyCount = () =>
      psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%complete_data_export_job%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);
    const probe = () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job");

    // D1: ถือ response ไว้ในมือ "ก่อน" blocker ยึด — opaque 500 (P0002-raise ถูก
    // gateway ตัด → body "Something went wrong" แกะ JSON ไม่ได้ → class opaque)
    const d1 = await restCall(
      "POST",
      "/rest/v1/rpc/complete_data_export_job",
      { apiKey: SERVICE_KEY, token: SERVICE_KEY, settleMode: "scenario" },
      dispatchBody(),
    );
    expect(d1.status).toBe(500);
    expect(d1.json, "D1 ต้องเป็น opaque response (แกะ JSON ไม่ได้)").toBeNull();
    expect(d1.invocationId).toBeDefined();

    const session = await startPsqlSession("scenario-guard-r5-holder");
    try {
      await session.exec("begin;");
      await session.exec("lock table public.data_export_jobs in access exclusive mode;");
      // D2: dispatch จริงที่ค้างก่อนตารางแรกของทางเดิน RPC (evidence-driven: รอ busy=1)
      const d2 = httpWrite(
        "POST",
        "/rest/v1/rpc/complete_data_export_job",
        dispatchBody(),
        {
          apiKey: SERVICE_KEY,
          token: SERVICE_KEY,
          settleMode: "scenario",
          label: "m1r5-hung-d2",
        },
      );
      let busy = "0";
      for (let i = 0; i < 50 && busy === "0"; i += 1) {
        busy = await busyCount();
        if (busy === "0") await new Promise((r) => setTimeout(r, 100));
      }
      expect(busy, "D2 ต้องค้างเป็น backend active จริงก่อนตรวจขั้นถัดไป").toBe("1");

      // settle D1 ขณะงาน (D2) ยังค้าง = ปฏิเสธ "แม้ response อยู่ในมือแล้ว" —
      // probe โยนก่อนขาอื่น · invocation คง 'running' ให้ audit จับ
      await expect(
        settleScenario(d1, "guard-r5-response-in-hand-must-refuse", probe),
      ).rejects.toThrow(/ยังรัน complete_data_export_job อยู่/);
      expect(await invStatus(d1.invocationId)).toBe("running");

      // ปล่อย blocker → D2 วิ่งจบ (P0002 → opaque 500) — settle ผ่าน gate opaque
      // สามขาเอง (kong line ปรากฏเมื่อ Kong ปิด response ของ D2)
      await session.exec("rollback;");
      const d2res = await d2;
      expect(d2res.status).toBe(500);
      await settleScenario(d2res, "guard-r5-d2-opaque-fence-passed", probe);
      expect(await invStatus(d2res.invocationId)).toBe("settled");

      // D1 settle หลังงานจบจริง: ผ่าน gate opaque สามขา + snapshot "ใหม่" (r4 ข้อ ค)
      await settleScenario(d1, "guard-r5-d1-terminal-proven(post-work)", probe, async () => {
        expect(
          await psqlScalar(`select count(*)::text from public.data_export_jobs where id = '${jobId}';`),
          "job ไม่มีอยู่จริงต้องไม่ถูกสร้าง (P0002 = TX abort)",
        ).toBe("0");
      });
      expect(await invStatus(d1.invocationId)).toBe("settled");
    } finally {
      await session.exec("rollback;");
      await session.end();
      await startMailer().catch((err) => {
        process.stderr.write(`m1r5: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }

    // ทิศสกปรกของ fence เอง: D3 จบจริง (kong line status 500 หนึ่งแถว) แต่ settle
    // อ้าง status 502 — line ไม่ผูกกับ response ที่อ้าง = ปฏิเสธ คง 'running'
    const d3 = await restCall(
      "POST",
      "/rest/v1/rpc/complete_data_export_job",
      { apiKey: SERVICE_KEY, token: SERVICE_KEY, settleMode: "scenario" },
      dispatchBody(),
    );
    expect(d3.status).toBe(500);
    const d3lie = { ...d3, status: 502 };
    await expect(
      settleScenario(d3lie, "guard-r5-fence-status-mismatch-must-refuse", probe),
    ).rejects.toThrow(/kong line status 500 ≠ response 502/);
    expect(await invStatus(d3.invocationId)).toBe("running");
    // อ้างตามจริง = ผ่าน (ทิศสะอาดของ fence ตัวเอง — ไม่ทิ้ง running ค้าง)
    await settleScenario(d3, "guard-r5-d3-honest-settle", probe);
    expect(await invStatus(d3.invocationId)).toBe("settled");
  }, 150_000);

  // ─── M1 (gate waveh-r6): invocation เดียว — ถือ response ขณะ upstream ของตัวเองค้าง ──
  // รูปเคสที่ r6 สั่ง (ต่างจาก r5 ที่ refusal มาจาก probe เพราะ D2 เป็น invocation
  // คนละตัว): invocation เดียว X ค้างบน lock ตารางแรกของทางเดิน RPC (ผูก
  // p_request_id รายตัว — พิสูจน์ด้วย pg_stat_activity จริง) ขณะ caller "ถือ
  // response แล้ว" (สถานะที่ gate เป็นห่วง: gateway สังเคราะห์คำตอบก่อน upstream
  // serve — จำลองด้วย handle ผูก invocationId จริงของ X ทิศเดียวกับ d3lie ที่ gate
  // ยอมรับ) → probe ที่ใช้ต้อง "ผ่าน" (lock-only บนตารางเป้าหมาย event_outbox —
  // จับ backend ที่ค้างก่อนตารางไม่ได้ ตามที่ r3 พิสูจน์) = การปฏิเสธเกิดจาก fence
  // เอง (ขา activity fail-fast) ไม่ใช่ probe · แล้วปล่อยให้กลไกจริงตัดงาน: lock
  // ยังถูกถือ → lock_timeout=8s (effective) ตัด statement ของ pool session ที่
  // serve จริง (ขาพฤติกรรมของ role bounds — วัดเป็น ms) → response จริงของ X
  // มาถึง (500 opaque) → ปล่อย blocker → settle ผ่านครบทุกขา + snapshot ใหม่
  it("invocation เดียว: response-in-hand ขณะ upstream ของตัวเองยังค้าง = fence ปฏิเสธเอง (probe ผ่าน) · lock_timeout ตัดจริง ~8s (effective) → settle จริงผ่าน + snapshot ใหม่ (waveh-r6 M1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { REPO_ROOT, settleScenario, scenarioTerminalProbe, tableTerminalProbe, psqlScalar, SERVICE_KEY } =
      await import("./helpers");
    const { httpWrite, startPsqlSession } = await import("./test-io");
    // หยุด mailer กัน phantom ของ busy-count รายชื่อ RPC (pattern M1-r7/8/9 ·
    // กลไกเดียวกับที่เจอจริงที่ M1-r4 รอบ r20 — busyCount ไม่แยก backend ของ
    // เทสกับ dev worker ที่ยิง RPC เดียวกันเป็นรอบ)
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();
    const jobId = "00000000-0000-4000-8000-0000000000fb"; // ไม่มีอยู่ → P0002 เมื่อได้วิ่ง
    const requestRef = crypto.randomUUID(); // หมุดผูก activity ราย invocation (r5)
    const invocationId = crypto.randomUUID();
    const invStatus = () =>
      psqlScalar(`
        select payload ->> 'status' from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${invocationId}'
         order by ts desc, id desc limit 1;`);
    const busyRef = () =>
      psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%complete_data_export_job%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);
    // probe ที่ "ต้องผ่าน" ขณะ upstream ค้าง: lock-only บนตารางเป้าหมาย — X ค้าง
    // อยู่ก่อนตารางแรกของทางเดิน (data_export_jobs) ยังไม่เคยแตะ event_outbox
    const passingProbe = () => tableTerminalProbe("public.event_outbox");

    const session = await startPsqlSession("scenario-guard-r6-holder");
    try {
      await session.exec("begin;");
      await session.exec("lock table public.data_export_jobs in access exclusive mode;");
      // X: dispatch จริงผ่าน transport กลาง (invocationId เรากำหนด — จะได้ผูก
      // response handle เข้า invocation เดียวกัน) — ค้างรอ lock ตารางแรก
      const dispatch = httpWrite(
        "POST",
        "/rest/v1/rpc/complete_data_export_job",
        {
          p_job_id: jobId,
          p_file_media_id: "00000000-0000-4000-8000-0000000000fc",
          p_chunks: 1,
          p_request_id: requestRef,
          p_claim_token: crypto.randomUUID(),
        },
        {
          apiKey: SERVICE_KEY,
          token: SERVICE_KEY,
          settleMode: "scenario",
          invocationId,
          label: "m1r6-hung-x",
        },
      );
      // หลักฐาน: statement ของ invocation "นี้" ขึ้นจริงและค้าง — correlation ชื่อ
      // RPC + หน้าต่างหลัง dispatch (ไฟล์รันเรียงไม่มีตัวอื่นยิง RPC นี้พร้อมกัน ·
      // ตรวจจริง r6: body เป็น bind param — literal p_request_id ไม่อยู่ใน query
      // text การกรองด้วย requestRef เป็นศูนย์เสมอ = ผ่านปลอม)
      let busy = "0";
      let firstBusyAt = 0; // เวลา "สังเกต busy ครั้งแรก" = statement เริ่ม + ≤100ms (จังหวะ poll) — จุด anchor วัดการตัด (r7 M1.1-2)
      for (let i = 0; i < 50 && busy === "0"; i += 1) {
        busy = await busyRef();
        if (busy === "0") await new Promise((r) => setTimeout(r, 100));
      }
      if (busy === "1" && firstBusyAt === 0) firstBusyAt = Date.now();
      expect(busy, "X ต้องค้างเป็น backend active จริง (correlation ชื่อ RPC หลัง dispatch ของเรา)").toBe("1");

      // แสดงหลักฐานในเทส: probe ตัวนี้ "ผ่าน" ขณะ upstream ของ X ค้างอยู่จริง —
      // การปฏิเสธด้านล่างจึงต้องมาจาก fence เองเท่านั้น (ข้อ M1.3 ของ gate r6:
      // อย่าให้ refusal มาจาก probe เดิมก่อนเข้า fence ใหม่)
      await passingProbe();

      // สถานะที่กลัว: caller ถือ response แล้ว (gateway สังเคราะห์ก่อน upstream
      // serve) ขณะ upstream ของ invocation "นี้เอง" ยังค้าง → fence ปฏิเสธที่ขา
      // activity fail-fast คง 'running' ให้ audit จับ
      const xlie = {
        status: 500,
        json: null,
        text: "",
        invocationId,
        opKey: "rpc:complete_data_export_job:POST",
      } as const;
      await expect(
        settleScenario(xlie, "guard-r6-own-upstream-hung-must-refuse", passingProbe),
      ).rejects.toThrow(/statement ของ invocation นี้ยังรันอยู่/);
      expect(await invStatus()).toBe("running");

      // ไม่ปล่อย blocker — กลไกจริงของ stack ตัดงานเองภายในขอบเขตเวลาของ role
      // (statement_timeout/lock_timeout 8s — errcode 57014 ใช้ร่วมกันระหว่างสองตัว
      // นี้ ข้อความ "canceling statement due to statement timeout" ตรวจจริงแม้สิ่ง
      // ที่ตัดคือการรอ lock เราจึงไม่ฟันธงว่าตัวใดเป็นตัวตัด) → วัดเป็น ms นับจาก
      // "สังเกต busy ครั้งแรก" (statement เริ่ม + ≤100ms ตามจังหวะ poll) — ขา
      // พฤติกรรมของขอบเขต role บน pool session ที่ serve X จริง (execution context
      // จริงตามเงื่อนไขปิดของ gate r7 M1.1-2: catalog ย้อน session เก่าใน pool ไม่
      // ได้ วัดพฤติกรรมตรงนี้จึงเป็นหลักฐานของ session ที่รัน invocation จริง)
      for (let i = 0; i < 150 && busy !== "0"; i += 1) {
        busy = await busyRef();
        if (busy !== "0") await new Promise((r) => setTimeout(r, 100));
      }
      const cutMs = firstBusyAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - firstBusyAt;
      expect(busy, "statement ต้องถูกตัดเองภายในขอบเขตเวลาของ role (lock ยังถูกถืออยู่)").toBe("0");
      expect(
        cutMs,
        `การตัดต้องอยู่ในขอบเขตเวลาของ role 8s นับจากสังเกต busy ครั้งแรก +margin (วัดจริง ${cutMs}ms ขณะ lock ถูกถือ)`,
      ).toBeLessThanOrEqual(9_500);

      // response จริงของ X มาถึงหลังถูกตัด — 500 สองรูปตามจริงของ stack (วัดจริง r6):
      // (1) JSON {"code":"57014","message":"canceling statement due to statement
      // timeout"} เมื่อ PostgREST serialize cancellation error ออกมาเองผ่าน
      // gateway ได้ (ต่างจาก P0002 ข้อความไทยที่โดนตัดขาคอร์ด) — และนี่แหละหลักฐาน
      // สดว่า "JSON body ≠ แหล่งกำเนิดเดียว" ที่ทำให้ gate r6 ยกเลิก class b
      // (2) opaque เมื่อ gateway ตัดขาคอร์ด — ทั้งคู่คือ cancellation ผูก invocation
      // เดียวกัน และ fence ต้องพิสูจน์ terminal ได้ทั้งคู่ (สี่ขา ไม่แยก JSON/opaque)
      const xres = await dispatch;
      expect(xres.status).toBe(500);
      if (xres.json !== null && typeof xres.json === "object") {
        expect((xres.json as { code?: unknown }).code).toBe("57014");
      } else {
        expect(xres.json).toBeNull();
      }
      expect(xres.invocationId).toBe(invocationId);

      // ปล่อย blocker เพื่อให้ probe เต็ม (lock+activity) และ snapshot อ่านได้ —
      // ไม่สร้างงานใหม่ (request เดียวของ invocation นี้ถูกยกเลิกไปแล้ว · dispatch
      // ปลายทางได้รับ response แล้ว · manifest singleDispatch)
      await session.exec("rollback;");

      // settle จริงของ invocation เดียวกัน: ผ่านครบทุกขา (activity fail-fast +
      // kong line หนึ่งแถว status ตรง + หน้าต่าง 12s หลัง line สะอาด + role
      // bounds declaration&effective) แล้วจึงอ่าน snapshot "ใหม่" (r4 ข้อ ค)
      await settleScenario(
        xres,
        "guard-r6-x-terminal-proven(all-legs)",
        () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job"),
        async () => {
          expect(
            await psqlScalar(`select count(*)::text from public.data_export_jobs where id = '${jobId}';`),
            "job ไม่มีอยู่จริงต้องไม่ถูกสร้าง (statement ถูก lock_timeout ยกเลิก = TX abort)",
          ).toBe("0");
        },
      );
      expect(await invStatus()).toBe("settled");
    } finally {
      await session.exec("rollback;");
      await session.end();
      await startMailer().catch((err) => {
        process.stderr.write(`m1r6: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }
  }, 120_000);

  // ─── M1 (gate waveh-r7): คำขอที่ "ยังไม่ได้เริ่ม statement" — ค้างในคิว pool ของ PostgREST ──
  // gate r7 M1.1-1 ชี้ช่องว่าง: คำขอที่ dispatch ไปแล้วแต่ยังไม่ได้ pool slot ไร้
  // backend ไร้ CLF line — fence รุ่นก่อน (activity ณ ตอนเข้า + kong line + หน้าต่าง
  // คงที่) ไม่มีทางเห็น "มันเพิ่งเริ่มทีหลัง" · รูปเคส: เติม pool ให้เต็มด้วย holder
  // 10 ตัวของ RPC "ต่างชื่อ" (admin_revoke_role — มองไม่เห็นใน busy filter ของ
  // complete_data_export_job) ที่ค้างบน lock ของ role_assignments → X
  // (complete_data_export_job) ถูก push เป็นตัวที่ 11 ในคิว pool (pool=10 ไม่มี
  // override — postgrestPoolAcquisitionBoundMs ตรวจสดที่ fence · ตรวจจริง
  // 2026-09-15 probe P5: ตัวที่ 11 ไร้ backend จนมีช่อง ~8s แล้ว serve จบ ~16s) →
  // dirty settle ถือ response ปลอม {504} ขณะ X "ยังไม่เริ่ม RPC" (busy=0 + CLF 0
  // แถว = หลักฐานในเทส ตามเงื่อนไขปิด "request ยังไม่เริ่ม RPC" ของ gate) → fence
  // ขา ข′ ต้องปฏิเสธเองด้วย in-poll activity เมื่อ X ได้ slot และเริ่ม statement
  // ระหว่างหน้าต่างเฝ้า · holders ถูกตัดโดยขอบเขตเวลาของ role ~8s → X ได้ serve ต่อ
  // → response จริงของ X มาถึง → ปล่อย blocker → settle จริงทั้ง X และ holders ทั้ง
  // 11 invocation ครบทุกขา + snapshot ใหม่ (ไม่ทิ้ง running)
  // gate r8 (regression gap): busy-watcher ของ X ต้องเริ่ม "ก่อน" dirty settle —
  // firstBusyAt = สังเกต busy ครั้งแรกจริงระหว่างหน้าต่างเฝ้า (ไม่ใช่หลัง refusal
  // จบแบบ r7 เดิมที่วัดได้แค่ "เวลาที่เหลือ")
  it("คำขอค้างในคิว pool ยังไม่เริ่ม statement = ปฏิเสธเมื่อเพิ่งเริ่มระหว่างเฝ้า · serve จบจริง = settle ผ่านครบทุกขา (waveh-r7 M1.1-1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const {
      REPO_ROOT,
      SERVICE_KEY,
      ANON_KEY,
      createTestUser,
      deleteTestUser,
      settleScenario,
      scenarioTerminalProbe,
      psqlScalar,
      psqlRows,
    } = await import("./helpers");
    const { httpWrite, startPsqlSession, accessLogFenceAnyStatus } = await import("./test-io");
    const { mintAal2Token } = await import("./helpers-aal2");
    // หยุด mailer กัน noise: dev worker ยิง complete_data_export_job เอง (probe P4
    // เห็น backend ของมันกิน pool slot ทำให้จำนวนตัวที่ค้างในคิวเพี้ยน) — dcr12 pattern
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();

    const jobId = "00000000-0000-4000-8000-000000000101"; // ไม่มีอยู่ → P0002 เมื่อ X ได้วิ่ง
    const invocationIdX = crypto.randomUUID();
    const invStatusX = () =>
      psqlScalar(`
        select payload ->> 'status' from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${invocationIdX}'
         order by ts desc, id desc limit 1;`);
    const busyComplete = () =>
      psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%complete_data_export_job%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);
    const busyRevoke = () =>
      psqlScalar(`
        select count(*)::text from pg_stat_activity
         where query like '%admin_revoke_role%'
           and state in ('active', 'idle in transaction')
           and pid <> pg_backend_pid();`);

    let admin: Awaited<ReturnType<typeof createTestUser>> | null = null;
    let adminAal2 = "";
    try {
      // admin จริง + AAL2 จริง (admin_revoke_role ต้องการ super_admin aal2 — ทาง
      // เดียวกับ dcr12 เคส c) — ต้องสร้าง "ก่อน" blocker ยึด lock: signup ของ GoTrue
      // มี trigger เขียนบทบาทเริ่มต้นลง public.role_assignments (จับได้จากรอบแรกที่
      // ล้ม: signup ค้างบน lock ของเราเอง → GoTrue 504 request_timeout) · สร้างหลัง
      // stopMailer ได้ (signup ไม่พึ่ง mailer — dcr12 พิสูจน์)
      admin = await createTestUser("m1r7-pool-admin", "super_admin");
      adminAal2 = await mintAal2Token(admin);
      expect(adminAal2).not.toBe("");
    } catch (err) {
      await startMailer().catch(() => undefined);
      throw err;
    }
    const adminId = admin.id;

    const session = await startPsqlSession("m1r7-pool-blocker");
    try {
      // blocker TX เดียวถือสองตาราง: X ค้างที่ตารางแรกของทางเดิน
      // complete_data_export_job · holders ค้างที่ตารางของทางเดิน admin_revoke_role
      await session.exec("begin;");
      await session.exec("lock table public.data_export_jobs in access exclusive mode;");
      await session.exec("lock table public.role_assignments in access exclusive mode;");

      // holders 10 ตัว = เติม pool ให้เต็มพอดี — RPC ต่างชื่อจาก X จึงมองไม่เห็นใน
      // busyComplete filter (จุดตั้งใจ: จำลองงานอื่นที่กิน pool ซึ่ง fence ของ X
      // ต้องไม่สนใจ) · p_reason ปลอด digit-run ตามกติกา PII
      const holderBody = () => ({
        p_user_id: adminId,
        p_role: "staff:viewer",
        p_reason: "m1r7-pool-holder",
        p_request_id: crypto.randomUUID(),
      });
      const holders = Array.from({ length: 10 }, () =>
        httpWrite("POST", "/rest/v1/rpc/admin_revoke_role", holderBody(), {
          apiKey: ANON_KEY,
          token: adminAal2,
          settleMode: "scenario",
          label: "m1r7-holder",
        }),
      );
      // หลักฐาน: holders ต้อง "เริ่ม statement จริง" ทั้ง 10 (เต็ม pool) — ไม่ใช่
      // ถูกปฏิเสธก่อนแตะตาราง — ก่อน X ถึงจะเป็น "ตัวที่ 11 ในคิว" จริง
      let busyHolders = "0";
      for (let i = 0; i < 80 && busyHolders !== "10"; i += 1) {
        busyHolders = await busyRevoke();
        if (busyHolders !== "10") await new Promise((r) => setTimeout(r, 100));
      }
      expect(busyHolders, "holders 10 ตัวต้อง active จริงพร้อมกัน (เต็ม pool) ก่อน dispatch X").toBe("10");

      // X ตัวที่ 11: ค้างในคิว pool — ยังไม่มี backend ยังไม่มี statement
      const dispatchX = httpWrite(
        "POST",
        "/rest/v1/rpc/complete_data_export_job",
        {
          p_job_id: jobId,
          p_file_media_id: "00000000-0000-4000-8000-000000000102",
          p_chunks: 1,
          p_request_id: crypto.randomUUID(),
          p_claim_token: crypto.randomUUID(),
        },
        {
          apiKey: SERVICE_KEY,
          token: SERVICE_KEY,
          settleMode: "scenario",
          invocationId: invocationIdX,
          label: "m1r7-queued-x",
        },
      );

      // หลักฐานตามเงื่อนไขปิดของ gate r7 M1.1-1 ("request ยังไม่เริ่ม RPC ตอนพบ
      // line"): X ยังไร้ statement และยังไร้ CLF line ของ nonce ตัวเอง · httpWrite
      // เขียน invocation/attempt rows "ก่อน" fetch แต่ captureLogCursor (docker
      // logs) กินเวลา — poll แถวจาก ledger แทนอ่านครั้งเดียว (กัน race กับ
      // pre-fetch section ของ transport)
      expect(await busyComplete(), "X ต้องยังไม่เริ่ม statement (ค้างในคิว pool หลัง pool เต็ม)").toBe("0");
      let bindingX: { ua: string | null } | undefined;
      let attemptX: { cursor: { capturedAt: string; lineCount: number; restStartedAt: string } | null } | undefined;
      for (let i = 0; i < 50 && (bindingX?.ua == null || attemptX?.cursor == null); i += 1) {
        [bindingX] = await psqlRows<{ ua: string | null }>(`
          select payload -> 'binding' ->> 'uaNonce' as ua
            from test_infra.lifecycle_ledger
           where kind = 'invocation' and invocation_id = '${invocationIdX}'
           order by ts desc limit 1;`);
        [attemptX] = await psqlRows<{ cursor: { capturedAt: string; lineCount: number; restStartedAt: string } | null }>(`
          select payload -> 'logCursor' as cursor
            from test_infra.lifecycle_ledger
           where kind = 'attempt' and invocation_id = '${invocationIdX}'
           order by ts desc limit 1;`);
        if (bindingX?.ua == null || attemptX?.cursor == null) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (bindingX?.ua == null || attemptX?.cursor == null) {
        throw new Error("m1r7: ไม่พบ nonce/cursor ของ X ใน ledger — หลักฐาน CLF-0 พิสูจน์ไม่ได้");
      }
      const clf0 = await accessLogFenceAnyStatus(attemptX.cursor, {
        uaNonce: bindingX.ua,
        method: "POST",
        pathNorm: "/rpc/complete_data_export_job",
      });
      expect(clf0.matches, "X ยังไม่ถูก serve → ต้องไร้ CLF line ของ nonce ตัวเอง").toBe(0);

      // ทิศสกปรกที่ gate r7 เป็นห่วง: caller ถือ response ปลอม (ทิศเดียวกับ xlie
      // ที่ gate ยอมรับมาแล้ว) ขณะ invocation ของตัวเอง "ยังไม่เริ่ม RPC เลย" —
      // fence ขา ข′ ต้องปฏิเสธเองด้วย in-poll activity เมื่อ X ได้ slot และ
      // เริ่ม statement ภายในหน้าต่างเฝ้า (dispatch+acq+stmt+margin)
      // gate r8: busy-watcher เริ่ม "ก่อน" dirty settle — firstBusyAt = สังเกต
      // busy ครั้งแรกจริงของ statement ของ X (เกิดได้ระหว่างที่ settle กำลังเฝ้า
      // อยู่) ไม่ใช่เวลาหลัง refusal จบ — r7 เดิมวัดหลังจบจึงพิสูจน์ได้แค่ "เวลา
      // ที่เหลือ" ตามที่ gate r8 ชี้ (regression gap)
      let firstBusyAt = 0;
      const busyWatchX = (async () => {
        for (let i = 0; i < 400 && firstBusyAt === 0; i += 1) {
          if ((await busyComplete()) !== "0") firstBusyAt = Date.now();
          else await new Promise((r) => setTimeout(r, 100));
        }
      })();
      const xlie = {
        status: 504,
        json: null,
        text: "",
        invocationId: invocationIdX,
        opKey: "rpc:complete_data_export_job:POST",
      } as const;
      // การปฏิเสธ dirty settle นี้เกิดที่ขา "เห็น statement ของ RPC นี้" สองรูป
      // ตามจังหวะแข่งจริง: holders 10 ตัวเริ่ม statement ไม่พร้อมกัน (ต่างรอ pool)
      // ช่วงที่ตัวแรกถูก role bounds ตัด (~8s นับจากตัวแรกเริ่ม ไม่ใช่จาก busy=10
      // ครบ) อาจตรงกับหลัง busy=0 assert พอดี — X ได้ slot "ก่อน" settle เข้า fence
      // (ขา fail-fast "ยังรันอยู่" helpers.ts:418 — เกิดจริง battery r19) หรือ
      // "ระหว่าง" หน้าต่างเฝ้า CLF (ขา in-poll helpers.ts:391 — เกิดจริง r13-r18) ·
      // สองขาพิสูจน์สิ่งเดียวกัน: fence เห็น statement ที่เพิ่งเริ่ม = ไม่ terminal ·
      // ถ้าถอนขา in-poll ออก จังหวะกลางหน้าต่างจะหล่นไปขา fail-closed CLF=0 ของ
      // r8 (ข้อความอื่น) = เทสล้มอยู่ดี — regex จึงรับเฉพาะสองข้อความนี้
      await expect(
        settleScenario(xlie, "guard-r7-queued-request-must-refuse-when-it-starts", () =>
          scenarioTerminalProbe("public.event_outbox", "complete_data_export_job")),
      ).rejects.toThrow(/เริ่มขึ้นระหว่างหน้าต่างเฝ้า CLF|statement ของ invocation นี้ยังรันอยู่/);
      expect(await invStatusX()).toBe("running");
      await busyWatchX;
      expect(
        firstBusyAt,
        "X ต้องเริ่ม statement จริงระหว่างหน้าต่างเฝ้า — in-poll catch ของ fence เห็นสิ่งเดียวกันกับ watcher",
      ).toBeGreaterThan(0);

      // วัดการตัดของ X จาก "สังเกต busy ครั้งแรก" (ช่วงเฝ้า) จนถูกตัด — ขา
      // พฤติกรรมของขอบเขตเวลาของ role บน pool session ที่ serve X จริง (เงื่อนไข
      // ปิด M1.1-2 ครึ่งหลัง) — blocker ยังถือ lock อยู่
      let busyX = await busyComplete();
      for (let i = 0; i < 150 && busyX !== "0"; i += 1) {
        busyX = await busyComplete();
        if (busyX !== "0") await new Promise((r) => setTimeout(r, 100));
      }
      const cutMs = firstBusyAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - firstBusyAt;
      expect(busyX, "statement ของ X ต้องถูกตัดภายในขอบเขตเวลาของ role (lock ยังถูกถือ)").toBe("0");
      expect(
        cutMs,
        `การตัดของ X ต้องอยู่ในขอบเขตเวลาของ role 8s นับจากสังเกต busy ครั้งแรก +margin (วัดจริง ${cutMs}ms)`,
      ).toBeLessThanOrEqual(9_500);

      // response จริงของ X มาถึงหลังถูกตัด (500 — 57014 JSON หรือ opaque ตามจริง
      // ของ stack) · holders ถูกตัดทั้งหมดเช่นกัน (blocker ยังถือ role_assignments)
      const xres = await dispatchX;
      expect(xres.status, "response จริงของ X หลังถูกตัดโดยขอบเขตเวลาของ role").toBeGreaterThanOrEqual(500);
      expect(xres.invocationId).toBe(invocationIdX);
      const holderResults = await Promise.all(holders);
      for (const h of holderResults) {
        expect(h.status, "holder ต้องถูกตัดโดยขอบเขตเวลาของ role (blocker ยังถือ lock)").toBeGreaterThanOrEqual(500);
      }

      // ปล่อย blocker — ไม่มีงานเกิดใหม่ (ทุก invocation ถูกตัด/ตอบจบแล้ว · manifest
      // singleDispatch ทั้งสอง opKey) → settle จริงทั้ง 11 invocation ครบทุกขา +
      // snapshot ใหม่ ไม่ทิ้ง running ค้าง
      await session.exec("rollback;");

      await settleScenario(
        xres,
        "guard-r7-x-terminal-proven(all-legs)",
        () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job"),
        async () => {
          expect(
            await psqlScalar(`select count(*)::text from public.data_export_jobs where id = '${jobId}';`),
            "job ไม่มีอยู่จริงต้องไม่ถูกสร้าง (statement ของ X ถูกยกเลิก = TX abort)",
          ).toBe("0");
        },
      );
      expect(await invStatusX()).toBe("settled");

      const probeRevoke = () => scenarioTerminalProbe("public.role_assignments", "admin_revoke_role");
      for (const h of holderResults) {
        await settleScenario(h, "guard-r7-holder-settled(all-legs)", probeRevoke);
      }
    } finally {
      await session.exec("rollback;").catch(() => undefined);
      await session.end();
      if (admin !== null) {
        await deleteTestUser(admin.id);
      }
      await startMailer().catch((err) => {
        process.stderr.write(`m1r7: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }
  }, 300_000);

  // ─── M1 (gate waveh-r8): ขา CLF=0 ของ response-in-hand — ต้องมีหลักฐาน terminal ──
  // ผูก invocation จริง ห้ามอนุมานจบจากการไม่เห็น (fence v6) · verdict r8 M1: v5
  // settle ได้เมื่อ "ครบหน้าต่างไร้ line ไร้ activity" — นั่นเป็นการอนุมาน ไม่ใช่
  // หลักฐาน (attempt.ts เขียนก่อน fetch = ขอบล่างไม่ใช่ขอบบน · role bounds
  // พิสูจน์แค่ session ใหม่) · เงื่อนไขปิด (OR): "ขา CLF=0 ต้องปฏิเสธจนมีหลักฐาน
  // completion/cancellation ที่ผูก invocation หรือเพิ่มหลักฐานขอบเขตทุกช่วงและ
  // effective settings ของ execution context ที่เกี่ยวข้องให้ครบ"
  // ทางที่เลือก = หลักฐาน terminal รูปที่สอง: error block ของ db ผูก p_request_id
  // (probe 2026-09-15 `.omc/artifacts/probe-p0002-run2.log` — P0002 ข้อความไทย
  // ที่ gateway ตัดขาคอร์ด: rest ไร้ CLF line แต่ db log มี ERROR/CONTEXT/
  // parameters($1 JSON มี p_request_id)/STATEMENT เมื่อ log_parameter_max_
  // length_on_error=-1) · two-way:
  //  ทิศ ก (สะอาด): dispatch จริง P0002 → settle ผ่านด้วยขา db-error-block
  //   (ledger close บันทึก evidenceLeg="db-error-block" — v5 ไม่มี field นี้
  //   = two-way pin ทิศเดียวกัน)
  //  ทิศ ข (สกปรก): invocation ปลอม + attempt ปลอม (ไม่เคย dispatch) ถือ
  //   response ปลอม 500 → ครบหน้าต่างไร้ทั้ง CLF และ error block = fail-closed
  //   ปฏิเสธ คง 'running' → ปิด poisoned + เคลียร์มือตาม limitation 5 (ข้อความ
  //   ปฏิเสธใหม่ต่างจาก v5 ที่เดินต่อไป kong stage = two-way อีกทิศ)
  it("CLF=0 ต้องมีหลักฐาน terminal ผูก invocation: P0002 จริง settle ผ่านด้วย error block ของ db · ปลอมไร้หลักฐาน = ปฏิเสธ fail-closed (waveh-r8 M1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const {
      REPO_ROOT,
      SERVICE_KEY,
      settleScenario,
      scenarioTerminalProbe,
      psqlScalar,
      psqlRows,
    } = await import("./helpers");
    const { httpWrite, ledgerWrite, invocationClose, manualClearPoison, captureLogCursor, mintUaNonce } =
      await import("./test-io");
    const opKey = "rpc:complete_data_export_job:POST";
    // หยุด mailer กัน noise ของ busy guard — dev worker ยิง complete_data_export_job
    // เอง (pattern เดียวกับ M1-r7/dcr12)
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();
    try {
      // ─── ทิศ ก: dispatch จริง P0002 (job ไม่มีอยู่) → 500 opaque ไร้ CLF line
      // แต่ db log มี error block ผูก p_request_id → settle ผ่านด้วยขานั้นจริง
      const jobId8 = "00000000-0000-4000-8000-0000000002a1";
      const dispatch = httpWrite(
        "POST",
        "/rest/v1/rpc/complete_data_export_job",
        {
          p_job_id: jobId8,
          p_file_media_id: "00000000-0000-4000-8000-0000000002a2",
          p_chunks: 2,
          p_request_id: crypto.randomUUID(),
          p_claim_token: null,
        },
        {
          apiKey: SERVICE_KEY,
          token: SERVICE_KEY,
          settleMode: "scenario",
          label: "m1r8-genuine-p0002",
        },
      );
      const gres = await dispatch;
      expect(gres.status, "P0002 ผ่าน gateway จริง = 500 (probe run2 A)").toBe(500);
      expect(gres.json).toBeNull();
      expect(typeof gres.invocationId).toBe("string");

      const invLeg = () =>
        psqlRows<{ status: string | null; leg: string | null }>(`
          select payload ->> 'status' as status, payload ->> 'evidenceLeg' as leg
            from test_infra.lifecycle_ledger
           where kind = 'invocation' and invocation_id = '${gres.invocationId}'
           order by ts desc, id desc limit 1;`);
      await settleScenario(
        gres,
        "guard-r8-genuine-p0002-settles-via-db-error-block",
        () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job"),
        async () => {
          expect(
            await psqlScalar(`select count(*)::text from public.data_export_jobs where id = '${jobId8}';`),
            "job ไม่มีอยู่จริงต้องไม่ถูกสร้าง (P0002 = TX abort)",
          ).toBe("0");
        },
      );
      // two-way pin ทิศ ก: settle ผ่านจริงด้วย "ขา error block ของ db" ไม่ใช่ CLF
      // (P0002 ไร้ CLF line — probe run2 C) — v5 ไม่มี evidenceLeg ใน close payload
      // = assert นี้ล้มบนโค้ดเก่า
      const [closed] = await invLeg();
      expect(closed?.status).toBe("settled");
      expect(closed?.leg, "ขาหลักฐานที่พา settle ผ่านต้องเป็น error block ของ db").toBe("db-error-block");

      // ─── ทิศ ข: invocation ปลอม + attempt ปลอม (ไม่เคย dispatch จริง) ถือ
      // response ปลอม 500 → ไร้ CLF line ของ nonce ปลอม + ไร้ error block ของ db
      // ผูก requestRef ตลอดหน้าต่างเฝ้า = ต้องปฏิเสธ fail-closed ไม่มีทางเดิน
      // "อนุมานจบจากการไม่เห็น" อีกต่อไป
      const fakeId = crypto.randomUUID();
      const fakeNonce = mintUaNonce();
      await ledgerWrite(
        "invocation",
        {
          status: "running",
          label: "m1r8-fabricated-clf0",
          opKey,
          transport: "httpWrite",
          transportTarget: "kong-path",
          binding: {
            opKey,
            method: "POST",
            urlNormalized: "/rest/v1/rpc/complete_data_export_job",
            uaNonce: fakeNonce,
            requestRef: crypto.randomUUID(),
          },
        },
        { opKey, invocationId: fakeId },
      );
      await ledgerWrite(
        "attempt",
        { transport: "httpWrite", uaNonce: fakeNonce, parentCallKey: null, logCursor: await captureLogCursor(), beforeSnapshot: null },
        { opKey, invocationId: fakeId },
      );
      const invStatusFake = () =>
        psqlScalar(`
          select payload ->> 'status' from test_infra.lifecycle_ledger
           where kind = 'invocation' and invocation_id = '${fakeId}'
           order by ts desc, id desc limit 1;`);
      const flie = {
        status: 500,
        json: null,
        text: "",
        invocationId: fakeId,
        opKey,
      } as const;
      // v6 ปฏิเสธที่ขา ข′ ครบหน้าต่าง (~22s) ด้วยข้อความ "ไม่มีหลักฐาน terminal ของ
      // upstream ที่ผูก invocation" — v5 เดินต่อไป kong stage แล้วล้มที่ข้อความ
      // "ไม่มี kong access line" (two-way ทิศนี้)
      await expect(
        settleScenario(flie, "guard-r8-fabricated-clf0-must-refuse-fail-closed", () =>
          scenarioTerminalProbe("public.event_outbox", "complete_data_export_job")),
      ).rejects.toThrow(/ไม่มีหลักฐาน terminal ของ upstream ที่ผูก invocation/);
      expect(await invStatusFake(), "ปฏิเสธแล้ว invocation ต้องคง 'running' ให้ audit จับ").toBe("running");

      // ปิด poisoned + เคลียร์มือตาม limitation 5 (negative fixture teardown —
      // invocation ปลอมไม่มีทาง settle จริง) เพื่อไม่ทิ้ง poisoned ค้างให้
      // audit-it --expect-clean ของ battery ล้ม
      await invocationClose(fakeId, opKey, "poisoned", {
        decision: "settle-refused-no-upstream-terminal-clf0",
        settledAs: "settle-refused-no-upstream-terminal-clf0",
      });
      expect(await invStatusFake()).toBe("poisoned");
      await manualClearPoison(opKey, "m1r8 negative fixture teardown — พิสูจน์ fail-closed ครบแล้ว (guard r8)");
      expect(await invStatusFake()).toBe("cleared-manual");
    } finally {
      await startMailer().catch((err) => {
        process.stderr.write(`m1r8: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }
  }, 120_000);

  // ─── M1 (gate waveh-r9): ขา db-error-block ผูก invocation จาก record เดียว ────
  // + requestRef ต้องไม่ซ้ำข้าม invocation — verdict r9: v6 matcher รวมหลักฐาน
  // คนละ error block ได้ (codex พิสูจน์ด้วย input จำลอง) และ p_request_id ไม่มี
  // ชั้นบังคับความไม่ซ้ำ · two-way live: ทิศ ก dispatch จริงสองตัวใช้ ref เดียวกัน
  // → settle ตัวที่สองต้องปฏิเสธ "requestRef ซ้ำกับ invocation อื่น" (v6 ไม่มี
  // collision check → settle ผ่าน = ล้มบนโค้ดเก่า) · ทิศ ข invocation ปลอม opKey
  // complete_data_export_job อ้าง ref ของ admin_revoke_role จริง (P0002 จริง มี
  // error block จริงใน db log) → ต้องปฏิเสธด้วยชั้น collision (หลักฐานของ
  // invocation อื่นห้ามถูกอ้าง) — ชั้น parser record-เดียวพิสูจน์แยกที่ describe
  // pure ด้านบน (input จำลอง codex → 0)
  it("error block ผูก invocation ต้อง record เดียว + ref ไม่ซ้ำ: dispatch จริง ref ซ้ำ = ปฏิเสธ · อ้าง ref ของ RPC อื่น = ปฏิเสธ (waveh-r9 M1)", async ({ skip }) => {
    if (DB_URL === undefined) skip();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const {
      REPO_ROOT,
      SERVICE_KEY,
      ANON_KEY,
      createTestUser,
      deleteTestUser,
      settleScenario,
      scenarioTerminalProbe,
      psqlScalar,
      psqlRows,
    } = await import("./helpers");
    const { httpWrite, ledgerWrite, invocationClose, manualClearPoison, captureLogCursor, mintUaNonce } =
      await import("./test-io");
    const { mintAal2Token } = await import("./helpers-aal2");
    // หยุด mailer กัน noise (pattern M1-r7/M1-r8/dcr12)
    const stopMailer = () => execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
    const startMailer = () => execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
    await stopMailer();
    let admin: Awaited<ReturnType<typeof createTestUser>> | null = null;
    let target: Awaited<ReturnType<typeof createTestUser>> | null = null;
    const closeFake = async (id: string, opKey: string, label: string) => {
      await invocationClose(id, opKey, "poisoned", { decision: label, settledAs: label });
      await manualClearPoison(opKey, `${label} — negative fixture teardown (guard r9)`);
    };
    try {
      // ─── ทิศ ก: dispatch จริงสองตัวใช้ p_request_id เดียวกัน — ตัวแรก settle
      // ผ่าน (block ของตัวเอง record เดียว) · ตัวที่สองต้องปฏิเสธที่ collision check
      // ก่อนเข้าลูปเฝ้า: "การพบ 1 block ไม่ได้พิสูจน์ว่ามี 1 invocation" (r9 ข้อ 2)
      const dupRef = `m1r9-dup-${crypto.randomUUID()}`;
      const jobIdA = "00000000-0000-4000-8000-0000000003a1";
      const jobIdB = "00000000-0000-4000-8000-0000000003b2";
      const dupBody = (pJobId: string) => ({
        p_job_id: pJobId,
        p_file_media_id: "00000000-0000-4000-8000-0000000003f1",
        p_chunks: 1,
        p_request_id: dupRef,
        p_claim_token: null,
      });
      const first = await httpWrite("POST", "/rest/v1/rpc/complete_data_export_job", dupBody(jobIdA), {
        apiKey: SERVICE_KEY,
        token: SERVICE_KEY,
        settleMode: "scenario",
        label: "m1r9-dup-first",
      });
      expect(first.status, "P0002 จริงผ่าน gateway = 500 opaque (probe run2 A)").toBe(500);
      await settleScenario(
        first,
        "guard-r9-dup-first-settles-own-block",
        () => scenarioTerminalProbe("public.event_outbox", "complete_data_export_job"),
        async () => {
          expect(
            await psqlScalar(`select count(*)::text from public.data_export_jobs where id = '${jobIdA}';`),
            "job ไม่มีอยู่จริงต้องไม่ถูกสร้าง (P0002 = TX abort)",
          ).toBe("0");
        },
      );
      const second = await httpWrite("POST", "/rest/v1/rpc/complete_data_export_job", dupBody(jobIdB), {
        apiKey: SERVICE_KEY,
        token: SERVICE_KEY,
        settleMode: "scenario",
        label: "m1r9-dup-second",
      });
      expect(second.status).toBe(500);
      const invStatusSecond = () =>
        psqlScalar(`
          select payload ->> 'status' from test_infra.lifecycle_ledger
           where kind = 'invocation' and invocation_id = '${second.invocationId}'
           order by ts desc, id desc limit 1;`);
      // v7: collision check จาก ledger ปฏิเสธก่อนเฝ้า — v6 ไม่มีชั้นนี้: หน้าต่าง
      // anchor cursor ของตัวที่สองมีแค่ block ของตัวเอง (block ของตัวแรกเก่ากว่า
      // dispatch ตัวที่สอง) → v6 settle ผ่าน = assert ข้อความใหม่ล้มบนโค้ดเก่า
      await expect(
        settleScenario(second, "guard-r9-duplicate-requestref-must-refuse", () =>
          scenarioTerminalProbe("public.event_outbox", "complete_data_export_job")),
      ).rejects.toThrow(/requestRef .* ซ้ำกับ invocation อื่น/);
      expect(await invStatusSecond(), "ปฏิเสธแล้ว invocation ต้องคง 'running' ให้ audit จับ").toBe("running");
      await closeFake(second.invocationId as string, second.opKey as string, "settle-refused-duplicate-requestref");

      // ─── ทิศ ข: error block จริงของ RPC อื่น (admin_revoke_role P0002
      // role_not_found — ข้อความไทย ไร้ CLF มี block จริง) ถือ ref R2 · invocation
      // ปลอมอ้าง opKey complete_data_export_job + requestRef R2 → ห้ามอ้าง
      // หลักฐานของ invocation อื่นข้าม RPC: ชั้น collision (ledger) จับก่อน (ชั้น
      // parser record-เดียวคือแนวรับที่สอง — พิสูจน์แยกใน describe pure)
      admin = await createTestUser("m1r9-revoke-admin", "super_admin");
      const adminAal2 = await mintAal2Token(admin);
      expect(adminAal2).not.toBe("");
      target = await createTestUser("m1r9-revoke-target"); // ถือ citizen — ไม่ถือ instructor
      const r2 = crypto.randomUUID();
      const revoke = await httpWrite(
        "POST",
        "/rest/v1/rpc/admin_revoke_role",
        {
          p_user_id: target.id,
          p_role: "instructor",
          p_reason: "m1r9-ref-cross-rpc-guard",
          p_request_id: r2,
        },
        { apiKey: ANON_KEY, token: adminAal2, settleMode: "scenario", label: "m1r9-revoke-real" },
      );
      expect(revoke.status, "role_not_found P0002 จริง = 500 opaque (dcr12 c2)").toBe(500);
      await settleScenario(
        revoke,
        "guard-r9-revoke-settles-own-block",
        () => scenarioTerminalProbe("public.role_assignments", "admin_revoke_role"),
      );
      const [revokeLeg] = await psqlRows<{ leg: string | null }>(`
        select payload ->> 'evidenceLeg' as leg
          from test_infra.lifecycle_ledger
         where kind = 'invocation' and invocation_id = '${revoke.invocationId}'
         order by ts desc, id desc limit 1;`);
      expect(revokeLeg?.leg, "revoke จริงต้อง settle ด้วย error block ของตัวเอง (record เดียว ของ RPC ตัวเอง)").toBe("db-error-block");

      // invocation ปลอม: opKey complete + ref R2 (ของ revoke จริง) + nonce/cursor
      // จริงจาก ledgerWrite — ห้าม settle ด้วยกลไกใด (หลักฐานของ invocation อื่น)
      const fakeId = crypto.randomUUID();
      const fakeNonce = mintUaNonce();
      const fakeOpKey = "rpc:complete_data_export_job:POST";
      await ledgerWrite(
        "invocation",
        {
          status: "running",
          label: "m1r9-fabricated-cross-rpc",
          opKey: fakeOpKey,
          transport: "httpWrite",
          transportTarget: "kong-path",
          binding: {
            opKey: fakeOpKey,
            method: "POST",
            urlNormalized: "/rest/v1/rpc/complete_data_export_job",
            uaNonce: fakeNonce,
            requestRef: r2,
          },
        },
        { opKey: fakeOpKey, invocationId: fakeId },
      );
      await ledgerWrite(
        "attempt",
        { transport: "httpWrite", uaNonce: fakeNonce, parentCallKey: null, logCursor: await captureLogCursor(), beforeSnapshot: null },
        { opKey: fakeOpKey, invocationId: fakeId },
      );
      const flie = { status: 500, json: null, text: "", invocationId: fakeId, opKey: fakeOpKey } as const;
      // two-way ทิศ ข: ข้อความ "ซ้ำกับ invocation อื่น" มีเฉพาะ v7 (ชั้น collision
      // จาก ledger) — v6 ไม่มีชั้นนี้: settle ของ fake จบด้วยข้อความอื่นเสมอ
      // ("ไม่มี kong access line" เมื่อ matcher เก่าเห็น block ของ revoke แล้วเดิน
      // ต่อ หรือ "ไม่มีหลักฐาน terminal …" เมื่อหน้าต่าง cursor-anchored ของ v6
      // ไม่เห็น block ใด) — assert เฉพาะข้อความของ v7 = ล้มบนโค้ดเก่าทุกกรณี ·
      // ชั้น parser record-เดียว (ทิศสกปรกกว่า: ยืมแถวข้ามก้อน) พิสูจน์แยกที่
      // describe pure ด้านบน (input codex → 0 บน v7 / v6 = 1)
      await expect(
        settleScenario(flie, "guard-r9-cross-rpc-evidence-must-refuse", () =>
          scenarioTerminalProbe("public.event_outbox", "complete_data_export_job")),
      ).rejects.toThrow(/requestRef .* ซ้ำกับ invocation อื่น/);
      await closeFake(fakeId, fakeOpKey, "settle-refused-cross-invocation-evidence");
    } finally {
      if (target !== null) {
        await deleteTestUser(target.id).catch(() => undefined);
      }
      if (admin !== null) {
        await deleteTestUser(admin.id).catch(() => undefined);
      }
      await startMailer().catch((err) => {
        process.stderr.write(`m1r9: startMailer ล้มใน finally — ต้องสตาร์ต mailer คืนด้วยมือ: ${String(err)}\n`);
      });
    }
  }, 240_000);
});
