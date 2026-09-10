/**
 * DCR-4 — views สาธารณะ 3 ตัวของ migration 0012 + policy cc_read_admin
 *
 * ตรวจบน dev stack จริงทั้ง SQL (information_schema / pg_class / privileges) และ REST/GoTrue จริง:
 * 1) course_public_stats — เฉพาะ published + deleted_at is null; learner_count นับ enrollment
 *    ที่ไม่ cancelled; credits จาก credit_rules active ที่ครอบ now() เลือก priority ต่ำสุด (NULL ถ้าไม่มี)
 * 2) course_instructors_public — คอลัมน์ต้องมีแค่ course_id/display_name/title/bio
 *    (ห้าม email/phone/first_name/last_name — DD §4.5 PII) — ตรวจจาก information_schema
 * 3) course_exam_summary — หนึ่งแถวต่อหลักสูตร: question_count/time_limit_minutes/pass_score_pct/max_attempts
 * 4) security_invoker = off ทุก view + grant SELECT เฉพาะ view (ไม่ grant ตารางฐานเพิ่ม)
 * 5) cc_read_admin — staff:viewer เห็นหมวด is_active=false / ผู้เรียนธรรมดาไม่เห็น
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANON_KEY,
  createTestUser,
  deleteTestUser,
  psql,
  psqlRows,
  reloadRestSchema,
  restCall,
  type TestUser,
} from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

/** id ของหลักสูตร seed ตามรหัส (เฉพาะ LTC-* published) — key ของการ assert ค่า view */
async function courseIdMap(): Promise<Map<string, string>> {
  const rows = await psqlRows<{ code: string; id: string }>(
    `select code, id::text from public.courses where code like 'LTC-%' and status = 'published';`,
  );
  return new Map(rows.map((row) => [row.code, row.id]));
}

interface StatsRow {
  readonly course_id: string;
  readonly learner_count: number;
  readonly credits: number | null;
}

interface ExamRow {
  readonly course_id: string;
  readonly question_count: number;
  readonly time_limit_minutes: number | null;
  readonly pass_score_pct: number | null;
  readonly max_attempts: number | null;
}

interface CategoryRow {
  readonly slug: string;
  readonly is_active: boolean;
}

describe.skipIf(!DB_URL)("DCR-4 views + cc_read_admin", () => {
  let ids: Map<string, string>;
  let staffViewer: TestUser;

  beforeAll(async () => {
    await reloadRestSchema(); // PostgREST ต้องรู้จัก view ใหม่ของ 0012 ก่อน (schema cache)
    ids = await courseIdMap();
    staffViewer = await createTestUser("c9-dcr4", "staff:viewer");
  }, 60_000);

  afterAll(async () => {
    if (typeof staffViewer !== "undefined") await deleteTestUser(staffViewer.id);
  });

  it("course_public_stats: guest อ่านได้ (grant anon) และมีเฉพาะหลักสูตร published ของ seed ครบ 6 หลักสูตร (draft ไม่มี)", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/course_public_stats?select=course_id,learner_count,credits&course_id=in.(${[...ids.values()].join(",")})`,
      { apiKey: ANON_KEY }, // guest — ไม่มี token
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as StatsRow[];
    expect(rows).toHaveLength(6);
    // draft ต้องไม่มีแถวใน view (แม้ query แบบไม่กรอง — พิสูจน์ด้วย SQL ตรง)
    const draftStats = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.course_public_stats
      where course_id = (select id from public.courses where code = 'LTC-DRAFT-001');
    `);
    expect(draftStats[0]?.n).toBe(0);

    const byId = new Map(rows.map((row) => [row.course_id, row]));
    const statsOf = (code: string): StatsRow | undefined => byId.get(ids.get(code) ?? "");
    // LTC-101: enrollment active 1 (cancelled ไม่นับ) + credits จาก CR-LTC-101 active
    expect(statsOf("LTC-101")).toMatchObject({ learner_count: 1, credits: 12.5 });
    // retired rule 9.00 (priority 5 ต่ำกว่า) ต้องไม่ถูกเลือก — status filter ทำงาน
    expect(statsOf("LTC-101")?.credits).not.toBe(9);
    // LTC-102/103: active rule ปกติ
    expect(statsOf("LTC-102")).toMatchObject({ learner_count: 0, credits: 6 });
    expect(statsOf("LTC-103")).toMatchObject({ learner_count: 0, credits: 3.5 });
    // LTC-104 มีแต่กฎอนาคต (effective_from = now()+90d) → credits ต้องเป็น NULL ไม่ใช่ 8
    expect(statsOf("LTC-104")).toMatchObject({ learner_count: 0, credits: null });
    // ไม่มีกฎ credit เลย → NULL
    expect(statsOf("LTC-105")?.credits).toBeNull();
    expect(statsOf("LTC-106")?.credits).toBeNull();
  });

  it("course_instructors_public: คอลัมน์ตาม information_schema = course_id, display_name, title, bio เท่านั้น (ไม่มี PII)", async () => {
    const cols = await psqlRows<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'course_instructors_public'
      order by ordinal_position;
    `);
    expect(cols.map((c) => c.column_name)).toEqual(["course_id", "display_name", "title", "bio"]);
    const forbidden = ["email", "phone", "first_name", "last_name"];
    for (const name of forbidden) {
      expect(cols.map((c) => c.column_name)).not.toContain(name);
    }
  });

  it("course_instructors_public: guest อ่านได้ ครบ 6 หลักสูตร published ของ seed และ display_name ถูกต้อง", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/course_instructors_public?select=course_id,display_name,title,bio&course_id=in.(${[...ids.values()].join(",")})`,
      { apiKey: ANON_KEY },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as { course_id: string; display_name: string; title: string | null; bio: string | null }[];
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.display_name).toBe("Somchai Instructor (demo)");
      expect(row.title).toBeNull();
      expect(row.bio).toBeNull();
    }
    // draft ต้องไม่มีแถวใน view (แม้ query แบบไม่กรอง — พิสูจน์ด้วย SQL ตรง)
    const draftInstructors = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.course_instructors_public
      where course_id = (select id from public.courses where code = 'LTC-DRAFT-001');
    `);
    expect(draftInstructors[0]?.n).toBe(0);
  });

  it("course_exam_summary: guest อ่านได้ มี 1 แถว (LTC-103) ครบ 4 ฟิลด์ตาม DCR-4", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/course_exam_summary?select=course_id,question_count,time_limit_minutes,pass_score_pct,max_attempts&course_id=eq.${String(ids.get("LTC-103"))}`,
      { apiKey: ANON_KEY },
    );
    expect(result.status, result.text.slice(0, 500)).toBe(200);
    const rows = result.json as ExamRow[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.course_id).toBe(ids.get("LTC-103"));
    // นับเฉพาะ questions status='active' (draft ไม่นับ) + rules version 1 (90 นาที / ผ่าน 70% / 3 ครั้ง)
    expect(row?.question_count).toBe(5);
    expect(row?.time_limit_minutes).toBe(90);
    expect(row?.pass_score_pct).toBe(70);
    expect(row?.max_attempts).toBe(3);
  });

  it("course_exam_summary: psql ground-truth ให้ค่าเดียวกับ REST (หนึ่งแถวต่อหลักสูตร)", async () => {
    const rows = await psqlRows<ExamRow>(`
      select course_id::text, question_count, time_limit_minutes, pass_score_pct, max_attempts
      from public.course_exam_summary
      where course_id = '${ids.get("LTC-103") ?? ""}';
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.course_id).toBe(ids.get("LTC-103"));
    expect(rows[0]?.question_count).toBe(5);
    expect(rows[0]?.time_limit_minutes).toBe(90);
    expect(rows[0]?.pass_score_pct).toBe(70);
    expect(rows[0]?.max_attempts).toBe(3);
  });

  it("course_exam_summary: แบบทดสอบซ้อม non-final ที่ published ทีหลังต้องไม่แทนที่ข้อสอบปลายหลักสูตร (is_final)", async () => {
    const courseId = ids.get("LTC-103") ?? "";
    // เตรียม: แบบทดสอบซ้อม (is_final=false) published หลังข้อสอบปลายหลักสูตร + กติกา pass_pct=99
    // (เลข 99 ไม่ปนกับ seed ใด — ถ้า view ไม่กรอง is_final จะเห็น 99 ทันที) — id เฉพาะของ test นี้
    await psql(`
      delete from public.assessment_rules where assessment_id = 'cccccccc-cccc-4ccc-8ccc-000000000009';
      delete from public.assessments where id = 'cccccccc-cccc-4ccc-8ccc-000000000009';
    `);
    await psql(`
      insert into public.assessments
        (id, course_id, code, title, description, is_final, status, published_at) values
        ('cccccccc-cccc-4ccc-8ccc-000000000009', '${courseId}',
         'EXAM-LTC-103-PRACTICE', 'แบบทดสอบซ้อม (non-final)', null, false, 'published', now() + interval '1 day')
      on conflict do nothing;
    `);
    await psql(`
      insert into public.assessment_rules
        (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
         attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection, require_course_complete,
         proctoring_mode, effective_from) values
        ('dddddddd-dddd-4ddd-8ddd-000000000009', 'cccccccc-cccc-4ccc-8ccc-000000000009',
         1, 30, 2, 99, 1, 0, false, false, '{"bank_ids":["eeeeeeee-eeee-4eee-8eee-000000000001"]}'::jsonb,
         false, 'none', now() - interval '1 day')
      on conflict do nothing;
    `);
    try {
      const rows = await psqlRows<ExamRow>(`
        select course_id::text, question_count, time_limit_minutes, pass_score_pct, max_attempts
        from public.course_exam_summary
        where course_id = '${courseId}';
      `);
      // ยังเป็นข้อสอบปลายหลักสูตรของ seed ตัวเดิม — ไม่ใช่แบบทดสอบซ้อม (30 นาที / ผ่าน 99% / 1 ครั้ง)
      expect(rows).toHaveLength(1);
      expect(rows[0]?.time_limit_minutes).toBe(90);
      expect(rows[0]?.pass_score_pct).toBe(70);
      expect(rows[0]?.max_attempts).toBe(3);
    } finally {
      await psql(`
        delete from public.assessment_rules where assessment_id = 'cccccccc-cccc-4ccc-8ccc-000000000009';
        delete from public.assessments where id = 'cccccccc-cccc-4ccc-8ccc-000000000009';
      `);
    }
  });

  it("course_exam_summary: หลักสูตรแม่ draft/archived/soft-deleted ต้องไม่รั่วผ่าน view แม้ final exam published (gate r1)", async () => {
    // ช่องรั่วที่ codex gate r1 จับ: view เดิมกรองเฉพาะฝั่ง assessments ไม่ดูสถานะหลักสูตรแม่
    // anon เรียก view ตรง ๆ ผ่าน PostgREST → เห็น course_id + เงื่อนไขสอบของหลักสูตรที่ยังไม่เผยแพร่
    const categoryId = "33333333-3333-4333-8333-000000000003";
    const owner = "11111111-1111-4111-8111-000000000002";
    const variants = [
      { course: "44444444-4444-4444-8444-0000000000d1", exam: "cccccccc-cccc-4ccc-8ccc-0000000000d1", rule: "dddddddd-dddd-4ddd-8ddd-0000000000d1", code: "LTC-GATE-DRAFT", status: "draft", deleted: "null" },
      { course: "44444444-4444-4444-8444-0000000000d2", exam: "cccccccc-cccc-4ccc-8ccc-0000000000d2", rule: "dddddddd-dddd-4ddd-8ddd-0000000000d2", code: "LTC-GATE-ARCHIVED", status: "archived", deleted: "null" },
      { course: "44444444-4444-4444-8444-0000000000d3", exam: "cccccccc-cccc-4ccc-8ccc-0000000000d3", rule: "dddddddd-dddd-4ddd-8ddd-0000000000d3", code: "LTC-GATE-DELETED", status: "published", deleted: "now()" },
    ];
    const cleanup = () =>
      psql(`
        delete from public.assessment_rules where assessment_id in (${variants.map((v) => `'${v.exam}'`).join(",")});
        delete from public.assessments where id in (${variants.map((v) => `'${v.exam}'`).join(",")});
        delete from public.courses where id in (${variants.map((v) => `'${v.course}'`).join(",")});
      `);
    await cleanup();
    await psql(`
      insert into public.courses (id, code, category_id, created_by, title_th, status, published_at, deleted_at) values
        ${variants.map((v) => `('${v.course}', '${v.code}', '${categoryId}', '${owner}', 'หลักสูตรรั่ว (${v.code})', '${v.status}', now(), ${v.deleted})`).join(",\n        ")}
      on conflict do nothing;
    `);
    await psql(`
      insert into public.assessments (id, course_id, code, title, description, is_final, status, published_at) values
        ${variants.map((v) => `('${v.exam}', '${v.course}', 'EXAM-${v.code}', 'ข้อสอบปลายหลักสูตรหลักสูตรไม่เผยแพร่', null, true, 'published', now())`).join(",\n        ")}
      on conflict do nothing;
    `);
    await psql(`
      insert into public.assessment_rules
        (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
         attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection, require_course_complete,
         proctoring_mode, effective_from) values
        ${variants.map((v) => `('${v.rule}', '${v.exam}', 1, 45, 4, 88, 2, 0, false, false, '{"bank_ids":["eeeeeeee-eeee-4eee-8eee-000000000001"]}'::jsonb, false, 'none', now() - interval '1 day')`).join(",\n        ")}
      on conflict do nothing;
    `);
    try {
      // ช่องทางรั่วจริง: anon เรียก view ผ่าน PostgREST โดยตรง
      const leak = await restCall(
        "GET",
        `/rest/v1/course_exam_summary?select=course_id&course_id=in.(${variants.map((v) => `"${v.course}"`).join(",")})`,
        { apiKey: ANON_KEY },
      );
      expect(leak.status, leak.text.slice(0, 300)).toBe(200);
      expect(leak.json, `ต้องไม่เห็นเงื่อนไขสอบของหลักสูตร ${variants.map((v) => v.code).join("/")}`).toEqual([]);

      // positive control ในเทสต์เดียวกัน: หลักสูตร published จริง (LTC-103) ยังอยู่
      const control = await restCall(
        "GET",
        `/rest/v1/course_exam_summary?select=course_id&course_id=eq.${String(ids.get("LTC-103"))}`,
        { apiKey: ANON_KEY },
      );
      expect(control.status).toBe(200);
      expect(control.json).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("ทั้งสาม view: security_invoker = off (pg_class.reloptions) — definer view ตาม convention 0009", async () => {
    const rows = await psqlRows<{ relname: string; reloptions: string[] | null }>(`
      select relname, reloptions::text[] from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('course_public_stats','course_instructors_public','course_exam_summary');
    `);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.reloptions).toContain("security_invoker=off");
    }
  });

  it("privileges: anon+authenticated SELECT ครบทั้งสาม view และ guest ไม่เห็นข้อมูลตารางฐาน (RLS กรอง enrollments ให้ว่าง)", async () => {
    const rows = await psqlRows<{ v: string; r: string; ok: boolean }>(`
      select v, r, has_table_privilege(r, v, 'SELECT') as ok
      from (values ('course_public_stats'),('course_instructors_public'),('course_exam_summary')) views(v),
           (values ('anon'),('authenticated')) roles(r);
    `);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.ok, `${row.r} SELECT ${row.v}`).toBe(true);
    }
    // ตารางฐาน: guest ต้องไม่เห็นแถวใดเลย (0010 ไม่มี policy ให้ anon + 0012 ไม่ grant ตารางฐานเพิ่ม —
    // ตรวจผลลัพธ์ความปลอดภัยจริงผ่าน REST แทน grant matrix ที่ dev DB อาจมีมือถือมาแตะ)
    const leakCheck = await restCall(
      "GET",
      "/rest/v1/enrollments?select=id&order=id.desc&limit=5",
      { apiKey: ANON_KEY },
    );
    expect(leakCheck.status, leakCheck.text.slice(0, 300)).toBe(200);
    expect(leakCheck.json).toEqual([]);
  });

  it("cc_read_admin: staff:viewer เห็นหมวด is_active=false (disabled-category) / citizen และ guest ไม่เห็น", async () => {
    const staff = await restCall(
      "GET",
      "/rest/v1/course_categories?select=slug,is_active&order=slug.asc",
      { apiKey: ANON_KEY, token: staffViewer.accessToken },
    );
    expect(staff.status, staff.text.slice(0, 300)).toBe(200);
    const staffRows = staff.json as CategoryRow[];
    // staff:viewer ต้องเห็นหมวดปิดใช้งานของ seed ผ่าน cc_read_admin (dev DB มีหมวดทดสอบอื่นร่วมด้วย — เช็คแบบ scoped)
    expect(
      staffRows.filter((row) => row.slug === "disabled-category"),
    ).toEqual([{ slug: "disabled-category", is_active: false }]);
    // ทุกหมวดที่ staff เห็น (รวม disabled) ไม่ควรถูก RLS กรองให้เหลือเฉพาะ active
    expect(staffRows.some((row) => row.is_active === false)).toBe(true);

    const citizen = await createTestUser("c9-dcr4-citizen", "citizen");
    try {
      const result = await restCall(
        "GET",
        "/rest/v1/course_categories?select=slug,is_active&order=slug.asc",
        { apiKey: ANON_KEY, token: citizen.accessToken },
      );
      expect(result.status).toBe(200);
      const citizenRows = result.json as CategoryRow[];
      expect(citizenRows.some((row) => row.slug === "disabled-category")).toBe(false);
      // citizen (cc_read เท่านั้น) เห็นเฉพาะแถว is_active=true — invariant บนข้อมูลทั้งชุดที่เห็น
      expect(citizenRows.every((row) => row.is_active === true)).toBe(true);
    } finally {
      await deleteTestUser(citizen.id);
    }

    const guest = await restCall(
      "GET",
      "/rest/v1/course_categories?select=slug,is_active&order=slug.asc",
      { apiKey: ANON_KEY },
    );
    expect(guest.status).toBe(200);
    const guestRows = guest.json as CategoryRow[];
    expect(guestRows.some((row) => row.slug === "disabled-category")).toBe(false);
    expect(guestRows.every((row) => row.is_active === true)).toBe(true);
  });
});
