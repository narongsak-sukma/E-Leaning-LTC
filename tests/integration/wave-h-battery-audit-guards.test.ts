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
  }, 45_000);
});
