/**
 * repeated-or semantics — PostgREST `.or()` ซ้อนกัน (คำค้น + cursor พร้อมกัน)
 *
 * BFF (src/app/api/v1/courses/route.ts) สร้าง query แบบนี้:
 *   .or("title_th.ilike.%q%,title_en.ilike.%q%,summary.ilike.%q%")   ← คำค้น (ถ้ามี q)
 *   .or(cursorFilterOf({ sortKey, id }))                              ← cursor เลื่อนหน้า
 * postgrest-js ใช้ searchParams.append("or", ...) → URL มี `or=` สองตัว
 * คำถามที่ต้องพิสูจน์บน PostgREST จริง: or= ซ้ำ = AND ระหว่างเงื่อนไข (ไม่ใช่ OR ทับ/ทำหาย)
 *
 * วิธีทดสอบ (ระบุตาม spawn prompt): REST จริงผ่าน Kong (citizen JWT) เทียบกับ SQL ground-truth
 * เดียวกันบน psql (RLS ของ citizen: published + is_public) — seed ให้ LTC-104/LTC-106
 * มี published_at เท่ากันเป็นคู่ tie ของ cursor
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANON_KEY,
  createTestUser,
  deleteTestUser,
  psqlScalar,
  psqlRows,
  restCall,
  type TestUser,
} from "./helpers.js";
// waveh-r1 M1: postgrest-js ผ่าน trackedClient (fetch injection) — ห้าม createClient ตรง
import { createTrackedClient } from "./test-io";

const DB_URL = process.env.TEST_DATABASE_URL;

/** สร้าง or-filter ของคำค้น — เหมือน BFF (route.ts: `q.replace(/[,()]/g, " ")`) */
function searchFilterOf(term: string): string {
  return `title_th.ilike.%${term}%,title_en.ilike.%${term}%,summary.ilike.%${term}%`;
}

/** or-filter ของ cursor — เหมือน cursorFilterOf ของ BFF (เรียง published_at desc, id desc) */
function cursorFilterOf(sortKey: string, id: string): string {
  return `published_at.lt.${sortKey},and(published_at.eq.${sortKey},id.lt.${id})`;
}

describe.skipIf(!DB_URL)("repeated-or: คำค้น + cursor พร้อมกัน (PostgREST ANDs repeated or=)", () => {
  let user: TestUser;
  let sortKey: string; // published_at ของ LTC-106 (เท่ากับ LTC-104 — คู่ tie)
  let id106: string;
  const term = "ทนาย"; // match LTC-102 (ภาษีน่ารู้สำหรับทนายความ) + LTC-106 (จริยธรรมทนายความ)

  beforeAll(async () => {
    user = await createTestUser("c9-or", "citizen");
    sortKey = await psqlScalar(
      `select replace(published_at::text, ' ', 'T') from public.courses where code = 'LTC-106';`,
    );
    id106 = await psqlScalar(`select id::text from public.courses where code = 'LTC-106';`);
  }, 60_000);

  afterAll(async () => {
    if (user !== undefined) await deleteTestUser(user.id);
  });

  it("postgrest-js (ชุดคำสั่งเดียวกับ BFF) เติม or= สองตัวใน URL จริง", async () => {
    const { client } = createTrackedClient({
      label: "repeated-or-cursor-postgrest-js",
      globalHeaders: { Authorization: `Bearer ${user.accessToken}` },
    });
    const builder = client
      .from("courses")
      .select("code")
      .not("published_at", "is", null)
      .or(searchFilterOf(term))
      .or(cursorFilterOf(sortKey, id106))
      .order("published_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50);
    // URL ต้องมี query param ชื่อ or จำนวน 2 ตัว (searchParams.append — ไม่ override กัน)
    const url = (builder as unknown as { url: URL }).url;
    expect(url.searchParams.getAll("or")).toHaveLength(2);
  });

  it("baseline: คำค้นอย่างเดียว (or= เดียว) → LTC-106 ก่อน LTC-102 (published_at desc, id desc)", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/courses?select=code,id,published_at&code=like.LTC-*&published_at=not.is.null&or=(${encodeURIComponent(searchFilterOf(term))})&order=published_at.desc,id.desc`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    expect((result.json as { code: string }[]).map((row) => row.code)).toEqual([
      "LTC-106",
      "LTC-102",
    ]);
  });

  it("คำค้น + cursor พร้อมกัน → LTC-102 เท่านั้น (AND) — ห้ามเพิ่ม LTC-104 ที่ผ่าน cursor แต่ไม่ match คำค้น", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/courses?select=code,id,published_at&code=like.LTC-*&published_at=not.is.null` +
        `&or=(${encodeURIComponent(searchFilterOf(term))})` +
        `&or=(${encodeURIComponent(cursorFilterOf(sortKey, id106))})` +
        `&order=published_at.desc,id.desc`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const codes = (result.json as { code: string }[]).map((row) => row.code);
    expect(codes).toEqual(["LTC-102"]);
    // ตัวชี้วัด semantics: ถ้า PostgREST OR ทับกัน LTC-104 (published_at = sortKey, id < id106)
    // จะหลุดเข้ามาแม้ title/summary ไม่มีคำ "ทนาย" — ต้องไม่เกิด
    expect(codes).not.toContain("LTC-104");
  });

  it("สาขา and(published_at.eq, id.lt) ของ cursor ทำงานจริง: code in (104,106) + cursor LTC-106 → LTC-104", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/courses?select=code,id,published_at&code=like.LTC-*&published_at=not.is.null` +
        `&or=(${encodeURIComponent("code.in.(LTC-104,LTC-106)")})` +
        `&or=(${encodeURIComponent(cursorFilterOf(sortKey, id106))})` +
        `&order=published_at.desc,id.desc`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    expect((result.json as { code: string }[]).map((row) => row.code)).toEqual(["LTC-104"]);
  });

  it("ground-truth SQL บน psql ให้ชุดเดียวกับ REST (ทีมอ่านวิธีได้จากที่นี่)", async () => {
    const rest = await restCall(
      "GET",
      `/rest/v1/courses?select=code,id,published_at&code=like.LTC-*&published_at=not.is.null` +
        `&or=(${encodeURIComponent(searchFilterOf(term))})` +
        `&or=(${encodeURIComponent(cursorFilterOf(sortKey, id106))})` +
        `&order=published_at.desc,id.desc`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(rest.status).toBe(200);
    const sql = `
      select c.code
      from public.courses c
      where c.code like 'LTC-%'
        and c.status = 'published'
        and c.is_public
        and c.published_at is not null
        and (c.title_th ilike '%${term}%' or c.title_en ilike '%${term}%' or c.summary ilike '%${term}%')
        and (
          c.published_at < '${sortKey}'::timestamptz
          or (c.published_at = '${sortKey}'::timestamptz and c.id < '${id106}'::uuid)
        )
      order by c.published_at desc, c.id desc;
    `;
    const groundTruth = (await psqlRows<{ code: string }>(sql)).map((row) => row.code);
    expect(groundTruth).toEqual(["LTC-102"]);
    expect(groundTruth).toEqual((rest.json as { code: string }[]).map((row) => row.code));
  });
});
