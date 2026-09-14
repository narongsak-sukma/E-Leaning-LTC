/**
 * wave-h-cleanup-fk-proof.test.ts — พิสูจน์ D89-1 builder ครบทุกนโยบาย [#94]
 * (plan §2-D89-1/D89-2 ชั้นที่ 2 · §2-D89-4 S/AF/FR — แผน r30 APPROVED)
 *
 * S (drift/schema): inventory ตรง catalog จริง must-equal (FK→profiles ครบ ·
 *   topo leaf-first ครบทุกเส้น FK ของตาราง owned · trigger append-only ครบ ·
 *   pre-guard assertCleanupAllowedVia ผ่านบน schema สด · ลำดับ ledger-ก่อน-certificates
 *   อยู่ใน SQL จริง — regression สองทิศของบั๊ก r6:2311)
 * AF (assert-fail): NOT NULL actor (question_banks.created_by) ค้าง = RAISE
 *   CLEANUP-POSTGUARD table.column=count + rollback ทั้ง TX (ผู้ใช้ยังอยู่ครบ)
 *   → เคลียร์แถวนั้นแล้วรันใหม่ = ผ่าน
 * FR (fixture/retry): SRE NOWAIT 55P03 โดนถือ lock ข้าม TX อื่น = retry ×3 jitter
 *   แล้วล้มดัง · ปล่อย lock แล้วรันใหม่ = ผ่าน · idempotent รันซ้ำ = ผ่าน
 *
 * โลกทดสอบสร้างด้วย SQL ตรง (auth.users → handle_new_user สร้าง profiles+role
 * citizen ให้ — พิสูจน์ insert ทุกตารางผ่านจริงก่อนเขียนเทส) · dev-only serial
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { psql } from "./helpers";
import {
  APPEND_ONLY_KEEP,
  APPEND_ONLY_TRIGGER,
  assertCleanupAllowedVia,
  buildUserCleanupSql,
  CLEANUP_INVENTORY,
  runUserCleanupVia,
} from "./cleanup-builder";
import { ledgerWrite, startPsqlSession } from "./test-io";
import { openIsolatedWindow, releaseWindow, type WindowHandle } from "./window-coordinator";

const DB_URL = process.env["TEST_DATABASE_URL"];

/** สร้างโลกผู้ใช้เต็มสาย (ทุกนโยบาย) ด้วย SQL ตรง — คืน { id, verifyCode, tag } */
async function insertFkWorld(id: string, tag: string): Promise<{ verifyCode: string }> {
  const verifyCode = `WAVEHFKVC-${tag}`;
  await psql(`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    values ('${id}', 'wave-h-fk-${tag}@ltc.test', 'probe-only', now(), '{}'::jsonb, '{"display_name":"fk-proof"}'::jsonb);
    insert into public.enrollments (user_id, course_id)
      values ('${id}', '44444444-4444-4444-8444-000000000001');
    insert into public.renewal_cycles (user_id, cycle_no, starts_on, ends_on, required_credits)
      values ('${id}', 1, current_date, current_date + 365, '{"total":1}'::jsonb);
    insert into public.certificates (cert_no, verify_code, enrollment_id, user_id, course_id, holder_name_snapshot, course_title_snapshot, issued_by)
      select 'WAVEHFK-${tag}', '${verifyCode}', e.id, e.user_id, e.course_id, 'fk-proof', 'fk-proof', '11111111-1111-4111-8111-000000000001'
      from public.enrollments e where e.user_id = '${id}';
    insert into public.credit_ledger_entries (user_id, renewal_cycle_id, entry_type, amount, certificate_id)
      select user_id, id, 'accrual', 1, (select c.id from public.certificates c where c.verify_code = '${verifyCode}')
      from public.renewal_cycles where user_id = '${id}';
    insert into public.certificate_verifications (verify_code, result, ip_hash)
      values ('${verifyCode}', 'valid', 'fk-proof');
    insert into public.notifications (topic, title, body) values ('system', 'WAVEHFK-${tag}', 'fk-proof');
    insert into public.notification_recipients (notification_id, user_id, channel)
      select id, '${id}', 'in_app' from public.notifications where title = 'WAVEHFK-${tag}' limit 1;
    insert into public.consents (user_id, consent_type, action, policy_version, source)
      values ('${id}', 'pdpa_essential', 'grant', 'v1', 'register');
    insert into public.security_events (event_type, ip_hash, target_user_id)
      values ('login_fail', 'fk-proof', '${id}');
    insert into public.notice_acknowledgments (user_id, notice_key, version)
      values ('${id}', 'WAVEHFK-notice-${tag}', 'v1');
    insert into public.email_outbox (to_email, template_key, recipient_user_id)
      values ('wave-h-fk-${tag}@ltc.test', 'fk-proof', '${id}');
    insert into public.report_exports (requested_by, report_type) values ('${id}', 'fk-proof');
    insert into public.data_export_jobs (user_id) values ('${id}');
    insert into public.media_assets (provider, media_type, bucket, storage_path, mime_type, size_bytes, uploaded_by)
      values ('supabase_storage', 'document', 'pdpa-exports', 'pdpa-exports/${id}/${randomUUID()}.json',
              'application/json', 1, '${id}');
    insert into public.event_outbox (topic, payload)
      values ('credit.accrual', jsonb_build_object('user_id', '${id}'));
  `);
  return { verifyCode };
}

async function note(event: string, payload: Record<string, unknown>): Promise<void> {
  await ledgerWrite("note", { event, ...payload }, { opKey: "wave-h-cleanup" });
}

function runCleanup(ids: readonly string[]): Promise<{ attempts: number; retriedOn: readonly string[] }> {
  return runUserCleanupVia(psql, ids, { note, jitter: () => 0.1 });
}

async function scalar(sql: string): Promise<string> {
  return (await psql(sql)).trim();
}

describe("wave-h cleanup-fk-proof (D89-1)", { timeout: 240_000 }, () => {
  describe.skipIf(!DB_URL)("บน dev stack จริง", () => {
    // ทั้งไฟล์รันใน isolated window (D89-2): cron PDPA-export worker เก็บ
    // data_export_jobs 'queued' ของโลกทดสอบแล้วเขียน media_assets กลางเทส
    // (จับจริงรอบแรก: uploaded_by=<ผู้ใช้ทดสอบ> โผล่ระหว่าง cleanup) — ปิด intake
    // ตลอดไฟล์กัน worker แข่งกับ TX ของเทส
    let handle: WindowHandle;
    beforeAll(async () => {
      handle = await openIsolatedWindow({ holderId: "fk-proof", label: "wave-h-cleanup-fk-proof", drain: true });
    });
    afterAll(async () => {
      if (handle !== undefined) await releaseWindow(handle);
    });

    beforeEach(async () => {
      // เคลียร์ของค้างจากรอบที่พังกลางทาง — ครั้งแรกอาจล้มถ้ามีแถว ASSERT-FAIL ค้าง
      // (question_banks ของ AF) → ลบแถวนั้นก่อนแล้วเคลียร์ผู้ใช้ให้สะอาดจริง
      const leftovers = (await psql(`select id::text from auth.users where email like 'wave-h-fk-%';`))
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      if (leftovers.length > 0) {
        await note("fk-proof-cleanup-leftover", { count: leftovers.length });
        const swept = await runCleanup(leftovers).then(
          () => false,
          async () => {
            await psql(`delete from public.question_banks where code like 'WAVEHFK-%';`);
            return true;
          },
        );
        if (swept) await runCleanup(leftovers);
      }
      await psql(`delete from public.question_banks where code like 'WAVEHFK-%';
                  delete from public.notifications where title like 'WAVEHFK-%';`);
    });

    // ─── S: drift กับ catalog จริง (guard ชั้น 1) ────────────────────────────

    it("S1 pre-guard ผ่านบน schema สด (inventory ตรงจริงทุก column)", async () => {
      await expect(assertCleanupAllowedVia(psql)).resolves.toBeUndefined();
    });

    it("S2 FK→profiles ครบ must-equal: ทุก (table,column) ของ catalog ต้องมีใน inventory", async () => {
      const raw = await psql(`
        select conrelid::regclass::text || '|' || (
          select string_agg(a.attname, ',' order by a.attnum) from unnest(conkey) k
          join pg_attribute a on a.attrelid = conrelid and a.attnum = k)
        from pg_constraint
        where contype = 'f' and confrelid = 'public.profiles'::regclass
        order by 1;`);
      const edges = raw.trim().split("\n").filter((l) => l.length > 0);
      expect(edges.length).toBeGreaterThan(10);
      const keys = new Set(CLEANUP_INVENTORY.map((e) => `${e.table}.${e.column}`));
      const missing: string[] = [];
      for (const line of edges) {
        const [table, cols] = line.split("|");
        // ตาราง append-only ที่ตั้งใจคงไว้ไม่เคลียร์ผู้ใช้ (audit_logs ไม่มี FK→profiles — เช็คจริง)
        if (APPEND_ONLY_KEEP.includes(table ?? "")) continue;
        for (const col of (cols ?? "").split(",")) {
          if (!keys.has(`${table}.${col}`)) missing.push(`${table}.${col}`);
        }
      }
      if (missing.length > 0) {
        throw new Error(`inventory ขาด FK→profiles: ${missing.join(", ")} (drift — เพิ่มนโยบาย)`);
      }
    });

    it("S3 topo leaf-first: ทุกเส้น FK ระหว่างตาราง owned ลูกต้องมาก่อนแม่ + ไม่มีตารางนอก inventory ชี้เข้า owned", async () => {
      const ownedTables = [...new Set(CLEANUP_INVENTORY.filter((e) => e.policy === "OWNED-DELETE").map((e) => e.table))];
      const firstOwnedIdx = new Map<string, number>();
      CLEANUP_INVENTORY.forEach((e, i) => {
        if (e.policy === "OWNED-DELETE" && !firstOwnedIdx.has(e.table)) firstOwnedIdx.set(e.table, i);
      });
      // ตารางนอก inventory ที่ชี้ FK เข้า owned รั่วเฉพาะเมื่อมัน "มีแถวของผู้ใช้" =
      // มี FK→profiles ด้วย (เช่น attempt_answers ไม่มี user_id ตรงแต่แถวเป็นของผู้ใช้)
      // ตาราง content ล้วน (lessons ไม่มี user column) = ไม่มีทางรั่ว — ผ่านได้
      // ตารางนอก inventory ที่ชี้ FK เข้า owned รั่วเฉพาะเมื่อมัน "มีแถวของผู้ใช้" =
      // มี FK→profiles ด้วย และไม่มีนโยบายใดใน inventory เลย (ASSERT-FAIL เช่น courses
      // = suite-owned จัดการเอง — จับตอน post-guard/FK ล้มดัง) · ตาราง content ล้วน
      // (lessons ไม่มี user column) = ไม่มีทางรั่ว
      const inventoryTables = [...new Set(CLEANUP_INVENTORY.map((e) => e.table))];
      const raw = await psql(`
        select c.conrelid::regclass::text || '->' || c.confrelid::regclass::text
        from pg_constraint c
        where c.contype = 'f'
          and c.conrelid::regclass::text not in (${[...APPEND_ONLY_KEEP, ...inventoryTables].map((t) => `'${t}'`).join(",")})
          and c.confrelid::regclass::text in (${ownedTables.map((t) => `'${t}'`).join(",")})
          and exists (
            select 1 from pg_constraint p
            where p.contype = 'f' and p.conrelid = c.conrelid
              and p.confrelid = 'public.profiles'::regclass
          );`);
      const outside = raw.trim().split("\n").filter((l) => l.length > 0);
      if (outside.length > 0) {
        throw new Error(`ตารางนอก inventory ชี้ FK เข้าตาราง owned (แถวผู้ใช้จะค้าง): ${outside.join(", ")}`);
      }
      const both = await psql(`
        select conrelid::regclass::text || '->' || confrelid::regclass::text
        from pg_constraint
        where contype = 'f'
          and conrelid::regclass::text in (${ownedTables.map((t) => `'${t}'`).join(",")})
          and confrelid::regclass::text in (${ownedTables.map((t) => `'${t}'`).join(",")});`);
      for (const line of both.trim().split("\n").filter((l) => l.length > 0)) {
        const [child, parent] = line.split("->");
        if (child === parent) continue; // self-FK (certificates supersedes) ลบใน statement เดียว + nullify ก่อน
        const ci = firstOwnedIdx.get(child ?? "");
        const pi = firstOwnedIdx.get(parent ?? "");
        if (ci === undefined || pi === undefined) continue;
        if (ci >= pi) {
          throw new Error(`ลำดับผิด: ${child} (idx ${ci}) ต้องลบก่อน ${parent} (idx ${pi})`);
        }
      }
    });

    it("S4 trigger append-only must-equal: ตาราง owned ที่ DELETE โดนบล็อก = ตัวที่ toggle พอดี", async () => {
      const ownedTables = new Set(CLEANUP_INVENTORY.filter((e) => e.policy === "OWNED-DELETE").map((e) => e.table));
      const raw = await psql(`
        select distinct c.relname
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and n.nspname = 'public'
          and pg_get_triggerdef(t.oid) like '%BEFORE DELETE%';`);
      const blocking = new Set(
        raw.trim().split("\n").filter((l) => l.length > 0).filter((t) => ownedTables.has(t)),
      );
      const toggled = new Set([...APPEND_ONLY_TRIGGER.keys()].filter((t) => ownedTables.has(t)));
      if (blocking.size !== toggled.size || [...blocking].some((t) => !toggled.has(t))) {
        throw new Error(
          `drift trigger append-only: บล็อกจริง=[${[...blocking]}] toggle=[${[...toggled]}] ต้องเท่ากัน`,
        );
      }
    });

    it("S5 SQL จริงเรียง credit_ledger_entries ก่อน certificates (r6:2311) + post-guard ครบ", () => {
      const { sql, deleteOrder } = buildUserCleanupSql(["00000000-0000-0000-0000-000000000009"]);
      const ledgerAt = sql.indexOf("delete from public.credit_ledger_entries");
      const certAt = sql.indexOf("delete from public.certificates ");
      if (ledgerAt < 0 || certAt < 0 || ledgerAt > certAt) {
        throw new Error("SQL สร้างเรียง ledger หลัง certificates — regression r6:2311");
      }
      expect(sql).toContain("lock table public.certificates in share row exclusive mode nowait;");
      expect(sql).toContain("raise exception 'CLEANUP-POSTGUARD question_banks.created_by=%'");
      expect(sql).toContain("disable trigger trg_append_only_rows");
      expect(sql).toContain("enable trigger trg_append_only_rows");
      expect(sql.trim().endsWith("commit;")).toBe(true);
      expect(deleteOrder.indexOf("credit_ledger_entries.user_id")).toBeLessThan(
        deleteOrder.indexOf("certificates.user_id"),
      );
    });

    // ─── S: ประหยัดจริง + idempotent ─────────────────────────────────────────

    it("S6 cleanup โลกเต็มสาย: ทุกตาราง 0 แถว + profiles/auth.users หาย + append-only toggle ทำงาน + idempotent", async () => {
      const id = randomUUID();
      const { verifyCode } = await insertFkWorld(id, id.slice(0, 8));
      // มีของจริงก่อนลบ (กัน fake pass)
      expect(await scalar(`select count(*) from public.certificates where user_id = '${id}';`)).toBe("1");
      expect(await scalar(`select count(*) from public.credit_ledger_entries where user_id = '${id}';`)).toBe("1");
      expect(await scalar(`select count(*) from public.consents where user_id = '${id}';`)).toBe("1");
      expect(await scalar(`select count(*) from public.event_outbox where payload->>'user_id' = '${id}';`)).toBe("1");
      const first = await runCleanup([id]);
      expect(first.attempts).toBe(1);
      expect(first.retriedOn).toEqual([]);
      // ทุกตาราง 0 + เจ้าของหาย
      const checks: Array<[string, string]> = [
        ["public.profiles", `id = '${id}'`],
        ["auth.users", `id = '${id}'`],
        ["public.certificates", `user_id = '${id}'`],
        ["public.credit_ledger_entries", `user_id = '${id}'`], // toggle trigger ไม่บล็อก delete
        ["public.certificate_verifications", `verify_code = '${verifyCode}'`], // SOLE-LINK
        ["public.renewal_cycles", `user_id = '${id}'`],
        ["public.enrollments", `user_id = '${id}'`],
        ["public.notification_recipients", `user_id = '${id}'`],
        ["public.consents", `user_id = '${id}'`],
        ["public.security_events", `target_user_id = '${id}'`],
        ["public.notice_acknowledgments", `user_id = '${id}'`],
        ["public.email_outbox", `recipient_user_id = '${id}'`],
        ["public.report_exports", `requested_by = '${id}'`],
        ["public.data_export_jobs", `user_id = '${id}'`],
        ["public.media_assets", `uploaded_by = '${id}'`],
        ["public.event_outbox", `payload->>'user_id' = '${id}'`],
      ];
      for (const [table, where] of checks) {
        expect(await scalar(`select count(*) from ${table} where ${where};`), `${table} ต้องว่าง`).toBe("0");
      }
      // ผู้ออกใบประาก (seed) ไม่โดนลบ
      expect(await scalar(`select count(*) from public.profiles where id = '11111111-1111-4111-8111-000000000001';`)).toBe("1");
      // idempotent: รันซ้ำ = ผ่าน (delete 0 แถว + guard 0)
      const again = await runCleanup([id]);
      expect(again.attempts).toBe(1);
    });

    // ─── AF: assert-fail + rollback ทั้ง TX ─────────────────────────────────

    it("AF1 NOT NULL actor ค้าง (question_banks.created_by) = RAISE + rollback + เคลียร์แล้วผ่าน", async () => {
      const id = randomUUID();
      const tag = id.slice(0, 8);
      await insertFkWorld(id, tag);
      await psql(`
        insert into public.question_banks (code, name, created_by)
        values ('WAVEHFK-QB-${tag}', 'fk-proof-af', '${id}');`);
      await expect(runCleanup([id])).rejects.toThrow(/CLEANUP-POSTGUARD question_banks\.created_by=1/);
      // rollback ทั้ง TX: ผู้ใช้ + โลกยังอยู่ครบ (ลบทีเดียวท้าย TX ไม่มีของหายก่อน)
      expect(await scalar(`select count(*) from public.profiles where id = '${id}';`)).toBe("1");
      expect(await scalar(`select count(*) from public.certificates where user_id = '${id}';`)).toBe("1");
      expect(await scalar(`select count(*) from public.consents where user_id = '${id}';`)).toBe("1");
      // suite เคลียร์แถวนั้นเอง (policy: ASSERT-FAIL = จัดการเอง) แล้วรันใหม่ = ผ่าน
      await psql(`delete from public.question_banks where code = 'WAVEHFK-QB-${tag}';`);
      await expect(runCleanup([id])).resolves.toMatchObject({ attempts: 1 });
      expect(await scalar(`select count(*) from public.profiles where id = '${id}';`)).toBe("0");
    });

    // ─── FR: 55P03 NOWAIT retry ──────────────────────────────────────────────

    it("FR1 SRE ถือโดย TX อื่น = NOWAIT 55P03 → retry ×3 → ล้มดัง · ปล่อยแล้วผ่าน", async () => {
      const session = await startPsqlSession("fk-proof-lock-holder");
      try {
        await session.exec("begin;");
        await session.exec("lock table public.consents in share row exclusive mode;");
        const ghost = randomUUID(); // ผู้ใช้ไม่มีก็ต้องเจอ lock-path เหมือนกัน (idempotent path)
        const err = await runCleanup([ghost]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/could not obtain lock on relation/i);
        const props = err as unknown as { attempts?: number; retriedOn?: readonly string[] };
        expect(props.attempts).toBe(4);
        expect(props.retriedOn).toEqual(["55P03", "55P03", "55P03"]);
        await session.exec("rollback;");
      } finally {
        await session.exec("rollback;");
        await session.end();
      }
      const ok = await runCleanup([randomUUID()]);
      expect(ok.attempts).toBe(1);
    });
  });
});
