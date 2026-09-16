/**
 * e2e/helpers/d9-cleanup.ts — cleanup ของ suite D-9 แบบ Playwright-safe [#94]
 * (แยกจาก d9-helpers เพื่อ tests/integration/wave-h-cleanup-fk-proof import
 * "helper จริง" ได้โดยไม่ลาก @playwright/test ตามมา)
 *
 * waveh-r1 M2 (gate r1): deleteD9User ใช้ builder กลาง D89-1 (runUserCleanupVia —
 * TX เดียว · FK-topological leaf-first · toggle append-only · post-guard) แทน SQL
 * มือหลาย TX ที่ลบ certificates ก่อน credit_ledger_entries (บั๊กลำดับจริง r6:2311)
 * — เหมือน deleteTestUser ของ integration และ cleanupD8World ของ D-8 ที่ใช้ร่วมกัน
 * อยู่แล้ว · ทุกการลบเขียน lifecycle rows ให้ audit-e2e (--run-id e2e) เห็นจริง
 *
 * dynamic import ของ cleanup-builder: โมดูลนั้นไร้ import ทั้งหมด (Playwright-safe
 * ยืนยันใน header ของมันเอง) — ทางนี้วางในตัวฟังก์ชันเพื่อไม่ผูก static graph
 * ของ spec กับ tests/integration
 */
import { psql, psqlRows } from "./db";
import { lifecycleBegin, lifecycleSettle } from "./lifecycle";

// ─── id ตายตัวของ "สอบเร็ว" FAST-A (มิเรอร์ค่าจาก tests/integration/helpers-d8.ts) ──

/** รอบสอบสอบเร็ว FAST-A (max_attempts 2 · cooldown 0 · 4 ข้อ) — แหล่งค่าเดียว
 * ทั้ง d9-helpers (seed) และที่นี่ (cleanup) */
export const FAST_A = {
  assessment: "cccccccc-cccc-4ccc-8ccc-0000000000d8",
  rules: "dddddddd-dddd-4ddd-8ddd-0000000000d8",
  bank: "eeeeeeee-eeee-4eee-8eee-0000000000d8",
  code: "EXAM-D8-FAST-A",
} as const;

/** id โจทย์ 4 ข้อของ FAST-A (มิเรอร์ helpers-d8) */
export const FAST_A_QUESTIONS: readonly string[] = [
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d1",
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d2",
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d3",
  "f0f0f0f0-f0f0-4f0f-8f0f-0000000000d4",
];

/**
 * ลบแถวสอบเร็ว FAST-A ทั้งชุด — เรียงตาม FK (RESTRICT):
 * event_outbox/attempt_answers/assessment_attempts ของรอบนี้ (ผู้ใช้ใดก็ได้ — id
 * รอบเป็น uuid ตายตัวของ suite) ก่อนลบโจทย์/ตัวเลือก/ธนาคาร/กติกา/รอบสอบ ไม่งั้น
 * beforeAll ซ้ำชน FK
 */
export async function cleanupFastExamARows(): Promise<void> {
  const questionList = FAST_A_QUESTIONS.map((id) => `'${id}'`).join(",");
  await psql(`
    delete from public.event_outbox
     where payload ->> 'source_id' in (
       select id::text from public.assessment_attempts where assessment_id = '${FAST_A.assessment}');
    delete from public.attempt_answers
     where attempt_id in (select id from public.assessment_attempts where assessment_id = '${FAST_A.assessment}');
    delete from public.assessment_attempts where assessment_id = '${FAST_A.assessment}';
    delete from public.question_options where question_id in (${questionList});
    delete from public.questions where bank_id = '${FAST_A.bank}';
    delete from public.question_banks where id = '${FAST_A.bank}';
    delete from public.assessment_rules where id = '${FAST_A.rules}';
    delete from public.assessments where id = '${FAST_A.assessment}';
  `);
}

/**
 * ล้างโลกของ suite D-9 ทั้งชุด (เทียบเท่า cleanupD8World ของ D-8):
 * - ผู้ใช้ email pattern 'd9-%' ทั้งชุด "ผ่าน builder กลาง" (TX เดียว FK-topological
 *   + post-guard — เหมือน cleanupD8World) พร้อม lifecycle rows ให้ audit-e2e
 * - แถวสอบเร็ว FAST-A (รวม attempts ของผู้ใช้อื่นบนรอบนี้ — id ตายตัวของ suite)
 * NB: audit_logs เป็น append-only ตามดีไซน์ — ตั้งใจคงไว้
 */
export async function cleanupD9World(): Promise<void> {
  const ids = (
    await psqlRows<{ id: string }>(`select id::text from auth.users where email like 'd9-%';`)
  ).map((u) => u.id);
  if (ids.length > 0) {
    const opKey = "e2e:cleanup-d9-world";
    const invocationId = await lifecycleBegin(opKey, "cleanupD9World");
    try {
      const { runUserCleanupVia } = await import("../../tests/integration/cleanup-builder");
      const result = await runUserCleanupVia(psql, ids);
      await lifecycleSettle(invocationId, opKey, "settled", {
        users: ids.length,
        attempts: result.attempts,
      });
    } catch (err) {
      await lifecycleSettle(invocationId, opKey, "poisoned", { error: String(err).slice(0, 300) });
      throw err;
    }
  }
  await cleanupFastExamARows();
}

/**
 * ลบผู้ใช้ d9 คนเดียวครบทุกแถวที่ FK ผูกอยู่ — ผ่าน builder กลาง D89-1
 * (runUserCleanupVia: TX เดียว · ledger ก่อน certificates ตาม topo · toggle
 * append-only ใน TX เดียวกัน · post-guard RAISE เหลือแถวค้าง) + lifecycle rows
 * NB: audit_logs เป็น append-only ตามดีไซน์ (trigger ห้ามลบทุก role) — ตั้งใจคงไว้
 *     เหมือน D-8 · ไฟล์ใน storage.objects ของ PDF คงค้างได้ (ไม่มี FK — ไม่บังการรันซ้ำ)
 */
export async function deleteD9User(userId: string): Promise<void> {
  const opKey = "e2e:delete-d9-user";
  const invocationId = await lifecycleBegin(opKey, "deleteD9User");
  try {
    const { runUserCleanupVia } = await import("../../tests/integration/cleanup-builder");
    const result = await runUserCleanupVia(psql, [userId]);
    await lifecycleSettle(invocationId, opKey, "settled", {
      attempts: result.attempts,
      retriedOn: result.retriedOn,
    });
  } catch (err) {
    await lifecycleSettle(invocationId, opKey, "poisoned", { error: String(err).slice(0, 300) });
    throw err;
  }
}
