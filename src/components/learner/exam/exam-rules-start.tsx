/**
 * ExamRulesStart — ปุ่มเริ่มสอบ + คำเตือนก่อนเข้าห้องสอบ (ธง D37-6 ข)
 *
 * - แสดงคำเตือน "ห้ามรีเฟรช/ปิดหน้า ระหว่างสอบ" ก่อนผู้เรียนกดเริ่มทุกครั้ง
 * - กดเริ่ม → startAttempt → เก็บชุดข้อ (ไร้เฉลย) ในแคชในหน่วยความจำ (exam-paper-cache)
 *   พร้อม offset นาฬิกาที่จับตอนรับ response แล้ว router.push เข้าห้องสอบ — ชุดข้อเดินทาง
 *   ใน JS context เดียวกันเท่านั้น (รีเฟรชกลางสอบ = แคชหาย = ห้องสอบ fail-closed ตามธง)
 * - ERR-ASM-002 (มี attempt ค้าง in_progress — ธง D37-6 ค): แสดงแผง "กรุณาติดต่อ
 *   เจ้าหน้าที่" และไม่มีปุ่มลองใหม่ — UI ไม่พยายาม resume/เปิดกระดาษด้วยวิธีอื่นเด็ดขาด
 * - ไม่มีเฉลยเข้าไฟล์นี้ทุกทาง (ธง lead ข้อ 3)
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { startAttempt, ExamApiError } from "@/lib/exam/exam-api";
import { storeExamPaper } from "@/lib/exam/exam-paper-cache";
import { serverOffsetMsOf } from "@/lib/exam/exam-timer";
import { errorDefinition } from "@/lib/errors";

/** สถานะของขั้นตอนเริ่มสอบ - idle / กำลังเริ่ม / ผิดพลาดที่จัดกลุ่มแล้ว */
type StartPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "error";
      /** contact_staff = attempt ค้าง (ธง D37-6) ห้ามลองใหม่ · blocked = ติดกติกา · retry = ลองใหม่ได้ */
      tone: "contact_staff" | "blocked" | "retry";
      title: string;
      message: string;
    };

/** ผลการจัดกลุ่ม error จาก BFF เป็นข้อความไทยสำหรับแสดงผล */
interface StartErrorView {
  readonly tone: "contact_staff" | "blocked" | "retry";
  readonly title: string;
  readonly message: string;
}

/** แผนที่ error ของ BFF เป็นข้อความไทย (ทะเบียน ERR-* ตาม src/lib/errors) */
function mapStartError(error: unknown): StartErrorView {
  if (error instanceof ExamApiError) {
    switch (error.code) {
      case "ERR-ASM-002":
        // ธง D37-6 ค: attempt ค้าง in_progress — ห้าม resume เอง ให้ติดต่อเจ้าหน้าที่
        return {
          tone: "contact_staff",
          title: "มีการสอบที่ยังไม่เสร็จอยู่ในระบบ",
          message:
            "ระบบพบการสอบของท่านที่ยังดำเนินการไม่จบอยู่ ระบบไม่สามารถเปิดห้องสอบซ้ำได้ " +
            "กรุณาหยุดการสอบครั้งนี้และติดต่อเจ้าหน้าที่สภาทนายความแห่งประเทศไทย " +
            "โทร 0 2351 1128 (จันทร์-ศุกร์ 8:30-16:30 น.) เพื่อให้เจ้าหน้าที่ช่วยดำเนินการ",
        };
      case "ERR-ASM-001":
        return {
          tone: "blocked",
          title: "ใช้สิทธิ์สอบครบตามกติกาแล้ว",
          message:
            "คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว ตรวจสอบผลการสอบได้ที่หน้าประวัติการสอบ",
        };
      case "ERR-ASM-007":
        // ASM-012 คู่พลัง open-on-pass ⇔ block-retake-on-pass (0049 — B3.5 ก่อน cooldown):
        // ผ่านแล้ว = สอบซ้ำไม่ได้ถาวร — ข้อความเต็มมาจาก registry แหล่งเดียว
        // (errorDefinition) ไม่ hardcode ซ้ำใน UI ให้เพี้ยนคนละทิศ (tone blocked เหมือน ASM-001)
        return {
          tone: "blocked",
          title: "ผ่านการสอบนี้แล้ว จึงสอบซ้ำไม่ได้",
          message: errorDefinition("ERR-ASM-007").message,
        };
      case "ERR-ASM-003":
        return {
          tone: "blocked",
          title: "ยังไม่สามารถเริ่มสอบได้",
          message:
            "การสอบนี้ยังไม่เปิดหรือไม่พบรายวิชา หรือยังไม่พ้นเวลารอระหว่างครั้ง " +
            "กรุณาตรวจสอบกติกาการสอบอีกครั้ง",
        };
      case "ERR-LRN-001":
      case "ERR-LRN-002":
        return {
          tone: "blocked",
          title: "ยังไม่มีสิทธิ์เข้าสอบ",
          message:
            "ต้องลงทะเบียนรายวิชาและเรียนให้ครบตามกติกาก่อนจึงจะเข้าสอบได้ " +
            "กรุณากลับไปเรียนบทเรียนให้ครบก่อน",
        };
      default:
        break;
    }
    if (error.status === 0 || error.status >= 500) {
      return {
        tone: "retry",
        title: "ขัดข้องชั่วคราว",
        message: "เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ผลให้ติดต่อเจ้าหน้าที่",
      };
    }
  }
  return {
    tone: "retry",
    title: "เริ่มสอบไม่สำเร็จ",
    message: "เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ผลให้ติดต่อเจ้าหน้าที่",
  };
}

export function ExamRulesStart({
  courseId,
  assessmentId,
  attemptsUsed,
  maxAttempts,
}: {
  /** id รายวิชาจาก URL (ของ route [id]) — ใช้ประกอบลิงก์เข้าห้องสอบ */
  readonly courseId: string;
  readonly assessmentId: string;
  /** จำนวนครั้งที่ใช้ไปจาก BFF (null = ไม่ทราบแน่ชัด เพราะประวัติยังมีหน้าถัดไป) */
  readonly attemptsUsed: number | null;
  readonly maxAttempts: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<StartPhase>({ kind: "idle" });

  const handleStart = async (): Promise<void> => {
    if (phase.kind === "starting") {
      return;
    }
    setPhase({ kind: "starting" });
    try {
      const session = await startAttempt(assessmentId);
      const offset = serverOffsetMsOf(session.serverTime, Date.now());
      if (offset === null) {
        // serverTime ผ่าน strict validator แล้ว จึงเกิดยากมาก แต่ถ้าเกิด = fail-closed
        setPhase({
          kind: "error",
          tone: "retry",
          title: "เวลาของระบบผิดรูปแบบ",
          message:
            "ระบบได้รับเวลาสอบที่ไม่ถูกต้องจากเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง " +
            "หากยังไม่ได้ผลให้ติดต่อเจ้าหน้าที่",
        });
        return;
      }
      // ธง D37-6 (ก): ชุดข้อพักในหน่วยความจำของแท็บเท่านั้น ห้าม persistence ใด ๆ
      storeExamPaper({ session, serverOffsetMs: offset });
      router.push(`/courses/${courseId}/exam/${assessmentId}/${session.attemptId}`);
    } catch (error: unknown) {
      const view = mapStartError(error);
      setPhase({ kind: "error", tone: view.tone, title: view.title, message: view.message });
    }
  };

  return (
    <section className="mt-8 rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
      <h2 className="font-heading text-lg font-bold text-ink-900">ยืนยันการเริ่มสอบ</h2>

      {/* ธง D37-6 (ข): เตือนก่อนเริ่มสอบเสมอ */}
      <div className="mt-4 rounded-[10px] bg-warning-50 p-4 text-sm text-ink-700" role="note">
        <p className="font-semibold text-warning-600">โปรดอ่านก่อนกดเริ่มสอบ</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong className="font-semibold">
              ห้ามรีเฟรช ปิด หรือเปลี่ยนหน้าเว็บ ระหว่างสอบโดยเด็ดขาด
            </strong>{" "}
            หากรีเฟรชหรือปิดหน้า ระบบจะไม่สามารถเปิดชุดข้อสอบคืนให้ได้
          </li>
          <li>ระบบบันทึกคำตอบให้อัตโนมัติระหว่างทำ แต่ต้องกดปุ่มส่งข้อสอบเพื่อจบการสอบ</li>
          <li>เวลาสอบนับจากนาฬิกาของระบบ ไม่ใช่เวลาที่แสดงบนเครื่องของท่าน</li>
          <li>
            เมื่อกด &ldquo;เริ่มสอบ&rdquo; ถือว่าใช้สิทธิ์สอบ 1 ครั้งทันที
            {attemptsUsed !== null ? (
              <> (ใช้ไปแล้ว {attemptsUsed} จาก {maxAttempts} ครั้ง)</>
            ) : null}
          </li>
        </ul>
      </div>

      {phase.kind === "error" ? (
        phase.tone === "contact_staff" ? (
          <div className="mt-4 rounded-[10px] bg-danger-50 p-4 text-sm text-danger-600" role="alert">
            <p className="font-semibold">{phase.title}</p>
            <p className="mt-1">{phase.message}</p>
            <Link
              href="/my/exams"
              className="mt-3 inline-flex rounded-[10px] border border-danger-100 bg-white px-4 py-2 text-sm font-semibold text-danger-600 hover:bg-danger-100"
            >
              ไปที่ประวัติการสอบ
            </Link>
          </div>
        ) : phase.tone === "blocked" ? (
          <div className="mt-4 rounded-[10px] bg-danger-50 p-4 text-sm text-danger-600" role="alert">
            <p className="font-semibold">{phase.title}</p>
            <p className="mt-1">{phase.message}</p>
          </div>
        ) : (
          <div className="mt-4 rounded-[10px] bg-danger-50 p-4 text-sm text-danger-600" role="alert">
            <p className="font-semibold">{phase.title}</p>
            <p className="mt-1">{phase.message}</p>
            <button
              type="button"
              onClick={() => {
                setPhase({ kind: "idle" });
              }}
              className="mt-3 inline-flex rounded-[10px] border border-danger-100 bg-white px-4 py-2 text-sm font-semibold text-danger-600 hover:bg-danger-100"
            >
              ลองอีกครั้ง
            </button>
          </div>
        )
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {/* ธง D37-6 ค: attempt ค้าง (contact_staff) = ซ่อนปุ่มเริ่มสอบเด็ดขาด
            ห้ามให้ผู้เรียนยิง start ซ้ำได้ — บล็อก (กติกา) ยังแสดงได้เพราะผู้เรียน
            อาจกลับมามีสิทธิ์ใหม่หลังเรียนจบ/พ้น cooldown โดยไม่ต้องรีเฟรชหน้า */}
        {phase.kind === "error" && phase.tone === "contact_staff" ? null : (
          <button
            type="button"
            onClick={() => {
              void handleStart();
            }}
            disabled={phase.kind === "starting"}
            className="rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
          >
            {phase.kind === "starting" ? "กำลังเตรียมชุดข้อสอบ..." : "เริ่มสอบ"}
          </button>
        )}
        <Link
          href={`/courses/${courseId}`}
          className="text-sm font-semibold text-brand-600 hover:text-brand-700"
        >
          กลับหน้ารายวิชา
          <span className="sr-only">หลีกเลี่ยงการเริ่มสอบ หากยังไม่พร้อม</span>
        </Link>
      </div>
    </section>
  );
}
