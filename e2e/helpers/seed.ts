/**
 * e2e/helpers/seed.ts — อ่านข้อมูล seed จาก DB จริง (ไม่ hardcode UUID ใน spec)
 *
 * - หลักสูตร/บทเรียน/ควิซ resolve จาก code + sort_order ของ seed จริง (supabase/seed.sql)
 * - เฉลย (is_correct) อ่านฝั่ง harness เท่านั้น เพื่อให้ spec ตอบถูก/ผิดได้ —
 *   ไม่เคยถูก assert ว่า "ผู้เรียนเห็นเฉลย" — UI ต้องไม่มีเฉลย (C-7 guard อยู่ใน unit tests)
 */
import { psqlRows } from "./db";

export interface LessonFacts {
  readonly id: string;
  readonly type: "video" | "document" | "quiz";
  readonly durationSec: number | null;
}

export interface CourseFacts {
  readonly id: string;
  readonly code: string;
  readonly titleTh: string;
  readonly lessons: LessonFacts[];
}

interface CourseRow {
  readonly id: string;
  readonly code: string;
  readonly titleTh: string;
}

interface LessonRow {
  readonly id: string;
  readonly type: string;
  readonly durationSec: number | null;
}

export interface QuestionFacts {
  readonly questionText: string;
  readonly correctLabel: string;
  readonly wrongLabel: string;
}

const courseCache = new Map<string, CourseFacts>();

/** หลักสูตร + บทเรียน (เรียงตาม module/lesson sort_order — เหมือนที่ UI แสดง) */
export async function loadCourseFacts(code: string): Promise<CourseFacts> {
  const cached = courseCache.get(code);
  if (cached !== undefined) {
    return cached;
  }
  const rows = await psqlRows<CourseRow>(`
    select id::text as id, code, title_th as "titleTh"
    from public.courses where code = '${code}' and deleted_at is null limit 1;
  `);
  const course = rows[0];
  if (course === undefined) {
    throw new Error(`seed: ไม่พบหลักสูตร code=${code}`);
  }
  const lessonRows = await psqlRows<LessonRow>(`
    select l.id::text as id, l.type as type, l.duration_sec as "durationSec"
    from public.lessons l
    join public.course_modules m on m.id = l.module_id
    where m.course_id = '${course.id}' and l.deleted_at is null
    order by m.sort_order, l.sort_order;
  `);
  const facts: CourseFacts = {
    id: course.id,
    code: course.code,
    titleTh: course.titleTh,
    lessons: lessonRows.map((row) => ({
      id: row.id,
      type: row.type as LessonFacts["type"],
      durationSec: row.durationSec,
    })),
  };
  courseCache.set(code, facts);
  return facts;
}

/** เฉลยของควิซ (ข้อความตัวเลือกที่ถูก + ตัวเลือกที่ผิดตัวแรก) เรียงตามลำดับคำถาม */
export async function loadQuizFacts(lessonId: string): Promise<QuestionFacts[]> {
  const rows = await psqlRows<{ questionText: string; label: string; isCorrect: boolean }>(`
    select q.question_text as "questionText", o.option_text as label, o.is_correct as "isCorrect"
    from public.quiz_questions q
    join public.quiz_options o on o.question_id = q.id
    where q.quiz_id = (select quiz_id from public.lessons where id = '${lessonId}')
      and q.is_active
    order by q.sort_order, o.sort_order;
  `);
  const byQuestion = new Map<string, QuestionFacts>();
  for (const row of rows) {
    const existing = byQuestion.get(row.questionText);
    if (existing === undefined) {
      byQuestion.set(row.questionText, {
        questionText: row.questionText,
        correctLabel: row.isCorrect ? row.label : "",
        wrongLabel: row.isCorrect ? "" : row.label,
      });
    } else if (row.isCorrect && existing.correctLabel === "") {
      byQuestion.set(row.questionText, { ...existing, correctLabel: row.label });
    } else if (!row.isCorrect && existing.wrongLabel === "") {
      byQuestion.set(row.questionText, { ...existing, wrongLabel: row.label });
    }
  }
  return [...byQuestion.values()];
}
