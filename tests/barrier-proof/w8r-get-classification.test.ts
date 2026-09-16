/**
 * 8r — fixture ค: GET classification ×4 + unknown-endpoint-write-classified
 * (r30 §2-D89-3 trackedClient "default-deny ไม่รู้จัก = write เสมอ" + §2-D89-4
 * CC·fixtures "GET classification ×4")
 *
 * trackedClient (SDK fetch-injection): ทุก dispatch ของ SDK ผ่านจุดกลาง จำแนก
 * read/write ก่อนยิง — ไม่ใช่ RPC = GET/HEAD เท่านั้นที่เป็น read · RPC ทุกตัว
 * = write (SDK_READ_ONLY_RPC ว่าง — ไม่มีหลักฐาน probe ระดับ entry จึง
 * default-deny · limitation 19) · unknown endpoint (ฟังก์ชันที่ไม่มีอยู่จริง)
 * ก็ถูกจัด write เสมอ
 *
 * ×4 ของ GET ครอบสี่รูปทางจริง: table select สามตาราง (rest/v1) + auth getUser
 * (auth/v1) — ทั้งหมดต้องมี attempt row classification='read' คู่กับ
 * classification='write' ของ RPC ที่ไม่รู้จักใน parentCallKey เดียวกัน
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createTestUser } from "../integration/helpers.js";
import { createTrackedClient, currentRunId, ledgerRead } from "../integration/test-io.js";

describe("8r GET classification ×4 + unknown-endpoint = write (trackedClient default-deny)", () => {
  let accessToken = "";

  beforeAll(async () => {
    const user = await createTestUser("h8r-reader");
    accessToken = user.accessToken;
  }, 120_000);

  it(
    "GET ×4 = read · rpc ที่ไม่รู้จัก = write — จำแนกที่ dispatch ไม่ใช่ที่ผลลัพธ์",
    async () => {
      const tc = createTrackedClient({ label: "h8r-classification" });

      // ×4 GET รูปทางจริง (ผลลัพธ์ไม่สำคัญ — จำแนกก่อน dispatch เสมอ)
      await tc.client.from("courses").select("id").limit(1);
      await tc.client.from("question_banks").select("id").limit(1);
      await tc.client.from("credit_rules").select("id").limit(1);
      const gu = await tc.client.auth.getUser(accessToken);
      expect(gu.error, "auth ต้องสุขภาพดี (ใช้ token จริง) — ไม่งั้นไม่ใช่หลักฐานของ classification").toBeNull();

      // unknown endpoint — ฟังก์ชันไม่มีอยู่จริง ต้องถูกจัด write เสมอ (default-deny)
      const rpc = await tc.client.rpc("h8r_no_such_fn");
      expect(rpc.error, "RPC ที่ไม่มีอยู่ต้อง error (404 จาก PostgREST)").not.toBeNull();

      // อ่าน attempt rows ของ parentCallKey นี้จาก ledger (pre-dispatch: status=null)
      const attempts = await ledgerRead({ runId: currentRunId(), kinds: ["attempt"] });
      const mine = attempts.filter((r) => r.payload["parentCallKey"] === tc.parentCallKey);
      expect(mine.length, "ต้องมี attempt rows ครบ (pre-dispatch + outcome)").toBeGreaterThanOrEqual(10);

      const pre = mine.filter((r) => r.payload["status"] === null);
      const reads = pre.filter((r) => r.payload["classification"] === "read");
      const writes = pre.filter((r) => r.payload["classification"] === "write");
      expect(reads.length, "GET สี่รูปทาง = read ครบ").toBe(4);
      expect(writes.length, "RPC ไม่รู้จักตัวเดียว = write").toBe(1);
      for (const r of reads) {
        expect(r.payload["method"]).toBe("GET");
      }
      const readUrls = new Set(reads.map((r) => String(r.payload["urlNorm"])));
      expect(readUrls, "สี่เส้นทางจริง: rest ×3 + auth ×1 (urlNorm เก็บแบบ normalizePathForLog — strip /rest/v1 ตาม Kong strip_path)").toEqual(
        new Set(["/courses", "/question_banks", "/credit_rules", "/auth/v1/user"]),
      );

      const rpcPre = writes[0]!;
      expect(rpcPre.payload["method"]).toBe("POST");
      expect(rpcPre.payload["urlNorm"], "urlNorm แบบ normalizePathForLog (strip /rest/v1)").toBe("/rpc/h8r_no_such_fn");
      // outcome row ผูกกลับ pre-dispatch (attemptEventId) — สถานะจริง 404
      const rpcOut = mine.find((r) => r.payload["attemptEventId"] === rpcPre.id);
      expect(rpcOut?.payload["status"], "PostgREST ตอบ 404 แต่ classification คง write (จำแนกก่อนยิง)").toBe(404);
    },
    60_000,
  );
});
