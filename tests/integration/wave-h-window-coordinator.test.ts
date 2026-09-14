/**
 * wave-h-window-coordinator.test.ts — พิสูจน์ D89-2 coordinator ครบวงบน dev stack จริง
 * (pre-check → snapshot → ปิด intake cron+mailer → drain → release → restore ตาม snapshot
 * + overlap audit · borrow overlap · lease route-stale purge / direct ห้าม purge)
 * สั่นคล้อง stack จริง (หยุด mailer ชั่วคราว ~10 วิ) — dev-only · battery serial
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { ledgerRead, ledgerWrite, transportAdmit } from "./test-io";

const DB_URL = process.env["TEST_DATABASE_URL"];

async function cronActiveMap(): Promise<Map<number, boolean>> {
  const raw = await psql(
    `select jobid || '|' || case when active then '1' else '0' end from cron.job order by jobid;`,
  );
  const m = new Map<number, boolean>();
  for (const line of raw.trim().split("\n").filter((l) => l.length > 0)) {
    const [id, active] = line.split("|");
    m.set(Number(id), active === "1");
  }
  return m;
}

describe("wave-h window coordinator (D89-2)", { timeout: 180_000 }, () => {
  describe.skipIf(!DB_URL)("บน dev stack จริง", () => {
    // smoke ต้อง deterministic ต่อ state ค้างจากรอบก่อนที่ crash กลางทาง — เคลียร์
    // แบบเห็นชัด (ledger note ทุกครั้งที่เจอของเก่า) แล้วคืม baseline dev:
    // gate open ไม่มี holder · lease ว่าง · cron job ทุกตัว active (baseline dev 8/8
    // active=t) · mailer รัน (start เป็น no-op ถ้ารู้อยู่)
    beforeEach(async () => {
      await ensureWindowInfra();
      const leaseCount = Number((await psql(`select count(*) from test_infra.worker_lease;`)).trim());
      const gate = await gateState();
      if (leaseCount > 0 || !gate.isOpen || gate.holders.length > 0) {
        await ledgerWrite("note", {
          event: "smoke-cleanup-leftover-window-state",
          leaseCount,
          gate: { isOpen: gate.isOpen, holders: gate.holders },
        });
      }
      await psql(`delete from test_infra.worker_lease;
                  update test_infra.worker_gate set is_open = true, holders = '{}', updated_at = now() where id = 1;`);
      await psql(`select cron.alter_job(jobid, active := true) from cron.job where active = false;`);
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        const c = spawn("docker", ["compose", "start", "mailer"], { cwd: process.cwd() });
        c.on("close", () => resolve());
        c.on("error", () => resolve());
      });
    });

    afterEach(async () => {
      // คืน transport window ใน process เสมอ (เทสล้มกลางทางห้ามทิ้ง 'closed' ค้าง)
      const gate = await gateState();
      if (!gate.isOpen) await psql(`update test_infra.worker_gate set is_open = true, holders = '{}', updated_at = now() where id = 1;`);
      if (transportAdmit().ok !== true) {
        const { windowSet } = await import("./test-io");
        await windowSet("open", "smoke-afterEach-failsafe");
      }
    });
    it("ensureWindowInfra idempotent + gate เริ่ม open ไม่มี holder", async () => {
      await ensureWindowInfra();
      await ensureWindowInfra();
      const g = await gateState();
      expect(g.isOpen).toBe(true);
      expect(g.holders).toEqual([]);
    });

    it("วงเต็ม: เปิด window → cron หยุด+mailer หยุด+transport ปฏิเสธ → release → คืนตาม snapshot", async () => {
      const beforeCron = await cronActiveMap();
      const expectedRestore = [...beforeCron.entries()].filter(([, v]) => v).map(([k]) => k);
      const handle = await openIsolatedWindow({ holderId: "smoke-window-1", label: "smoke-window", drain: true });
      // intake ปิดจริง
      const during = await cronActiveMap();
      for (const [id, wasActive] of beforeCron) {
        if (wasActive) expect(during.get(id)).toBe(false); // ทุก job ที่เคย active ต้อง inactive
      }
      const gateDuring = await gateState();
      expect(gateDuring.isOpen).toBe(false);
      expect(gateDuring.holders).toContain("smoke-window-1");
      // transport ใน process ปฏิเสธเพราะ mirror windowSet('closed')
      const admit = transportAdmit();
      expect(admit.ok).toBe(false);
      if (!admit.ok) expect(admit.reason).toBe("window-closed");
      // ledger มี window closed event
      const winEvents = await ledgerRead({ kinds: ["window"] });
      expect(winEvents.some((e) => e.payload["phase"] === "closed" && e.payload["label"] === "smoke-window")).toBe(true);
      // release → restore
      const release = await releaseWindow(handle);
      expect(release.restoredJobs).toBe(expectedRestore.length);
      expect(release.mailerRestored).toBe(true);
      expect(release.overlapRuns).toBe(0); // ไม่มี cron run ใดเริ่มระหว่าง window ปิด
      const afterCron = await cronActiveMap();
      for (const [id, wasActive] of beforeCron) {
        expect(afterCron.get(id)).toBe(wasActive); // คืนตาม snapshot ทุก job
      }
      const gateAfter = await gateState();
      expect(gateAfter.isOpen).toBe(true);
      expect(gateAfter.holders).toEqual([]);
      expect(transportAdmit().ok).toBe(true);
    });

    it("borrow overlap: holder คนที่สองถูกปฏิเสธแบบล้มดัง", async () => {
      const h1 = await openIsolatedWindow({ holderId: "smoke-hold-a", label: "smoke-overlap", drain: false });
      try {
        await expect(
          openIsolatedWindow({ holderId: "smoke-hold-b", label: "smoke-overlap-2", drain: false }),
        ).rejects.toBeInstanceOf(WindowError);
        // gate ยังถือโดย a เพียงคนเดียว (re-borrow a เองก็ไม่ซ้ำใน array)
        const during = await gateState();
        expect(during.holders).toEqual(["smoke-hold-a"]);
      } finally {
        const release = await releaseWindow(h1);
        expect(release.overlapRuns).toBe(0);
      }
      const g = await gateState();
      expect(g.holders).toEqual([]);
      // ledger มี event ปฏิเสธ
      const notes = await ledgerRead({ kinds: ["note"] });
      expect(notes.some((e) => e.payload["event"] === "window-borrow-refused-overlap")).toBe(true);
    });

    it("drainWorkers: direct lease ค้าง = ไม่ drained · ปล่อยแล้ว drained · route เก่า (container restart) ถูก purge เอง", async () => {
      // baseline ต้องสะอาดก่อน (จากเทสก่อนหน้า)
      const base = await inFlightCounts();
      expect(base.directLeases).toBe(0);
      // (1) direct lease ค้าง → drain หมดเวลา (bound สั้นพิเศษ)
      const direct = await acquireLease({ kind: "direct", owner: "smoke-direct-1" });
      const stuck = await drainWorkers({ pollMs: 200, boundMs: 600 });
      expect(stuck.drained).toBe(false);
      expect(stuck.lastCounts.directLeases).toBe(1);
      // (2) ปล่อย → drained
      await releaseLease(direct.leaseId);
      const ok = await drainWorkers({ pollMs: 200, boundMs: 5_000 });
      expect(ok.drained).toBe(true);
      // (3) route lease เก่า: heartbeat เก่ากว่า StartedAt ของ container จริง → auto-purge
      await psql(
        `insert into test_infra.worker_lease (kind, owner, heartbeat_at)
         values ('route', 'ltc-dev-app', now() - interval '30 days');`,
      );
      const purged = await purgeStaleRouteLeases();
      expect(purged).toBe(1);
      const notes = await ledgerRead({ kinds: ["note"] });
      expect(notes.some((e) => e.payload["event"] === "worker-lease-auto-purged-stale-route")).toBe(true);
      // (4) route lease สด (heartbeat ใหม่กว่า StartedAt) ต้องไม่โดน purge
      const fresh = await acquireLease({ kind: "route", owner: "ltc-dev-app" });
      const purged2 = await purgeStaleRouteLeases();
      expect(purged2).toBe(0);
      await releaseLease(fresh.leaseId);
    });
  });
});
