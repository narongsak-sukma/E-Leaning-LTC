/**
 * DCR-9 (ต่อ) — integration tests ของ migration 0032_credit_rule_atomic_rpc.sql
 * (gate r1 fix wave — 0032 ถูกเขียนใหม่: ตัด allowlist CREDIT_RULE_* ของ wrapper
 *  append_audit_event กลับสู่ชุด 0025 + RPC ครอบ mutation ของกฎเครดิต):
 *   1) CREDIT_RULE_CREATE/UPDATE ทาง wrapper ฝั่ง service_role → ปฏิเสธ 42501 เสมอ
 *      (allowlist กลับสู่ 0025 — mutation เขียน audit ได้เฉพาะใน TX ของ RPC คู่)
 *   2) PII_ACCESS ทาง service_role ยังเดิน lift/strip ตามแบบ (accept ใน TX แล้ว rollback):
 *      actor ถูกยกจาก context.user_id (lift) และ context ที่เก็บจริงถูก strip user_id ออก
 *      (strict keys — เหลือ endpoint/purpose/target_user_id)
 *   3) strict keys — คีย์นอกชุด (foo) → 22023 · user_id ไม่ใช่ uuid → 22023 (arm lift)
 *   4) regression guard — CREDIT_ADJUST ทาง service_role → 42501
 *   5) ปิด write ตรง (0032 §5 revoke): INSERT/PATCH credit_rules ทาง REST ทั้ง
 *      authenticated และ service_role → 42501 — เหลือ path เดียวผ่าน RPC คู่
 *   6) ลำดับ guard ของ RPC คู่ (login → aal2 → role): aal1 → ERR-AUTH-004 ก่อนเสมอ
 *      ไม่ว่า role — ส่วน aal2 แต่ role ไม่พอ → ERR-RBAC-001
 *   7) happy path ของ RPC คู่ (aal2 registrar): admin_create_credit_rule → 200 + แถว
 *      credit_rules (status draft) + audit CREDIT_RULE_CREATE (actor = registrar ·
 *      context 5 คีย์เป๊ะ) · admin_update_credit_rule_status ร่าง→ใช้งาน → 200 + audit
 *      CREDIT_RULE_UPDATE (status_from/to) · transition ซ้ำ → 22023 invalid_transition
 *
 * การควบคุมขอบเขตการเขียน:
 *   - เคส accept ของ wrapper (2) เรียกภายใต้ TX probe `begin; set local role
 *     service_role; … rollback;` — set role = กลไกเดียวกับที่ PostgREST ทำต่อ request
 *     (ตัวฟังก์ชันอ่าน current_setting('role')) · rollback = ไม่ทิ้งแถว audit ค้าง DB
 *   - เคสปฏิเสธ (1, 3, 4) เรียกผ่าน REST ทางเดินจริงของ BFF (service key) — ปฏิเสธ =
 *     ไม่มีการเขียนแถว (assert ซ้ำด้วย count = 0 ของ entity_id เฉพาะรัน)
 *   - **ขอบเขตเศษซากที่ตั้งใจคงไว้ (residue policy)**: เคส 7 สร้าง credit_rules จริง 1
 *     แถว + แถว audit_logs (CREDIT_RULE_CREATE/UPDATE) — audit_logs append-only ตาม
 *     ดีไซน์ จึงคงไว้เหมือนชุด D-8 (assert เสมอด้วย rule id ของรันนี้) ส่วนแถวกฎถูกลบใน
 *     afterAll ด้วย id ที่รันติดตาม (superuser DELETE ไม่ถูก revoke ตาม 0032 §5 —
 *     ไม่กวาดด้วยรหัส เพราะย่าน CR-LTC-7xx อาจมีกฎจริงของ dev DB ปะปน)
 *   - B8: ผู้ใช้ fixture ถูกลบด้วย id ที่รันนี้สร้างก่อน แล้วค่อยรื้อด้วย prefix sweep
 *     'dcr9-audit-%' เป็นเข็มขัดชั้นสอง (ครอบของค้างจากรันที่พังกลางทาง)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANON_KEY,
  createTestUser,
  psql,
  psqlRows,
  restCall,
  SERVICE_KEY,
  type RestResult,
  type TestUser,
} from "./helpers.js";
import { mintAal2Token } from "./helpers-aal2.js";
import { STAFF_EXAM_DEMO_ID } from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** จุดอ้างอิงของรัน — ใช้เลือกหมายเลขรหัสกฎ (ย่าน 700-949) ไม่ให้ชนรหัสของรันอื่น */
const RUN_ID = Date.now();
/** gate r2 BLOCKER-4 — เวลาเริ่มรันของ suite: เข็มขัด cleanup ของรหัส guard (ย่าน
 *  CR-LTC-7xx ซึ่งมีกฎของ dev DB จริงปะปน) ต้องกรอง created_at >= จุดนี้ด้วย —
 *  ไม่งั้นชนรหัสกับกฎจริงที่สร้างก่อนหน้าแล้ว cleanup ลบกฎของคนอื่นทิ้ง */
const SUITE_STARTED_AT = new Date().toISOString();
/** entity_id ของ audit_logs เป็นคอลัมน์ uuid — ทุก entity_id ของ suite ต้องเป็น uuid
 *  รูปแบบถูกต้อง (แถว accept ถูก rollback / reject ไม่เขียนแถว จึงไม่มีทางชนของจริง) */
const ENTITY_PROBE = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000a1";
const ENTITY_RULE_CREATE = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000b1";
const ENTITY_RULE_UPDATE = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000b2";
const ENTITY_STRICT = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000c1";
const ENTITY_BADUSER = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000c2";
const ENTITY_ADJUST = "aaaaaaaa-aaaa-4aaa-8aaa-0032000000c3";

/** ผู้ใช้ fixture (staff จริงผ่าน GoTrue) + session aal2 ที่ mint ใน beforeAll */
let registrarUser: TestUser;
let viewerUser: TestUser;
let registrarAal2 = "";
let viewerAal2 = "";
/** id กฎที่เคส 7 สร้างจริง (track เพื่อลบใน afterAll) */
let createdRuleId = "";
/** รหัส guard ที่เคส 6 เลือกใช้จริง (หลังเดินเลี่ยงรหัสที่มีอยู่ก่อน) — เข็มขัด cleanup
 *  ของ afterAll อ้างตัวนี้ (gate r2 BLOCKER-4: ต้องกรอง created_at ด้วยเพราะย่าน 7xx
 *  มีกฎจริงของ dev DB ปะปน) */
let guardCode = "";
/** B8 — id ผู้ใช้ที่รันนี้สร้าง (ลบด้วย id ก่อน แล้วค่อย prefix sweep เป็นเข็มขัดชั้นสอง) */
let trackedUserIds: readonly string[] = [];

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

/** เรียก RPC ในนามผู้ใช้ (JWT จริงจาก GoTrue — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

/**
 * เรียก append_audit_event ในนาม service_role ภายใต้ TX เดียวแล้ว ROLLBACK เสมอ
 * (set local role service_role = กลไกเดียวกับที่ PostgREST set role ต่อ request —
 *  ตัว wrapper อ่าน current_setting('role') · rollback = ไม่ทิ้งแถว audit ค้าง DB)
 * ตัวฟังก์ชันถูกห่อด้วย begin/exception ใน DO block ที่จดผลลง temp table เพื่อให้
 * ทั้ง "ได้ uuid" และ "SQLSTATE ที่ถูกปฏิเสธ" อ่านกลับได้ในคำสั่งเดียว (ON_ERROR_STOP
 * จะไม่ตัดการทำงาน — เทสพังที่ assertion ใน TS เสมอ ข้อความ error อ่านกลับได้เต็ม)
 */
async function probeInRollbackTx(
  action: "PII_ACCESS",
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
          '${action}', 'profile', '${ENTITY_PROBE}', null, null,
          '${contextJson}'::jsonb, null, null, null, null);
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
                'keys', (select jsonb_agg(kk.k order by kk.k) from jsonb_object_keys(a.context) as kk(k)),
                'before_null', a.before is null,
                'after_null', a.after is null)
              from public.audit_logs a
              where a.id::text = (select val from e12_probe where state = 'accepted'))
    ), '{}'::jsonb);
    rollback;
  `);
  // psql -At พิมพ์ command tag (BEGIN/SET/DO/RESET/ROLLBACK) ปน stdout — อ่านเฉพาะบรรทัด
  // สุดท้ายที่เป็น JSON ของ SELECT (ขึ้นต้นด้วย "{")
  const jsonLine = [...out.trim().split("\n")].reverse().find((line) => line.startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as ProbeResult;
}

/** นับแถว audit_logs ของ entity_id เฉพาะรัน — ใช้ยืนยันว่าเคสปฏิเสธไม่เขียนแถว */
async function auditRowCount(entityId: string): Promise<number> {
  const n = await psql(`
    select count(*)::int from public.audit_logs where entity_id = '${entityId}';
  `);
  return Number(n.trim());
}

/**
 * สร้างกฎผ่าน admin_create_credit_rule (aal2 registrar) พร้อม retry เมื่อชน
 * code_duplicate (23505) — เลือกหมายเลขจาก RUN_ID ในย่าน 700-949 ขยับทีละ 7
 */
async function createRuleWithRetry(): Promise<{ id: string; code: string }> {
  const bodyFor = (code: string) => ({
    p_code: code,
    p_name: "กฎทดสอบ atomic RPC ของ DCR-9 (integration)",
    p_course_id: null,
    p_credit_type: "general",
    p_credits: 3.5,
    p_valid_days: 365,
    p_carry_over: false,
    p_required_credits_per_cycle: 12,
    p_priority: 10,
    p_renewal_cycle: "annual",
    p_effective_from: "2026-01-01",
    p_effective_to: null,
    p_request_id: crypto.randomUUID(),
  });
  for (let i = 0; i < 10; i += 1) {
    const code = `CR-LTC-${700 + ((RUN_ID + i * 7) % 250)}`; // 700-949
    const res = await userRpc("admin_create_credit_rule", registrarAal2, bodyFor(code));
    if (res.status === 200) {
      const row = res.json as { id: string; code: string };
      createdRuleId = row.id;
      return row;
    }
    // 23505 = code_duplicate — ลองหมายเลขถัดไป (ย่าน 7xx อาจมีกฎของ dev DB จริงปะปน)
    if (((res.json ?? {}) as { code?: string }).code === "23505") continue;
    throw new Error(`admin_create_credit_rule ล้มด้วยเหตุอื่น: ${res.text.slice(0, 300)}`);
  }
  throw new Error("admin_create_credit_rule ล้มทั้ง 10 รหัส (ชน code_duplicate หมด)");
}

/**
 * ล้างโลกของ suite — ลบกฎด้วย id ที่ track ไว้ (ไม่กวาดย่านรหัส) และผู้ใช้แบบ
 * tracked-first (B8) แล้ว prefix sweep เป็นเข็มขัดชั้นสอง · audit_logs คงไว้ตาม
 * residue policy ใน header · mfa_factors/sessions cascade ตาม auth.users
 */
async function cleanupAuditWorld(): Promise<void> {
  // เข็มขัดชั้นสองเฉพาะ suite: รหัสที่เคส 5/6 อาจหลุดเขียนได้หาก revoke/guard พังจริง
  // (regression) — E12-DIRECT-% เป็นเนมสเปซของ suite · รหัส guard = ตัวที่เคส 6 เลือก
  //   จริง (guardCode) · gate r2 BLOCKER-4: ย่าน CR-LTC-7xx มีกฎของ dev DB จริง — ลบ
  //   เฉพาะแถวที่ถูกสร้างตั้งแต่ suite เริ่ม (created_at >= SUITE_STARTED_AT) เท่านั้น
  await psql(`
    delete from public.credit_rules
     where code like 'E12-DIRECT-%'
        ${guardCode ? `or (code = '${guardCode}' and created_at >= '${SUITE_STARTED_AT}')` : ""};
  `);
  if (createdRuleId) {
    await psql(`delete from public.credit_rules where id = '${createdRuleId}';`);
  }
  const trackedList = trackedUserIds.map((id) => `'${id}'`).join(",");
  const users = await psqlRows<{ id: string }>(`
    select id::text from auth.users
     where email like 'dcr9-audit-%'
       ${trackedList.length > 0 ? `or id in (${trackedList})` : ""}
  `);
  if (users.length > 0) {
    const list = users.map((u) => `'${u.id}'`).join(",");
    await psql(`
      delete from public.role_assignments where user_id in (${list});
      delete from public.profiles where id in (${list});
      delete from auth.users where id in (${list});
    `);
  }
}

describe.skipIf(!DB_URL)(
  "DCR-9 ตัวกรอง audit RPC ของ 0032 รุ่น atomic (CREDIT_RULE_* ถูกตัดจาก allowlist + RPC ครอบ mutation กฎเครดิต)",
  () => {
    beforeAll(async () => {
      // ล้างของค้างจากรันที่พังกลางทาง (tracked-first + prefix belt) ก่อนสร้าง fixture
      await cleanupAuditWorld();
      registrarUser = await createTestUser("dcr9-audit-registrar", "staff:registrar");
      viewerUser = await createTestUser("dcr9-audit-viewer", "staff:viewer");
      trackedUserIds = [registrarUser.id, viewerUser.id];
      // session aal2 จริง — enroll TOTP + challenge/verify ด้วยรหัส RFC 6238 ที่ harness สร้างเอง
      registrarAal2 = await mintAal2Token(registrarUser);
      viewerAal2 = await mintAal2Token(viewerUser);
    }, 300_000);

    afterAll(async () => {
      await cleanupAuditWorld();
    });

    // ─── เคส 1: CREDIT_RULE_* ทาง wrapper service_role → 42501 (flip ตาม 0032 รุ่น atomic) ──

    it("เคส 1 CREDIT_RULE_CREATE/UPDATE ทาง wrapper service_role → 42501 (allowlist กลับสู่ 0025) และไม่เขียนแถว audit", async () => {
      // context ตาม schema ของ event เดิม (+ user_id ให้ lift) — แต่ action ไม่อยู่ใน
      // allowlist ของ 0025 อีกต่อไป จึงต้องถูกปฏิเสธก่อน strict-keys ทุกกรณี
      const contextCreate = {
        rule_id: ENTITY_RULE_CREATE,
        code: `CR-LTC-${700 + (RUN_ID % 250)}`,
        credit_type: "general",
        credits: 3.5,
        effective_from: "2026-01-01",
        user_id: STAFF_EXAM_DEMO_ID,
      };
      const create = await svcRpc("append_audit_event", {
        p_action: "CREDIT_RULE_CREATE",
        p_entity_type: "credit_rule",
        p_entity_id: ENTITY_RULE_CREATE,
        p_before: null,
        p_after: null,
        p_context: contextCreate,
        p_actor_roles: null,
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: null,
      });
      expect(create.status, create.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      // SQLSTATE 42501 (insufficient_privilege) — PostgREST ส่งกลับใน field code
      expect(((create.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((create.json ?? {}) as { message?: string }).message ?? "").toContain(
        "CREDIT_RULE_CREATE",
      );
      const update = await svcRpc("append_audit_event", {
        p_action: "CREDIT_RULE_UPDATE",
        p_entity_type: "credit_rule",
        p_entity_id: ENTITY_RULE_UPDATE,
        p_before: null,
        p_after: null,
        p_context: {
          rule_id: ENTITY_RULE_CREATE,
          code: `CR-LTC-${700 + (RUN_ID % 250)}`,
          status_from: "draft",
          status_to: "active",
          user_id: STAFF_EXAM_DEMO_ID,
        },
        p_actor_roles: null,
        p_ip_hash: null,
        p_user_agent: null,
        p_request_id: null,
      });
      expect(update.status, update.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((update.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((update.json ?? {}) as { message?: string }).message ?? "").toContain(
        "CREDIT_RULE_UPDATE",
      );
      // ปฏิเสธ = ไม่เขียนแถว (ตรวจซ้ำบน entity_id ของ suite)
      expect(await auditRowCount(ENTITY_RULE_CREATE)).toBe(0);
      expect(await auditRowCount(ENTITY_RULE_UPDATE)).toBe(0);
    });

    // ─── เคส 2: PII_ACCESS lift/strip accept (rollback probe) ────────────────────

    it("เคส 2 PII_ACCESS ทาง service_role: lift actor จาก context.user_id + strip ออกจาก context ที่เก็บจริง — strict เหลือ 3 คีย์", async () => {
      const context = JSON.stringify({
        endpoint: "rpc append_audit_event (integration)",
        target_user_id: STAFF_EXAM_DEMO_ID,
        purpose: "การทดสอบการเข้าถึงข้อมูลส่วนบุคคลของ harness",
        user_id: STAFF_EXAM_DEMO_ID,
      }).replace(/'/g, "''");
      const result = await probeInRollbackTx("PII_ACCESS", context);
      expect(result.state, JSON.stringify(result)).toBe("accepted");
      expect(result.val).toMatch(/^[0-9a-f-]{36}$/);
      const row = result.row;
      expect(row).not.toBeNull();
      expect(row?.action).toBe("PII_ACCESS");
      // lift: actor = user_id ที่ BFF (trusted) ใส่มาในนามผู้ดำเนินการที่ผ่านสิทธิ์แล้ว
      expect(row?.actor).toBe(STAFF_EXAM_DEMO_ID);
      // strip: context ที่เก็บจริงไม่มี user_id — strict เหลือ 3 คีย์ของ schema
      expect(row?.has_user_id).toBe(false);
      expect(row?.keys).toEqual(["endpoint", "purpose", "target_user_id"]);
      // class ข ห้าม diff (AUDIT §3.2) — before/after ต้องเป็น null เสมอ
      expect(row?.before_null).toBe(true);
      expect(row?.after_null).toBe(true);
    });

    // ─── เคส 3: strict keys + user_id ไม่ใช่ uuid → 22023 ────────────────────────

    it("เคส 3 strict keys: context มีคีย์นอกชุด (foo) → 22023 และไม่เขียนแถว · user_id ไม่ใช่ uuid ก็ 22023 (arm lift)", async () => {
      // (a) คีย์นอกชุด — ทางเดินจริงของ PostgREST (service key)
      const denied = await svcRpc("append_audit_event", {
        p_action: "PII_ACCESS",
        p_entity_type: "profile",
        p_entity_id: ENTITY_STRICT,
        p_before: null,
        p_after: null,
        p_context: {
          endpoint: "rpc append_audit_event (integration)",
          target_user_id: STAFF_EXAM_DEMO_ID,
          purpose: "การทดสอบการเข้าถึงข้อมูลส่วนบุคคลของ harness",
          foo: "คีย์นอกชุด",
        },
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

      // (b) user_id ไม่ใช่ uuid — arm lift ของ wrapper ต้องปฏิเสธ 22023 เหมือนกัน
      const badUser = await svcRpc("append_audit_event", {
        p_action: "PII_ACCESS",
        p_entity_type: "profile",
        p_entity_id: ENTITY_BADUSER,
        p_before: null,
        p_after: null,
        p_context: {
          endpoint: "rpc append_audit_event (integration)",
          target_user_id: STAFF_EXAM_DEMO_ID,
          purpose: "การทดสอบการเข้าถึงข้อมูลส่วนบุคคลของ harness",
          user_id: "ไม่ใช่ uuid",
        },
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

    // ─── เคส 4: regression guard — CREDIT_ADJUST ทาง service_role → 42501 ────────

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
      expect(((denied.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((denied.json ?? {}) as { message?: string }).message ?? "").toContain(
        "CREDIT_ADJUST",
      );
      expect(await auditRowCount(ENTITY_ADJUST)).toBe(0);
    });

    // ─── เคส 5: ปิด write ตรงบนตาราง (0032 §5 revoke) ─────────────────────────────

    it("เคส 5 ปิด write ตรง: INSERT/PATCH credit_rules ทาง REST ทั้ง authenticated และ service_role → 42501 (เหลือ path เดียวผ่าน RPC คู่)", async () => {
      // รหัส E12-DIRECT-* เป็นเนมสเปซของ suite (ตารางไม่มี CHECK รูปแบบรหัส — 0006)
      // · หาก revoke พังจริง (regression) แถวจะถูกสร้างและ belt ของ cleanupAuditWorld
      // จะลบด้วยรหัสเป๊ะของรันนี้
      const directCode = `E12-DIRECT-${RUN_ID}`;
      // (a) authenticated — สิทธิ์ table ถูก revoke ไม่ขึ้นกับ aal2/role (registrar aal1 พอ)
      const insAuth = await restCall(
        "POST",
        "/rest/v1/credit_rules",
        { apiKey: ANON_KEY, token: registrarUser.accessToken },
        {
          code: directCode,
          name: "พิสูจน์ revoke write ตรง (integration)",
          course_id: null,
          credit_type: "general",
          credits: 3.5,
          priority: 10,
          effective_from: "2026-01-01",
        },
      );
      expect(insAuth.status, insAuth.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((insAuth.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((insAuth.json ?? {}) as { message?: string }).message ?? "").toContain(
        "credit_rules",
      );
      // (b) service_role — ถูก revoke เช่นกัน
      const insSvc = await restCall(
        "POST",
        "/rest/v1/credit_rules",
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
        {
          code: directCode,
          name: "พิสูจน์ revoke write ตรง (integration)",
          course_id: null,
          credit_type: "general",
          credits: 3.5,
          priority: 10,
          effective_from: "2026-01-01",
        },
      );
      expect(insSvc.status, insSvc.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((insSvc.json ?? {}) as { code?: string }).code).toBe("42501");
      // (c) PATCH (update) — permission denied ยิงก่อน row matching จึง target uuid สุ่ม
      //     (ไม่มีทางแตะแถวจริงแม้ revoke จะยังผ่านบางส่วน)
      const patchAuth = await restCall(
        "PATCH",
        `/rest/v1/credit_rules?id=eq.${crypto.randomUUID()}`,
        { apiKey: ANON_KEY, token: registrarUser.accessToken },
        { name: "พยายามแก้ผ่าน REST (ต้องถูกปฏิเสธ)" },
      );
      expect(patchAuth.status, patchAuth.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((patchAuth.json ?? {}) as { code?: string }).code).toBe("42501");
      // ไม่มีแถวใดหลุดเขียนจริง (เช็คด้วยรหัสของรันนี้)
      const leaks = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.credit_rules where code = '${directCode}';
      `);
      expect(leaks[0]?.n).toBe(0);
    });

    // ─── เคส 6: ลำดับ guard ของ RPC คู่ (login → aal2 → role) ─────────────────────

    it("เคส 6 ลำดับ guard: aal1 → ERR-AUTH-004 ก่อนเสมอ (ไม่ว่า role) · aal2 แต่ role ไม่พอ → ERR-RBAC-001 · ไม่มีแถวกฎถูกสร้างหลุด", async () => {
      // guard ทำงานก่อน validation ทั้งหมด (0032 — บรรทัดแรกของทั้งสอง RPC) จึงใช้ body
      // ใด ๆ ก็ได้; รหัสจากย่านของรัน + assert count 0 ท้ายเคส + belt ใน cleanup
      // · gate r2 BLOCKER-4: ย่าน 7xx มีกฎจริงของ dev DB — เดิน +7 เลี่ยงรหัสที่มีอยู่ก่อน
      //   (ไม่งั้น assert count 0 ท้ายเคสเจอกฎของคนอื่น → เคสแดงหลอก) และจดรหัสที่เลือก
      //   ไว้ใน guardCode ระดับ suite ให้ belt ของ cleanup ใช้ตัวเดียวกัน
      guardCode = `CR-LTC-${700 + (RUN_ID % 250)}`;
      for (let i = 1; i <= 10; i += 1) {
        const taken = await psqlRows<{ n: number }>(`
          select count(*)::int as n from public.credit_rules where code = '${guardCode}';
        `);
        if ((taken[0]?.n ?? 0) === 0) break;
        guardCode = `CR-LTC-${700 + ((RUN_ID + i * 7) % 250)}`;
      }
      const body = {
        p_code: guardCode,
        p_name: "กฎทดสอบลำดับ guard (integration)",
        p_course_id: null,
        p_credit_type: "general",
        p_credits: 3.5,
        p_valid_days: 365,
        p_carry_over: false,
        p_required_credits_per_cycle: 12,
        p_priority: 10,
        p_renewal_cycle: "annual",
        p_effective_from: "2026-01-01",
        p_effective_to: null,
        p_request_id: crypto.randomUUID(),
      };
      // (a) viewer ที่ยังไม่ผ่าน MFA (aal1) — aal2 gate มาก่อน role (ต่างจาก
      //     admin_credit_adjust ของ 0031 ที่ตรวจ RBAC ก่อน aal2)
      const aal1Viewer = await userRpc("admin_create_credit_rule", viewerUser.accessToken, body);
      expect(aal1Viewer.status, aal1Viewer.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((aal1Viewer.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((aal1Viewer.json ?? {}) as { message?: string }).message ?? "").toContain(
        "ERR-AUTH-004",
      );
      // (b) viewer ผ่าน MFA แล้ว (aal2) — ผ่าน aal2 gate แต่ role ไม่พอ
      const rbacDenied = await userRpc("admin_create_credit_rule", viewerAal2, body);
      expect(rbacDenied.status, rbacDenied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((rbacDenied.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((rbacDenied.json ?? {}) as { message?: string }).message ?? "").toContain(
        "ERR-RBAC-001",
      );
      // (c) registrar ที่ยังไม่ผ่าน MFA (aal1) — role ผ่านแต่โดน aal2 gate
      const aal1Registrar = await userRpc(
        "admin_create_credit_rule",
        registrarUser.accessToken,
        body,
      );
      expect(aal1Registrar.status, aal1Registrar.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((aal1Registrar.json ?? {}) as { code?: string }).code).toBe("42501");
      expect(((aal1Registrar.json ?? {}) as { message?: string }).message ?? "").toContain(
        "ERR-AUTH-004",
      );
      // ไม่มีแถวกฎหลุดสร้างจากทั้งสาม call (guard ต้องตัดก่อนถึง INSERT เสมอ)
      const leaks = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.credit_rules where code = '${guardCode}';
      `);
      expect(leaks[0]?.n).toBe(0);
    });

    // ─── เคส 7: happy path ของ RPC คู่ + audit ใน TX เดียว (task a + b) ───────────

    it("เคส 7 admin_create_credit_rule (aal2 registrar) → 200 + แถว draft + audit CREDIT_RULE_CREATE 5 คีย์เป๊ะ · admin_update_credit_rule_status ร่าง→ใช้งาน → 200 + audit CREDIT_RULE_UPDATE · transition ซ้ำ → 22023 invalid_transition", async () => {
      const { id, code } = await createRuleWithRetry();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      // แถวจริงบน DB — status default draft · ค่าตรงตามที่ส่ง
      const rows = await psqlRows<{ status: string; code: string; credits: string }>(`
        select status::text, code, credits::text
          from public.credit_rules where id = '${id}';
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("draft");
      expect(rows[0]?.code).toBe(code);
      expect(rows[0]?.credits).toBe("3.50");
      // audit CREDIT_RULE_CREATE — actor = registrar (มาจาก auth.uid ใน TX เดียวกัน) ·
      // context คีย์เป๊ะ 5 ตัวตาม AUDIT §2.1
      const createAudit = await psqlRows<{
        actor: string | null;
        code: string;
        keys: readonly string[];
      }>(`
        select a.actor_user_id::text as actor,
               a.context ->> 'code' as code,
               (select jsonb_agg(kk.k order by kk.k) from jsonb_object_keys(a.context) as kk(k)) as keys
          from public.audit_logs a
         where a.action = 'CREDIT_RULE_CREATE' and a.entity_id::text = '${id}';
      `);
      expect(createAudit).toHaveLength(1);
      expect(createAudit[0]?.actor).toBe(registrarUser.id);
      expect(createAudit[0]?.code).toBe(code);
      // เทียบ "ชุดคีย์" หลัง sort — jsonb_agg(order by k) เรียงตาม collation ของ DB
      // (en_US.UTF-8 วาง underscore ท้าย จึงได้ credits มาก่อน credit_type —
      //  ลำดับจอไม่ใช่สัญญาของ migration ชุดคีย์ต่างหากที่เป็นสัญญา)
      expect([...(createAudit[0]?.keys ?? [])].sort()).toEqual([
        "code",
        "credit_type",
        "credits",
        "effective_from",
        "rule_id",
      ]);
      // transition ร่าง → ใช้งาน
      const activate = await userRpc("admin_update_credit_rule_status", registrarAal2, {
        p_rule_id: id,
        p_status: "active",
        p_request_id: crypto.randomUUID(),
      });
      expect(activate.status, activate.text.slice(0, 300)).toBe(200);
      expect((activate.json as { status: string }).status).toBe("active");
      // แถวบน DB เปลี่ยนจริง
      const after = await psqlRows<{ status: string }>(`
        select status::text from public.credit_rules where id = '${id}';
      `);
      expect(after[0]?.status).toBe("active");
      // audit CREDIT_RULE_UPDATE — status_from/to ครบ และ actor = registrar
      const updateAudit = await psqlRows<{
        actor: string | null;
        status_from: string;
        status_to: string;
        keys: readonly string[];
      }>(`
        select a.actor_user_id::text as actor,
               a.context ->> 'status_from' as status_from,
               a.context ->> 'status_to' as status_to,
               (select jsonb_agg(kk.k order by kk.k) from jsonb_object_keys(a.context) as kk(k)) as keys
          from public.audit_logs a
         where a.action = 'CREDIT_RULE_UPDATE' and a.entity_id::text = '${id}';
      `);
      expect(updateAudit).toHaveLength(1);
      expect(updateAudit[0]?.actor).toBe(registrarUser.id);
      expect(updateAudit[0]?.status_from).toBe("draft");
      expect(updateAudit[0]?.status_to).toBe("active");
      // เทียบชุดคีย์ (sort) — เหตุผลเดียวกับด้านบน
      expect([...(updateAudit[0]?.keys ?? [])].sort()).toEqual([
        "code",
        "rule_id",
        "status_from",
        "status_to",
      ]);
      // transition ซ้ำ (active → active) = invalid — 22023 ERR-VAL-001|invalid_transition
      const invalid = await userRpc("admin_update_credit_rule_status", registrarAal2, {
        p_rule_id: id,
        p_status: "active",
        p_request_id: crypto.randomUUID(),
      });
      expect(invalid.status, invalid.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((invalid.json ?? {}) as { code?: string }).code).toBe("22023");
      expect(((invalid.json ?? {}) as { message?: string }).message ?? "").toContain(
        "ERR-VAL-001",
      );
      expect(((invalid.json ?? {}) as { message?: string }).message ?? "").toContain(
        "invalid_transition",
      );
      // audit ไม่เพิ่มจาก transition ที่ถูกปฏิเสธ (atomic — ไม่มี mutation ก็ไม่มี audit)
      const updateAuditAfter = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.audit_logs
         where action = 'CREDIT_RULE_UPDATE' and entity_id::text = '${id}';
      `);
      expect(updateAuditAfter[0]?.n).toBe(1);
    });
  },
);
