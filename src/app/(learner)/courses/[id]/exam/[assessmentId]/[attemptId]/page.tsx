/**
 * ห้องสอบ (/courses/[id]/exam/[assessmentId]/[attemptId]) — ธง lead ข้อ 2
 *
 * - หน้าเปล่าไร้ข้อมูลฝั่ง server (ชุดข้ออยู่ในแคชในหน่วยความจำของแท็บเท่านั้น
 *   ตามธง D37-6 ก - ห้าม persistence/re-fetch จาก client ในทางใด)
 * - ExamRoom (client) อ่านแคชด้วย attemptId จาก URL - ไม่พบ (reload กลางสอบ) =
 *   fail-closed แสดงแผงติดต่อเจ้าหน้าที่ (ธง D37-6 ค)
 */
import type { Metadata } from "next";

import { ExamRoom } from "@/components/learner/exam/exam-room";

export const metadata: Metadata = {
  title: "ห้องสอบ — ระบบฝึกอบรมออนไลน์",
  robots: { index: false, follow: false },
};

export default async function ExamRoomPage({
  params,
}: {
  params: Promise<{ id: string; assessmentId: string; attemptId: string }>;
}) {
  const { attemptId } = await params;
  return <ExamRoom attemptId={attemptId} />;
}
