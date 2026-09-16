/**
 * 8i — session ที่ backend ยุ่งอยู่กับ query ยาว ต้องจบได้ "แบบมีขอบเขต"
 * (r24-r28): end() ของ PsqlSession ห้ามค้างรอ query — stdin EOF ไม่ตัด query
 * ที่กำลังรัน ดังนั้น end ต้องมี SIGKILL fallback (killAfterMs) ·
 *
 * กลไกจริงที่พิสูจน์ด้วย probe (D-f-13 · /tmp/8i-probe.mjs 2026-09-15): การ
 * SIGKILL docker CLI "ไม่" ทำให้ daemon ฆ่า psql ใน container — backend มีชีวิต
 * ต่อจน query จบเอง (pg_sleep(30) → หายที่ ~31s) · ดังนั้นสัญญาที่พิสูจน์ได้จริง
 * มีสองชั้น: (ก) end() ฝั่ง client กลับมามีขอบเขตเสมอ (killAfterMs) · (ข) backend
 * ต้องไม่กลายเป็นกำพร้า — ถ้าไม่หายเองภายใน grace ต้องมี terminate แบบมีร่องรอย
 * (ledger explicit-backend-termination) แล้วหายจริง (nonce+pid ผูกตัวตน)
 *
 * หลักฐาน: (1) end ระหว่าง pg_sleep(15) กลับมา < 8s · (2) code ≠ 0 · (3)
 * backend หายสุดท้ายเสมอ (เองหรือโดน terminate มี ledger) · (4) exec ที่ยิงไป
 * reject "timeout" ตาม timeoutMs ของมันเอง · (5) clean session end() === 0
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import {
  findBackendByNonce,
  ledgerWrite,
  startPsqlSession,
  terminateBackend,
} from "../integration/test-io.js";

describe("8i held session end — bounded SIGKILL fallback + no-orphan", () => {
  it(
    "end ระหว่าง pg_sleep(15) มีขอบเขต · backend ไม่กำพร้า (terminate มีร่องรอยถ้าจำเป็น) · exec ค้าง reject timeout",
    async () => {
      const s = await startPsqlSession("8i-held");
      // ยิง query ยาวโดยไม่รอ — exec ของมันจะ reject ที่ timeoutMs 9s เอง
      const fired = s.exec("select pg_sleep(15);", { timeoutMs: 9_000 }).catch(
        (err: unknown) => String(err),
      );

      // รอให้ query ขึ้นสู่ active จริงก่อนตัด (ไม่ตัด session ที่ยังไม่เริ่ม)
      let active = false;
      const activeDeadline = Date.now() + 5_000;
      while (Date.now() < activeDeadline) {
        const f = await findBackendByNonce(s.identity.nonce, s.identity.pid);
        if (f.found && f.state === "active") {
          active = true;
          break;
        }
        await sleep(150);
      }
      expect(active, "backend ต้อง active ก่อนเราจะตัด").toBe(true);

      // (ก) end ฝั่ง client มีขอบเขต — SIGKILL fallback ที่ killAfterMs 4s
      const t0 = Date.now();
      const code = await s.end({ killAfterMs: 4_000 });
      const durMs = Date.now() - t0;
      expect(code, "session ที่ถูก SIGKILL — exit code ต้องไม่ใช่ 0").not.toBe(0);
      expect(durMs, "end ต้องกลับมามีขอบเขต (ไม่รอ pg_sleep 15s จนจบ)").toBeLessThan(8_000);

      // (ข) ไม่กำพร้า — ให้ grace ให้หายเอง (probe: ไม่หายจน query จบ) แล้ว
      // terminate แบบมีร่องรอย + ยืนยันหายจริง
      let goneNaturally = false;
      const graceDeadline = Date.now() + 3_000;
      while (Date.now() < graceDeadline) {
        const f = await findBackendByNonce(s.identity.nonce, s.identity.pid);
        if (!f.found) {
          goneNaturally = true;
          break;
        }
        await sleep(200);
      }
      if (!goneNaturally) {
        const terminated = await terminateBackend(s.identity.pid);
        await ledgerWrite("note", {
          event: "explicit-backend-termination",
          file: "8i-held-session-end",
          pid: s.identity.pid,
          nonce: s.identity.nonce,
          terminated,
        });
        expect(terminated, "terminateBackend ต้องสำเร็จ (backend ค้างเกิน grace)").toBe(true);
      }
      // ยืนยันสุดท้าย: ไม่มี backend ของ nonce นี้เหลือ (poll สั้น — terminate พร้อมตอนคืน)
      let gone = false;
      const goneDeadline = Date.now() + 5_000;
      while (Date.now() < goneDeadline) {
        const f = await findBackendByNonce(s.identity.nonce, s.identity.pid);
        if (!f.found) {
          gone = true;
          break;
        }
        await sleep(200);
      }
      expect(gone, "backend ต้องไม่รอดเป็นกำพร้า").toBe(true);

      // exec ที่ค้างอยู่ reject ตาม timeout ของมันเอง (ห้ามค้างเกี่ยวกับ end)
      const firedResult = await fired;
      expect(firedResult).toContain("timeout");
    },
    60_000,
  );

  it("clean session (idle) — end() คืน exit 0 ทันที (fallback ไม่ฟลุกทางกลับ)", async () => {
    const clean = await startPsqlSession("8i-clean");
    const code = await clean.end();
    expect(code).toBe(0);
  }, 30_000);
});
