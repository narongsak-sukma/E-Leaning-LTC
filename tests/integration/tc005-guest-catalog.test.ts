/**
 * TC-005 — guest (anon) เห็นเฉพาะหลักสูตร published เท่านั้น (draft มองไม่เห็น)
 *
 * วิธีทดสอบ: REST จริงผ่าน Kong (:8000) ด้วย apikey ของ anon (ไม่มี Bearer = guest)
 * → PostgREST → RLS policy `courses_public_read` (0010_security.sql):
 *     status = 'published' and (is_public or has_any_role(array['lawyer']))
 *   guest ไม่มี role → เห็นเฉพาะ published **และ** is_public
 * seed (D25-O3): published+public = LTC-101/102/104/106, published+private = LTC-103/105, draft = LTC-DRAFT-001
 */
import { describe, expect, it } from "vitest";
import { ANON_KEY, SERVICE_KEY, restCall } from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

interface CourseRow {
  readonly code: string;
  readonly status: string;
  readonly is_public: boolean;
  readonly published_at: string | null;
}

/** guest ต้องเห็นเฉพาะ 4 หลักสูตร published+public ของ seed (เรียงตาม code) — scope ด้วย code like LTC-* เพื่อรองรับ dev DB ที่มีข้อมูลอื่นร่วมด้วย */
const GUEST_VISIBLE = ["LTC-101", "LTC-102", "LTC-104", "LTC-106"] as const;

/** รายการหลักสูตรที่ guest เห็น (scope ตามรหัส seed LTC-* — dev DB มีข้อมูลทดสอบอื่นของเพื่อนร่วมทีมร่วมอยู่) */
async function guestListCourses(): Promise<CourseRow[]> {
  const result = await restCall(
    "GET",
    "/rest/v1/courses?select=code,status,is_public,published_at&code=like.LTC-*&order=code.asc",
    { apiKey: ANON_KEY },
  );
  expect(result.status, `REST status ${result.status}: ${result.text.slice(0, 200)}`).toBe(200);
  return result.json as CourseRow[];
}

describe.skipIf(!DB_URL)("TC-005 guest catalog — เห็นเฉพาะ published", () => {
  it("guest เห็นเฉพาะ 4 หลักสูตร published + is_public (ครบและไม่เกิน)", async () => {
    const rows = await guestListCourses();
    expect(rows.map((row) => row.code).sort()).toEqual([...GUEST_VISIBLE]);
  });

  it("ทุกแถวที่ guest เห็นต้อง published + is_public + published_at ไม่ null", async () => {
    for (const row of await guestListCourses()) {
      expect(row.status).toBe("published");
      expect(row.is_public).toBe(true);
      expect(row.published_at).not.toBeNull();
    }
  });

  it("draft (LTC-DRAFT-001) มีอยู่จริงใน DB แต่ guest มองไม่เห็น (RLS กรอง ไม่ใช่ seed ขาด)", async () => {
    const hidden = await restCall(
      "GET",
      "/rest/v1/courses?select=code&code=eq.LTC-DRAFT-001",
      { apiKey: ANON_KEY },
    );
    expect(hidden.status).toBe(200);
    expect(hidden.json).toEqual([]); // RLS กรองออกหมด

    // พิสูจน์ว่าแถว draft มีอยู่จริงในตารางฐาน (service_role bypass RLS — ส่งคีย์ทั้ง apikey และ Bearer)
    const exists = await restCall(
      "GET",
      "/rest/v1/courses?select=code&code=eq.LTC-DRAFT-001",
      { apiKey: SERVICE_KEY, token: SERVICE_KEY },
    );
    expect(exists.status).toBe(200);
    expect((exists.json as { code: string }[]).map((row) => row.code)).toEqual(["LTC-DRAFT-001"]);
  });

  it("published แต่ is_public=false (LTC-103, LTC-105) guest มองไม่เห็นเช่นกัน", async () => {
    for (const code of ["LTC-103", "LTC-105"]) {
      const hidden = await restCall(
        "GET",
        `/rest/v1/courses?select=code&code=eq.${code}`,
        { apiKey: ANON_KEY },
      );
      expect(hidden.status, `GET ${code}`).toBe(200);
      expect(hidden.json, `${code} ต้องไม่ถูก guest เห็น`).toEqual([]);
    }
  });

  it("ผู้เรียนทั่วไป (citizen) เห็นชุดเดียวกับ guest — ไม่มี role lawyer", async () => {
    const { createTestUser, deleteTestUser } = await import("./helpers.js");
    const user = await createTestUser("c9-tc005", "citizen");
    try {
      const result = await restCall(
        "GET",
        "/rest/v1/courses?select=code&code=like.LTC-*&order=code.asc",
        { token: user.accessToken },
      );
      expect(result.status).toBe(200);
      expect((result.json as { code: string }[]).map((row) => row.code)).toEqual([...GUEST_VISIBLE]);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
