/**
 * 8p — docker CLI ถูก SIGKILL กลาง query: attribution ต้องจับตัวตน backend
 * ได้ (nonce+pid) · การตายต้องนำไปสู่ "การจบแบบมีหลักฐาน" ผ่าน settle engine —
 * claimed evidenced-no-response (ไม่มี response ใดมาถึง) อนุญาตเฉพาะเมื่อ
 * backend ที่ attribution ชี้ "ตายหมดจริง" (scan ก่อน claim เสมอ) · ผ่าน =
 * settle-decision row เดียว (completed-evidenced-no-response + terminalLink)
 * + invocation settled · settle ซ้ำ = ปฏิเสธ (invocation ไม่ใช่ running แล้ว)
 *
 * กลไกจริง (probe 8i · 2026-09-15): SIGKILL CLI "ไม่" ฆ่า backend — psql ใน
 * container รอดและวิ่ง query จนจบ ดังนั้นเส้นทางที่คาดหวังของ scenario นี้คือ
 * terminate มีร่องรอย (explicit-backend-termination) ก่อน settle — ไม่ใช่
 * การหายเอง · สิ่งท้าทายคือ settle engine ต้องยอมรับเฉพาะ backend ที่ scan
 * ยืนยันแล้วว่าไม่มีชีวิต (fabricated-terminal protection)
 *
 * หลักฐาน: (1) CLI exit ≠ 0 · (2) backend หายสุดท้ายเสมอ (เอง หรือ terminate
 * มี ledger — ไม่ปล่อยกำพร้า) · (3) settleHttpWithEvidence settled:true +
 * terminalLink.pids=[pid] · (4) ledger settle-decision 1 row scanClean:true ·
 * (5) invocationState 'settled' · (6) settle ครั้งที่สองโดนปฏิเสธ
 *
 * opKey ต่อ execution (suffix random): invocationState ค้นด้วย opKey เพียงลำพัญ
 * (ไม่ filster run_id) — adhoc รันซ้ำติดกันต้องไม่ชน invocation running ค้าง
 * จากรอบก่อน · semantics อนุกรม (predecessor terminal) ถูกพิสูจน์แบบ deterministic
 * ที่ 8o ไม่ใช่ที่นี่
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../integration/helpers.js";
import {
  attemptBegin,
  currentRunId,
  findBackendByNonce,
  ledgerWrite,
  ledgerRead,
  settleHttpWithEvidence,
  terminateBackend,
} from "../integration/test-io.js";

describe("8p docker CLI SIGKILL — attribution + evidence-based settle", () => {
  it(
    "ฆ่า CLI กลาง pg_sleep → backend หาย → settle evidenced-no-response ด้วย terminalLink จริง",
    async () => {
      const runId = currentRunId();
      const opKey = `barrier:8p-cli-kill:${randomUUID().slice(0, 8)}`;
      const allow = await attemptBegin(opKey, `8p-cli-kill (run ${runId})`);
      expect(allow.ok).toBe(true);

      // scenario-local docker exec psql (ไม่ใช้ startPsqlSession — เราต้อง SIGKILL
      // CLI เองเพื่อพิสูจน์ attribution ของการตายแบบนี้โดยเฉพาะ)
      const nonce = `ltc_cli_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const child: ChildProcessWithoutNullStreams = spawn(
        "docker",
        [
          "compose",
          "exec",
          "-T",
          "db",
          "sh",
          "-c",
          'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=0 -At',
        ],
        { cwd: REPO_ROOT },
      ) as ChildProcessWithoutNullStreams;
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += String(c);
      });
      child.stderr.on("data", (c: Buffer) => {
        process.stderr.write(`[8p-cli ${nonce}] ${String(c)}`);
      });
      child.stdin.write(`set application_name = '${nonce}';\nselect pg_backend_pid();\n`);

      // รอ pid จาก stdout (บรรทัดเดียวที่เป็นตัวเลขล้วน)
      let pid = 0;
      const pidDeadline = Date.now() + 10_000;
      while (Date.now() < pidDeadline) {
        const m = /(?:^|\n)(\d{3,7})(?:\n|$)/.exec(stdout);
        if (m !== null) {
          pid = Number(m[1]);
          if (Number.isFinite(pid) && pid > 0) break;
        }
        await sleep(150);
      }
      expect(pid, `ต้องอ่าน pg_backend_pid ได้จาก stdout (ได้: ${JSON.stringify(stdout.slice(0, 200))})`).toBeGreaterThan(0);

      // ยิง query ยาวแล้วรอให้ขึ้น active จริงก่อนฆ่า
      child.stdin.write("select pg_sleep(30);\n");
      let active = false;
      const activeDeadline = Date.now() + 5_000;
      while (Date.now() < activeDeadline) {
        const f = await findBackendByNonce(nonce, pid);
        if (f.found && f.state === "active") {
          active = true;
          break;
        }
        await sleep(150);
      }
      expect(active, "backend ต้อง active ก่อนถูกฆ่า").toBe(true);

      child.kill("SIGKILL");
      const closeCode = await new Promise<number>((resolve) => {
        child.on("close", (c) => resolve(c ?? -1));
      });
      expect(closeCode, "CLI ที่โดน SIGKILL — exit code ต้องไม่ใช่ 0").not.toBe(0);

      // backend ต้องหายจริงภายใน deadline — ค้างเกิน = terminate แบบมีร่องรอย
      let gone = false;
      const goneDeadline = Date.now() + 10_000;
      while (Date.now() < goneDeadline) {
        const f = await findBackendByNonce(nonce, pid);
        if (!f.found) {
          gone = true;
          break;
        }
        await sleep(200);
      }
      if (!gone) {
        const ok = await terminateBackend(pid);
        await ledgerWrite("note", {
          event: "explicit-backend-termination",
          file: "8p-docker-cli-kill",
          pid,
          nonce,
          terminated: ok,
        });
      }
      expect(
        await findBackendByNonce(nonce, pid).then((f) => f.found),
        "backend ต้องไม่รอดจากการฆ่า CLI (+ terminate ถ้าจำเป็น)",
      ).toBe(false);

      // settle ด้วยหลักฐาน: claimed evidenced-no-response — attribution ชี้ pid
      // ที่ scan ยืนยันแล้วว่าตาย → ผ่าน + terminalLink ผูกตัวตนจริง
      const settle = await settleHttpWithEvidence(opKey, {
        blockerPids: [pid],
        claimed: "evidenced-no-response",
        label: "8p-cli-kill",
      });
      expect(settle.settled).toBe(true);
      expect(settle.decision).toBe("completed-evidenced-no-response");
      expect(settle.terminalLink?.pids).toEqual([pid]);

      // settle-decision row เดียว (scan+การตัดสินคู่กัน) + scanClean
      const decisions = await ledgerRead({ opKey, kinds: ["settle-decision"] });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.payload["decision"]).toBe("completed-evidenced-no-response");
      expect(decisions[0]?.payload["scanClean"]).toBe(true);

      // invocation ปิดเป็น settled จริง
      const st = await (await import("../integration/test-io.js")).invocationState(opKey);
      expect(st?.status).toBe("settled");
      expect(st?.payload["terminalLink"]).toBeDefined();

      // settle ซ้ำ = ปฏิเสธ (invocation ไม่ใช่ running แล้ว — ห้าม double settle)
      let twice: unknown = null;
      try {
        await settleHttpWithEvidence(opKey, {
          blockerPids: [pid],
          claimed: "evidenced-no-response",
          label: "8p-settle-twice-negative",
        });
      } catch (err) {
        twice = err;
      }
      expect(twice).toBeDefined();
      expect(String(twice)).toContain("settle ซ้ำ");
    },
    60_000,
  );
});
