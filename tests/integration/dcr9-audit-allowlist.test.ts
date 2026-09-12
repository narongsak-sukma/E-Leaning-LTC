/**
 * DCR-9 (ต่อ) — integration tests ของ migration 0032_credit_rule_audit_allowlist.sql
 * (ตามข้อความมอบหมายเพิ่มเติมจาก lead — เปิด CREDIT_RULE_CREATE/CREDIT_RULE_UPDATE ใน
 *  allowlist ของ RPC append_audit_event ฝั่ง service_role):
 *   1) CREDIT_RULE_CREATE — context ครบชุดตาม schema ของ event ({rule_id, code,
 *      credit_type, credits, effective_from} + user_id) → ผ่าน: ได้ uuid กลับ และแถว
 *      audit_logs ที่เกิดขึ้นมี actor_user_id = user_id ที่ส่งมา (lift ตาม AUDIT §1.2)
 *      และ context ที่เก็บจริงถูก strip user_id ออก เหลือเฉพาะ 5 คีย์ (strict)
 *   2) CREDIT_RULE_UPDATE — context {rule_id, code, status_from, status_to} + user_id
 *      → ผ่านด้วยกลไก lift/strip เดียวกัน
 *   3) strict keys — คีย์นอกชุดของ event (เช่น foo) → ปฏิเสธ SQLSTATE 22023 · และ
 *      user_id ที่ไม่ใช่ uuid ก็ 22023 (arm lift ของ 0032) — กรณีปฏิเสธไม่เขียนแถว
 *   4) regression guard — CREDIT_ADJUST ทาง service_role ยังถูกปฏิเสธ 42501 เสมอ
 *      (mutation ของ credit ต้องผ่าน RPC admin_credit_adjust ของ 0031 ทาง user-JWT
 *      เท่านั้น — ห้ามหลุดทาง service key)
 *
 * การควบคุมขอบเขตการเขียน (audit_logs เป็น append-only ตามดีไซน์ — ลบไม่ได้):
 *   - เคสที่ "ผ่าน" (1, 2) เรียก RPC ภายใต้ TX เดียว `begin; set local role service_role;
 *     … rollback;` — set role คือกลไกเดียวกับที่ PostgREST ทำต่อ request (ฟังก์ชันอ่าน
 *     current_setting('role')) และ rollback ทำให้ไม่ทิ้งแถว audit จริงค้าง DB
 *   - เคสที่ "ถูกปฏิเสธ" (3, 4) เรียกผ่าน REST ทางเดินจริงของ BFF (service key) — ปฏิเสธ
 *     = ไม่มีการเขียนแถวอยู่แล้ว (assert ซ้ำด้วย count = 0 ของ entity_id เฉพาะรัน)
 *   - ไม่มี fixture ใด ๆ ทั้งสิ้น (ไม่สร้างผู้ใช้/ตารางเพิ่ม) — ใช้ uuid ตายตัว + รหัส
 *     กฎผูกกับ RUN_ID ของรัน และ actor สาธิต STAFF_EXAM_DEMO_ID จาก seed
 */
import { describe, expect, it } from "vitest";

import { psql, restCall, SERVICE_KEY, type RestResult } from "./helpers.js";
import { STAFF_EXAM_DEMO_ID } from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** จุดอ้างอิงของรัน — ใช้ทำ entity_id/code ไม่ให้ซ้ำข้ามรัน (entity_id เป็น text ทั้งหมด) */
const RUN_ID = Date.now();
/** rule_id ที่ส่งใน context — audit ไม่มี FK ไป credit_rules จึงใช้ uuid ตายตัวของ suite ได้
 *  (แถวจริงถูก rollback ทิ้ง ไม่มีผลกับ DB) */
const RULE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-00320000000a";
/** entity_id ของ audit_logs เป็นคอลัมน์ uuid — ทุก entity_id ของ suite เลยต้องเป็น uuid
 *  รูปแบบถูกต้อง (แถว accept ถูก rollback / reject ไม่เขียนแถว จึงไม่มีทางชนของจริง) */
const ENTITY_PROBE = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000a1";
const ENTITY_STRICT = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000c1";
const ENTITY_BADUSER = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000c2";
const ENTITY_ADJUST = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000c3";

interface ProbeResult {
  readonly state: string;
  readonly val: string | null;
  readonly row: {
    readonly action: string;
    readonly actor: string | null;
    readonly entity_type: string;
    readonly entity_id: string | null;
    readonly has_user_id: boolean;
    readonly keys: readonly string[] | null;
    readonly before_null: boolean | null;
    readonly after_null: boolean | null;
  } | null;
}

/** เรียก RPC ทาง PostgREST ในนาม service_role (ทางเดินจริงของ BFF — ใช้กับเคสปฏิเสธ) */
function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/**
 * เรียก append_audit_event ในนาม service_role ภายใต้ TX เดียวแล้ว ROLLBACK เสมอ
 * (set local role service_role = กลไกเดียวกับที่ PostgREST set role ต่อ request —
 *  ตัว wrapper อ่าน current_setting('role') · rollback = ไม่ทิ้งแถว audit ค้าง DB)
 * ตัวฟังก์ชันถูกห่อด้วย begin/exception ใน DO block ที่จดผลลง temp table เพื่อให้
 * ทั้ง "ได้ uuid" และ "SQLSTATE ที่ถูกปฏิเสธ" อ่านกลับได้ในคำสั่งเดียว (ON_ERROR_STOP
 * จะไม่ตัดการทำงาน — เทสพังที่ assertion ใน TS เสมอ ข้อความ error อ่านได้เต็ม)
 */
async function probeInRollbackTx(
  action: "CREDIT_RULE_CREATE" | "CREDIT_RULE_UPDATE",
  contextJson: string,
): Promise<ProbeResult> {
  const out = await psql(`
    begin;
    set local role service_role;
    create temp table e12_probe (state text, val text) on commit drop;
    do $do$
    declare
      v uuid;
    begin
      begin
        v := public.append_audit_event(
          '${action}', 'credit_rule', '${ENTITY_PROBE}',
          null, null, '${contextJson}'::jsonb, null, null, null, null);
        insert into e12_probe values ('accepted', v::text);
      exception
        when others then
          insert into e12_probe values ('rejected', sqlstate || ':' || left(sqlerrm, 300));
      end;
    end
    $do$;
    reset role;
    select coalesce(jsonb_build_object(
      'state', (select state from e12_probe),
      'val', (select val from e12_probe),
      'row', (select jsonb_build_object(
                'action', a.action,
                'actor', a.actor_user_id::text,
                'entity_type', a.entity_type,
                'entity_id', a.entity_id,
                'has_user_id', a.context ? 'user_id',
                'keys', (select jsonb_agg(k order by k) from jsonb_object_keys(a.context) k),
                'before_null', a.before is null,
                'after_null', a.after is null)
              from public.audit_logs a
              where a.id::text = (select val from e12_probe where state = 'accepted'))
    ), '{}'::jsonb);
    rollback;
  `);
  // psql -At พิมพ์ command tag ของแต่ละ statement (BEGIN/SET/DO/RESET/ROLLBACK) ปน
  // stdout — อ่านเฉพาะบรรทัดสุดท้ายที่เป็น JSON ของ SELECT (ขึ้นต้นด้วย "{")
  const jsonLine = [...out.trim().split("\n")].reverse().find((line) => line.startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as ProbeResult;
}

/** นับแถว audit_logs ของ entity_id (text) เฉพาะรัน — ใช้ยืนยันว่าเคสปฏิเสธไม่เขียนแถว */
async function auditRowCount(entityId: string): Promise<number> {
  const n = await psql(`
    select count(*)::int from public.audit_logs where entity_id = '${entityId}';
  `);
  return Number(n.trim());
}

/** สร้าง context ของ CREDIT_RULE_CREATE ตาม schema ของ 0032 (+ user_id ให้ lift เป็น actor) */
function createContext(extraKeys: Readonly<Record<string, unknown>> = {}): string {
  const base: Record<string, unknown> = {
    rule_id: RULE_ID,
    code: `CR-0032-${RUN_ID}`,
    credit_type: "general",
    credits: 3.5,
    effective_from: "2026-01-01",
    user_id: STAFF_EXAM_DEMO_ID,
    ...extraKeys,
  };
  return JSON.stringify(base).replace(/'/g, "''");
}

describe.skipIf(!DB_URL)(
  "DCR-9 ตัวกรอง audit RPC ของ 0032 (CREDIT_RULE_* ทาง service_role — lift/strip + strict keys)",
  () => {
    // ─── เคส 1: CREDIT_RULE_CREATE ยอมรับ (โจทย์ข้อ 1) ──────────────────────────

    it("เคส 1 CREDIT_RULE_CREATE ทาง service_role: context ครบ 5 คีย์ + user_id → ผ่าน ได้ uuid + แถว audit actor_user_id = user_id ที่ส่ง (lift) และ context ถูก strip เหลือ 5 คีย์", async () => {
      const result = await probeInRollbackTx("CREDIT_RULE_CREATE", createContext());
      expect(result.state, JSON.stringify(result)).toBe("accepted");
      expect(result.val).toMatch(/^[0-9a-f-]{36}$/);
      const row = result.row;
      expect(row).not.toBeNull();
      expect(row?.action).toBe("CREDIT_RULE_CREATE");
      // lift: actor = user_id ที่ส่งมาใน context (BFF ใส่ในนามผู้ดำเนินการที่ผ่านสิทธิ์แล้ว)
      expect(row?.actor).toBe(STAFF_EXAM_DEMO_ID);
      // strip: context ที่เก็บจริงไม่มี user_id แล้ว — เหลือเฉพาะ 5 คีย์ของ schema
      expect(row?.has_user_id).toBe(false);
      expect(row?.keys).toEqual(["code", "credits", "credit_type", "effective_from", "rule_id"]);
      expect(row?.entity_type).toBe("credit_rule");
      expect(row?.entity_id).toBe(ENTITY_PROBE);
      // class ข ห้าม diff (AUDIT §3.2) — before/after ต้องเป็น null เสมอ
      expect(row?.before_null).toBe(true);
      expect(row?.after_null).toBe(true);
    });

    // ─── เคส 2: CREDIT_RULE_UPDATE ยอมรับ (โจทย์ข้อ 2) ──────────────────────────

    it("เคส 2 CREDIT_RULE_UPDATE ทาง service_role: context {rule_id, code, status_from, status_to} + user_id → ผ่าน lift/strip เหมือนกัน", async () => {
      const context = JSON.stringify({
        rule_id: RULE_ID,
        code: `CR-0032-${RUN_ID}`,
        status_from: "draft",
        status_to: "active",
        user_id: STAFF_EXAM_DEMO_ID,
      }).replace(/'/g, "''");
      const result = await probeInRollbackTx("CREDIT_RULE_UPDATE", context);
      expect(result.state, JSON.stringify(result)).toBe("accepted");
      expect(result.val).toMatch(/^[0-9a-f-]{36}$/);
      const row = result.row;
      expect(row).not.toBeNull();
      expect(row?.action).toBe("CREDIT_RULE_UPDATE");
      expect(row?.actor).toBe(STAFF_EXAM_DEMO_ID);
      expect(row?.has_user_id).toBe(false);
      expect(row?.keys).toEqual(["code", "rule_id", "status_from", "status_to"]);
    });

    // ─── เคส 3: strict keys → 22023 (โจทย์ข้อ 3) ────────────────────────────────

    it("เคส 3 strict keys: context มีคีย์นอกชุด (foo) → ปฏิเสธ SQLSTATE 22023 และไม่เขียนแถว · user_id ไม่ใช่ uuid ก็ 22023", async () => {
      // (a) คีย์นอกชุด — ทางเดินจริงของ PostgREST (service key)
      const denied = await svcRpc("append_audit_event", {
        p_action: "CREDIT_RULE_CREATE",
        p_entity_type: "credit_rule",
        p_entity_id: ENTITY_STRICT,
        p_before: null,
        p_after: null,
        p_context: { ...JSON.parse(createContext()), foo: "คีย์นอกชุด" },
        p_actor_roles: null,
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: null,
      });
      expect(denied.status, denied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      // SQLSTATE 22023 (invalid_parameter_value) — PostgREST ส่งกลับใน field code
      expect(((denied.json ?? {}) as { code?: string }).code).toBe("22023");
      expect(((denied.json ?? {}) as { message?: string }).message ?? "").toContain("strict");
      // ปฏิเสธ = ไม่เขียนแถว (ตรวจซ้ำบน entity_id ของ suite)
      expect(await auditRowCount(ENTITY_STRICT)).toBe(0);

      // (b) user_id ไม่ใช่ uuid — arm lift ของ 0032 ต้องปฏิเสธ 22023 เหมือนกัน
      const badUser = await svcRpc("append_audit_event", {
        p_action: "CREDIT_RULE_CREATE",
        p_entity_type: "credit_rule",
        p_entity_id: ENTITY_BADUSER,
        p_before: null,
        p_after: null,
        p_context: { ...JSON.parse(createContext()), user_id: "ไม่ใช่ uuid" },
        p_actor_roles: null,
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: null,
      });
      expect(badUser.status, badUser.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((badUser.json ?? {}) as { code?: string }).code).toBe("22023");
      expect(((badUser.json ?? {}) as { message?: string }).message ?? "").toContain("user_id");
      expect(await auditRowCount(ENTITY_BADUSER)).toBe(0);
    });

    // ─── เคส 4: CREDIT_ADJUST ทาง service_role ยังถูกปฏิเสธ (โจทย์ข้อ 4) ────────

    it("เคส 4 regression guard: CREDIT_ADJUST ทาง service_role → 42501 (mutation ต้องผ่าน admin_credit_adjust ทาง user-JWT เท่านั้น) และไม่เขียนแถว", async () => {
      const denied = await svcRpc("append_audit_event", {
        p_action: "CREDIT_ADJUST",
        p_entity_type: "credit_ledger",
        p_entity_id: ENTITY_ADJUST,
        p_before: null,
        p_after: null,
        p_context: { user_id: STAFF_EXAM_DEMO_ID },
        p_actor_roles: null,
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: null,
      });
      expect(denied.status, denied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      // SQLSTATE 42501 (insufficient_privilege) — PostgREST ส่งกลับใน field code
      expect(((denied.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((denied.json ?? {}) as { message?: string }).message ?? "").toContain(
        "CREDIT_ADJUST",
      );
      expect(await auditRowCount(ENTITY_ADJUST)).toBe(0);
    });
  },
);
