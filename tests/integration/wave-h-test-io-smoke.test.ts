/**
 * wave-h-test-io-smoke.test.ts — พิสูจน์เครื่องยนต์กลาง D89-3 กับ dev stack จริง
 * (ledger roundtrip · attemptBegin guard ทุกสถานะ · session identity · httpWrite
 * settle ตาม provenance · sqlWrite normal) — ส่วนหนึ่งของ battery ปกติ ไม่ใช่ไฟล์ทิ้ง
 */
import { describe, expect, it } from "vitest";
import {
  accessLogFence,
  attemptBegin,
  buildTouchSet,
  captureLogCursor,
  createTrackedClient,
  deriveOpKey,
  ensureTestInfra,
  findBackendByNonce,
  GuardRefusedError,
  httpWrite,
  invocationClose,
  invocationState,
  ledgerRead,
  ledgerWrite,
  manifestByOpKey,
  manualClearPoison,
  normalizePathForLog,
  sqlWrite,
  startPsqlSession,
} from "./test-io";

const DB_URL = process.env["TEST_DATABASE_URL"];

describe("wave-h test-io engine (D89-3)", { timeout: 120_000 }, () => {
  describe.skipIf(!DB_URL)("บน dev stack จริง", () => {
    it("ensureTestInfra idempotent + ledger roundtrip", async () => {
      await ensureTestInfra();
      await ensureTestInfra();
      const id = await ledgerWrite("note", { event: "smoke", n: 1 }, { opKey: "smoke-op" });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const rows = await ledgerRead({ kinds: ["note"], opKey: "smoke-op" });
      expect(rows.some((r) => r.id === id && (r.payload["n"] as number) === 1)).toBe(true);
    });

    it("attemptBegin guard: running ปฏิเสธ · settled อนุญาต · poisoned ปฏิเสธต่อ", async () => {
      const opKey = `smoke-guard-${Date.now()}`;
      const a = await attemptBegin(opKey, "attempt-1");
      expect(a.ok).toBe(true);
      await expect(attemptBegin(opKey, "attempt-2-too-soon")).rejects.toBeInstanceOf(GuardRefusedError);
      // ledger มี guard-event ปฏิเสธ + invocation N ยัง running (fixture ง จะ assert เต็มใน barrier-proof)
      const guardEvents = await ledgerRead({ kinds: ["guard-event"], opKey });
      expect(
        guardEvents.some((e) => e.payload["event"] === "lifecycle-guard-refused-live-predecessor"),
      ).toBe(true);
      expect((await invocationState(opKey))?.status).toBe("running");
      // settled → อนุญาตใหม่
      await invocationClose(a.invocationId, opKey, "settled", { class: "smoke" });
      const b = await attemptBegin(opKey, "attempt-2");
      expect(b.ok).toBe(true);
      // poisoned → ยังปฏิเสธ (เคลียร์มือก่อน — limitation 5)
      await invocationClose(b.invocationId, opKey, "poisoned", { reason: "smoke" });
      await expect(attemptBegin(opKey, "attempt-3-poison")).rejects.toBeInstanceOf(GuardRefusedError);
      // เคลียร์มือด้วย intent → อนุญาตใหม่
      await manualClearPoison(opKey, "smoke-manual-clear");
      const c = await attemptBegin(opKey, "attempt-4-after-clear");
      expect(c.ok).toBe(true);
    });

    it("session identity: nonce+pid+backend_start + end()", async () => {
      const s = await startPsqlSession("smoke-session");
      expect(s.identity.nonce).toMatch(/^ltc_test_[0-9a-f]+$/);
      expect(s.identity.pid).toBeGreaterThan(0);
      const found = await findBackendByNonce(s.identity.nonce, s.identity.pid);
      expect(found.found).toBe(true);
      // ระหว่างคำสั่ง backend เป็น idle · ระหว่าง exec เท่านั้นที่ active — รับทั้งสอง
      expect(["idle", "active"]).toContain(found.state);
      const one = await s.exec("select 41+1;");
      expect(one.trim()).toBe("42");
      const code = await s.end();
      expect(code).toBe(0);
    });

    it("httpWrite kong-path 404 → confirmed-404 + binding/ua_nonce ลง ledger", async () => {
      const anonKey = process.env["TEST_SUPABASE_ANON_KEY"];
      const res = await httpWrite("POST", "/rest/v1/rpc/nonexistent_fn_smoke", {}, {
        transportTarget: "kong-path",
        label: "smoke-http-404",
        ...(anonKey !== undefined ? { apiKey: anonKey } : {}),
      });
      expect(res.status).toBe(404);
      expect(res.settledAs).toBe("confirmed-404");
      expect(res.uaNonce).toMatch(/^ltc-inv-[0-9a-f-]{36}$/);
      const rows = await ledgerRead({ kinds: ["invocation"], opKey: res.opKey, invocationId: res.invocationId });
      const running = rows.find((r) => r.payload["status"] === "running");
      const settled = rows.find((r) => r.payload["status"] === "settled");
      expect(running?.payload["binding"]).toMatchObject({
        opKey: "rpc:nonexistent_fn_smoke:POST",
        uaNonce: res.uaNonce,
      });
      expect(settled?.payload["class"]).toBe("confirmed-404");
    });

    it("access-log fence: จับ line จริงของ dispatch ตัวเองหนึ่งต่อหนึ่ง", async () => {
      const cursor = await captureLogCursor();
      const anonKey2 = process.env["TEST_SUPABASE_ANON_KEY"];
      const res = await httpWrite("POST", "/rest/v1/rpc/nonexistent_fn_fence", {}, {
        transportTarget: "kong-path",
        label: "smoke-fence",
        ...(anonKey2 !== undefined ? { apiKey: anonKey2 } : {}),
      });
      expect(res.status).toBe(404);
      // line แรกหลัง restart อาจช้า (step-2 flake) — poll สั้นๆ ภายใน 5 วิ
      let matches = 0;
      for (let i = 0; i < 10 && matches === 0; i++) {
        const fence = await accessLogFence(cursor, {
          uaNonce: res.uaNonce,
          method: "POST",
          pathNorm: "/rpc/nonexistent_fn_fence",
          status: 404,
        });
        matches = fence.matches;
        if (matches === 0) await new Promise((r) => setTimeout(r, 500));
      }
      expect(matches).toBe(1);
    });

    it("sqlWrite normal → completed + invocation settled", async () => {
      const res = await sqlWrite(
        `create table if not exists test_infra.smoke_scratch (id int primary key, note text);
         insert into test_infra.smoke_scratch values (1, 'smoke') on conflict do nothing;`,
        { opKey: "smoke-sql-normal", label: "smoke-sql" },
      );
      expect(res.exitCode).toBe(0);
      expect(res.settled).toBe("completed");
      const state = await invocationState("smoke-sql-normal");
      expect(state?.status).toBe("settled");
    });

    it("trackedClient: nonce ต่อ dispatch + classification + attempt rows ผูก parent_call_key", async () => {
      const { client, parentCallKey } = createTrackedClient({ label: "smoke-sdk" });
      // read: select บนตารางจริงผ่าน anon (RLS ปล่อยแถว public หรือ 0 แถวก็ได้ — สนใจแค่ผ่าน transport)
      const sel = await client.from("courses").select("id").limit(1);
      expect(sel.error).toBeNull();
      // write: rpc ไม่รู้จัก (404) — classification = write (default-deny)
      const rpc = await client.rpc("nonexistent_fn_sdk_smoke", {});
      expect(rpc.error).not.toBeNull();
      const attempts = await ledgerRead({ kinds: ["attempt"] });
      const sdkAttempts = attempts.filter(
        (a) => a.payload["parentCallKey"] === parentCallKey && a.payload["transport"] === "sdk",
      );
      // dispatch 2 ครั้ง = 2 คู่ attempt (open+outcome) — uaNonce ที่ไม่ซ้ำกัน
      const openAttempts = sdkAttempts.filter((a) => a.payload["status"] === null);
      const outcomeAttempts = sdkAttempts.filter((a) => a.payload["outcome"] === true);
      expect(openAttempts.length).toBeGreaterThanOrEqual(2);
      expect(outcomeAttempts.length).toBeGreaterThanOrEqual(2);
      const nonces = openAttempts.map((a) => String(a.payload["uaNonce"] ?? ""));
      expect(new Set(nonces).size).toBe(nonces.length); // nonce ต่อ dispatch — ไม่ซ้ำ
      const classifications = openAttempts.map((a) => String(a.payload["classification"] ?? ""));
      expect(classifications).toContain("read");
      expect(classifications).toContain("write");
      for (const a of openAttempts) expect(String(a.payload["uaNonce"])).toMatch(/^ltc-inv-/);
    });

    it("manifest: buildTouchSet แทนค่า entity keys ถูกต้อง", () => {
      const entry = manifestByOpKey("rpc:admin_revoke_role:POST");
      if (entry === undefined) throw new Error("manifest entry หาย: rpc:admin_revoke_role:POST");
      expect(entry.label).toBe("admin-revoke-role");
      const ts = buildTouchSet(entry, { uuid: "00000000-0000-0000-0000-000000000001" });
      expect(ts[0]?.where).toBe("user_id = '00000000-0000-0000-0000-000000000001'");
    });
  });

  describe("pure (ไม่แตะ stack)", () => {
    it("deriveOpKey + normalizePathForLog", () => {
      expect(deriveOpKey("kong-path", "post", "http://localhost:8000/rest/v1/rpc/admin_revoke_role")).toBe(
        "rpc:admin_revoke_role:POST",
      );
      expect(
        normalizePathForLog("kong-path", "http://localhost:8000/rest/v1/rpc/admin_revoke_role"),
      ).toBe("/rpc/admin_revoke_role");
      expect(deriveOpKey("app-direct", "patch", "http://localhost:3000/api/v1/admin/users/11111111-1111-1111-1111-111111111111")).toBe(
        "app:PATCH:/api/v1/admin/users/:uuid",
      );
    });
  });
});
