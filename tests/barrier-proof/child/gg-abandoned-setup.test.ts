/**
 * 8e — child file: setup ถูก runner ทิ้งกลางทาง (per-hook timeout 12.5s ตาม DCR-BARRIER-REBASELINE — config 5s เดิมตัดก่อน fileBegin จบบนเครื่องสำรอง) แต่ setup จริง
 * (psql pg_sleep 30s + insert ปลายทาง) "ยังวิ่งจนจบ" ตาม F56 — และ teardown ต้อง
 * รอ setup เซ็ตเทิลจริงก่อนเริ่ม cleanup (ts ของ setup-complete < cleanup-start)
 *
 * โครงต่างจาก guardedBeforeAll ปกติโดยจงใจ: จับ lifecycleId ออกมาก่อน (fileBegin
 * รีเทิร์นไว) เพราะ guardedBeforeAll จะคืน id ก็ต่อเมื่อ fn จบ (~35s) — afterAll
 * ที่เริ่มที่ ~12.7s ต้องมี id ไว้ตรวจ lifecycle แล้วรอ awaitFileSettled
 *
 * ลำดับเวลา:
 *   t≈4.5s  fileBegin กลับมือ (boot ~2s + psql 2-3 ครั้ง) → เริ่ม pg_sleep(30)
 *   t≈12.5s runner ตัด beforeAll (per-hook timeout) — psql subprocess ยังวิ่ง
 *   t≈12.7s afterAll เริ่ม → guardedAfterAll → awaitFileSettled (budget 62.5s)
 *   t≈35s   pg_sleep จบ → insert gg-late-marker → note setup-complete →
 *          phase setup-settled (ทั้งหมดโดย promise ที่ถูกทิ้ง)
 *   t≈38s   awaitFileSettled เห็น → cleanup TX (ลบ marker รวมที่แทรกช้า) →
 *          teardown-settled
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  fileBegin,
  fileSetupSettled,
  guardedAfterAll,
  insertMarkers,
} from "../barrier-harness.js";
import { psql } from "../../integration/helpers.js";
import { ledgerWrite } from "../../integration/test-io.js";

export const GG_FILE = "8e-gg-abandoned-setup";

describe.skipIf(process.env.BARRIER_CHILD !== "1")("8e-gg setup ถูกทิ้งกลางทาง (child)", () => {
  let lifecycleId = "";

  // per-hook timeout 12.5s (DCR-BARRIER-REBASELINE) — beforeAll ต้องโดน runner ตัด
  // กลาง pg_sleep หลัง lifecycleId กลับมือแน่ (หัวใจของ 8e — config 5s เดิมตัดก่อน
  // fileBegin จบบนเครื่องสำรอง ทำให้ lifecycleId เป็นค่าว่างและ afterAll fast-refuse)
  beforeAll(async () => {
    lifecycleId = await fileBegin(GG_FILE, "8e-gg setup ที่จะถูกทิ้งกลางทาง");
    await psql("select pg_sleep(30);");
    // —— จากตรงนี้คือส่วนที่ runner ทิ้งไปแล้ว แต่ promise ยังวิ่ง (F56) ——
    await insertMarkers(GG_FILE, "gg-late-marker", 1, "แทรกโดย promise ที่ถูก runner ทิ้ง");
    await ledgerWrite("note", { event: "setup-complete", file: GG_FILE, lifecycleId });
    await fileSetupSettled(GG_FILE, lifecycleId);
  }, 12_500);

  it("8e-gg body ต้องไม่รัน (beforeAll ถูกตัด)", () => {
    throw new Error("8e-gg: body ห้ามรันเมื่อ beforeAll ถูก runner ทิ้ง");
  });

  afterAll(async () => {
    await guardedAfterAll(GG_FILE, "8e-gg teardown รอ setup เซ็ตเทิลจริงก่อน cleanup", {
      lifecycleId,
      setupBudgetMs: 62_500,
    });
  }, 75_000);
});
