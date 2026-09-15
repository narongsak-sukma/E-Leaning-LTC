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
    const { restCall, settleScenario, tableTerminalProbe, scenarioTerminalProbe, psqlScalar, SERVICE_KEY } =
      await import("./helpers");
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
    }
  }, 60_000);

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
    const { settleScenario, scenarioTerminalProbe, psqlScalar, SERVICE_KEY } = await import("./helpers");
    const { httpWrite, startPsqlSession } = await import("./test-io");
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
    }
  }, 60_000);

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
    const { restCall, settleScenario, scenarioTerminalProbe, psqlScalar, SERVICE_KEY } =
      await import("./helpers");
    const { httpWrite, startPsqlSession } = await import("./test-io");
    const jobId = "00000000-0000-4000-8000-0000000000f7"; // ไม่มีอยู่ → P0002 opaque 500
    const dispatchBody = () => ({
      p_job_id: jobId,
      p_file_media_id: "00000000-0000-4000-8000-0000000000f8",
      p_chunks: 1,
      p_request_id: crypto.randomUUID(), // requestRef ผูก activity ราย invocation
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
  }, 90_000);
});
