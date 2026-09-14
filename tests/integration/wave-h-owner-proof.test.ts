/**
 * wave-h-owner-proof.test.ts — window-owner-proof O1-O18 [#94] (plan §2-D89-4 · r30)
 *
 * พิสูจน์ coordinator/window ครบทุกพฤติกรรมใน 18 ข้อ — รันผ่าน
 * scripts/window-owner-proof.mjs (battery stage "owner-proof") ซึ่งเป็น executor
 * บางๆ ของไฟล์นี้ (single source อยู่ใน TS จริง ไม่ duplicate SQL ใน .mjs)
 *
 * O1  pg_cron extension มีจริง           O10 pause → active job ทุกตัว false
 * O2  cron.job ไม่ว่าง                    O11 mailer หยุดจริง (docker inspect)
 * O3  cron.job_run_details มี+มี row จริง O12 gate DB is_open=false + generation ใหม่
 * O4  gate เริ่ม open ไม่มี holder        O13 drainWorkers บน state สะอาด = drained
 * O5  borrow เพิ่ม holder คนเดียว         O14 direct lease ค้าง → ไม่ drained
 * O6  re-borrow คนเดียวไม่ซ้ำ array       O15 ปล่อยแล้ว drained
 * O7  holder ที่สองปฏิเสธแบบ atomic       O16 route เก่า auto-purge+event · สดไม่โดน
 * O8  refcount=1 serial เปิด/ปิดได้ครบวง  O17 release → restore ทุก job + overlap=0
 * O9  snapshot จับ active set ครบ         O18 หลัง release holders ว่าง+gate open
 *
 * สั่นคล้อง stack จริง (หยุด cron+mailer ชั่วคราว) — dev-only · ต้องรัน serial เท่านั้น
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { psql } from "./helpers";
import {
  acquireLease,
  drainWorkers,
  ensureWindowInfra,
  gateState,
  inFlightCounts,
  openIsolatedWindow,
  purgeStaleRouteLeases,
  releaseLease,
  releaseWindow,
  WindowError,
} from "./window-coordinator";
import { ledgerRead, ledgerWrite } from "./test-io";

const DB_URL = process.env["TEST_DATABASE_URL"];

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args);
    let out = "";
    c.stdout.on("data", (d: Buffer) => {
      out += String(d);
    });
    c.on("error", () => resolve({ code: -1, out: "" }));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

async function cronActiveMap(): Promise<Map<number, boolean>> {
  const raw = await psql(
    `select jobid || '|' || case when active then '1' else '0' end from cron.job order by jobid;`,
  );
  const m = new Map<number, boolean>();
  for (const line of raw.trim().split("\n").filter((l) => l.length > 0)) {
    const [id, a] = line.split("|");
    m.set(Number(id), a === "1");
  }
  return m;
}

describe("window-owner-proof O1-O18 (D89-2/D89-4)", { timeout: 300_000 }, () => {
  describe.skipIf(!DB_URL)("บน dev stack จริง (serial เท่านั้น)", () => {
    beforeEach(async () => {
      await ensureWindowInfra();
      const leaseCount = Number((await psql(`select count(*) from test_infra.worker_lease;`)).trim());
      const gate = await gateState();
      if (leaseCount > 0 || !gate.isOpen || gate.holders.length > 0) {
        await ledgerWrite("note", { event: "owner-proof-cleanup-leftover", leaseCount, gate });
      }
      await psql(`delete from test_infra.worker_lease;
                  update test_infra.worker_gate set is_open = true, holders = '{}', updated_at = now() where id = 1;`);
      await psql(`select cron.alter_job(jobid, active := true) from cron.job where active = false;`);
      await sh("docker", ["compose", "start", "mailer"]);
    });

    afterEach(async () => {
      const gate = await gateState();
      if (!gate.isOpen) {
        await psql(`update test_infra.worker_gate set is_open = true, holders = '{}', updated_at = now() where id = 1;`);
      }
      await sh("docker", ["compose", "start", "mailer"]);
    });

    it("O1-O3 pre-check ของจริง: pg_cron · cron.job · job_run_details มี row", async () => {
      const ext = (await psql(`select count(*) from pg_extension where extname = 'pg_cron';`)).trim();
      expect(ext, "O1 pg_cron extension").toBe("1");
      const jobs = Number((await psql(`select count(*) from cron.job;`)).trim());
      expect(jobs, "O2 cron.job ไม่ว่าง").toBeGreaterThan(0);
      const jrd = (
        await psql(
          `select count(*) from information_schema.tables where table_schema = 'cron' and table_name = 'job_run_details';`,
        )
      ).trim();
      expect(jrd, "O3 job_run_details มี").toBe("1");
      const recent = Number(
        (await psql(`select count(*) from cron.job_run_details where start_time > now() - interval '15 minutes';`)).trim(),
      );
      expect(recent, "O3 job_run_details บันทึกจริง (มี row 15 นาทีล่าสุด)").toBeGreaterThan(0);
    });

    it("O4-O8 borrow/refcount: เดี่ยวได้ · re-borrow ไม่ซ้ำ · คนที่สองล้ม · วงครบ", async () => {
      const g0 = await gateState();
      expect(g0.isOpen, "O4 gate open").toBe(true);
      expect(g0.holders, "O4 ไม่มี holder").toEqual([]);
      // O5+O6+O8(ครึ่งแรก): เปิดด้วย holder เดียว แล้ว re-open คนเดียวกัน
      const h = await openIsolatedWindow({ holderId: "op-h", label: "O5-open", drain: false });
      const g1 = await gateState();
      expect(g1.holders, "O5 holder เพิ่มคนเดียว").toEqual(["op-h"]);
      // re-borrow คนเดียวกัน (เปิดอีกครั้งใน name เดิม — ต้องไม่ซ้ำใน array) — เรียกตอน
      // window ยังถืออยู่: pre-check ผ่าน borrow ได้เพราะ 'op-h' = any(holders)
      const h2 = await openIsolatedWindow({ holderId: "op-h", label: "O6-reborrow", drain: false });
      const g2 = await gateState();
      expect(g2.holders, "O6 re-borrow ไม่ซ้ำ array").toEqual(["op-h"]);
      // O7: holder คนอื่น = ปฏิเสธก่อนแตะอะไรอื่น
      await expect(
        openIsolatedWindow({ holderId: "op-x", label: "O7-overlap", drain: false }),
      ).rejects.toBeInstanceOf(WindowError);
      const g3 = await gateState();
      expect(g3.holders, "O7 holders ไม่เปลี่ยนหลังปฏิเสธ").toEqual(["op-h"]);
      // ปิดวง O8: release ครั้งเดียวเก็บทุก borrow ของคนเดียวกัน (refcount กลับศูนย์)
      const rel = await releaseWindow(h);
      expect(rel.overlapRuns).toBe(0);
      const g4 = await gateState();
      expect(g4.holders, "O8 release ครั้งเดียวคืน refcount").toEqual([]);
      expect(g4.isOpen, "O8 gate เปิดคืน").toBe(true);
      // release ซ้ำของ borrow ครั้งที่สองต้องไม่พัง (array_remove ไม่เจอ = no-op)
      await releaseWindow(h2);
      const g5 = await gateState();
      expect(g5.holders, "O8 release ซ้ำ no-op").toEqual([]);
    });

    it("O13-O16 drainWorkers + worker_lease", async () => {
      const clean = await drainWorkers({ pollMs: 200, boundMs: 5_000 });
      expect(clean.drained, "O13 state สะอาด drained จริง").toBe(true);
      const d = await acquireLease({ kind: "direct", owner: "op-direct" });
      const stuck = await drainWorkers({ pollMs: 200, boundMs: 600 });
      expect(stuck.drained, "O14 direct ค้างไม่ drained").toBe(false);
      expect(stuck.lastCounts.directLeases).toBe(1);
      await releaseLease(d.leaseId);
      const ok = await drainWorkers({ pollMs: 200, boundMs: 5_000 });
      expect(ok.drained, "O15 ปล่อยแล้ว drained").toBe(true);
      // O16: route เก่า (heartbeat เก่ากว่า StartedAt ของ container จริง) = purge+event
      await psql(
        `insert into test_infra.worker_lease (kind, owner, heartbeat_at)
         values ('route', 'ltc-dev-app', now() - interval '30 days');`,
      );
      expect(await purgeStaleRouteLeases(), "O16 route เก่าถูก purge").toBe(1);
      const notes = await ledgerRead({ kinds: ["note"] });
      expect(
        notes.some((e) => e.payload["event"] === "worker-lease-auto-purged-stale-route"),
        "O16 ledger event",
      ).toBe(true);
      const fresh = await acquireLease({ kind: "route", owner: "ltc-dev-app" });
      expect(await purgeStaleRouteLeases(), "O16 route สดไม่โดน purge").toBe(0);
      await releaseLease(fresh.leaseId);
    });

    it("O9-O12 + O17-O18 วงเต็มพร้อม drain: snapshot · pause · mailer · gate · restore", async () => {
      const before = await cronActiveMap();
      expect([...before.values()].every((v) => v), "O9 baseline ทุก job active").toBe(true);
      const handle = await openIsolatedWindow({ holderId: "op-full", label: "O9-full", drain: true });
      // O10: job ที่ snapshot บอก active ต้อง false ทั้งหมดตอน window ปิด
      const during = await cronActiveMap();
      for (const [id, wasActive] of before) {
        if (wasActive) {
          expect(during.get(id), `O10 job ${id} หยุด`).toBe(false);
        }
      }
      // O11: mailer หยุดจริง
      const mailer = await sh("docker", ["inspect", "--format", "{{.State.Running}}", "ltc-dev-mailer"]);
      expect(mailer.out.trim(), "O11 mailer หยุด").toBe("false");
      // O12: gate DB ปิด + generation ใหม่
      const gate = await gateState();
      expect(gate.isOpen, "O12 gate closed").toBe(false);
      expect(gate.generation, "O12 generation ใหม่").toBe(handle.generation);
      // O17: release → restore ทุก job ตาม snapshot + overlap = 0
      const rel = await releaseWindow(handle);
      expect(rel.overlapRuns, "O17 overlap audit = 0").toBe(0);
      expect(rel.restoredJobs, "O17 restore ทุก active job").toBe([...before.values()].filter((v) => v).length);
      const after = await cronActiveMap();
      for (const [id, wasActive] of before) {
        expect(after.get(id), `O17 job ${id} คืนตาม snapshot`).toBe(wasActive);
      }
      expect(rel.mailerRestored, "O17 mailer คืน").toBe(true);
      // O18: คืนสะอาด
      const gEnd = await gateState();
      expect(gEnd.holders, "O18 holders ว่าง").toEqual([]);
      expect(gEnd.isOpen, "O18 gate open").toBe(true);
      expect((await inFlightCounts()).directLeases, "O18 lease สะอาด").toBe(0);
    });
  });
});
