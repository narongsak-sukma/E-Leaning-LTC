/**
 * DocumentViewer — บทเรียนเอกสาร (SDS §3.3(c) — client attestation)
 *
 * - ปุ่ม "อ่านจบแล้ว" → saveLessonProgress (POST /api/v1/lessons/{id}/progress body { documentRead: true })
 *   (positionSeconds XOR documentRead — D12-12) · ห้ามส่ง flag `completed` (D12-1)
 * - เนื้อหาเอกสารจริงจาก lessons.content_md ผ่านหน้า learn (PB-12): ถ้าไม่มีเนื้อหาส่งมา
 *   ให้แสดงสถานะว่างภาษาไทยและยังไม่เปิดให้ยืนยันการอ่าน (DESIGN-SYSTEM §5.12)
 */
"use client";

import { useState } from "react";

import { saveLessonProgress } from "@/lib/fixtures/learning";

type AttestStatus = "idle" | "sending" | "done" | "error";

export function DocumentViewer({
  lessonId,
  documentTitle,
  paragraphs,
}: {
  lessonId: string;
  documentTitle: string;
  paragraphs: readonly string[];
}) {
  const [status, setStatus] = useState<AttestStatus>("idle");
  const hasContent = paragraphs.length > 0;

  const handleAttest = async () => {
    setStatus("sending");
    try {
      await saveLessonProgress(lessonId, { documentRead: true });
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div>
      <h3 className="font-heading text-lg font-bold text-ink-900">{documentTitle}</h3>
      {hasContent ? (
        <div className="mt-3 space-y-4 rounded-[14px] border border-mist-200 bg-white p-5 shadow-card">
          {paragraphs.map((paragraph, index) => (
            <p key={index} className="text-[15px] leading-8 text-ink-700">
              {paragraph}
            </p>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-[14px] border border-mist-200 bg-white p-6 text-center shadow-card">
          <p className="font-heading text-base font-semibold text-ink-900">
            เนื้อหาเอกสารของบทเรียนนี้ยังไม่เปิดใช้งาน
          </p>
          <p className="mt-1 text-sm text-ink-600">
            กรุณาลองเข้าใหม่ภายหลัง เมื่อระบบอัปเดตเนื้อหาแล้วจึงยืนยันการอ่านได้
          </p>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void handleAttest();
          }}
          disabled={status === "sending" || status === "done" || !hasContent}
          className="rounded-[10px] bg-brand-600 px-6 py-3 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
        >
          อ่านจบแล้ว
        </button>
        <p aria-live="polite" role="status" className="text-sm text-ink-600">
          {status === "sending" ? "กำลังส่งยืนยันการอ่าน..." : ""}
          {status === "done" ? "ส่งยืนยันการอ่านจบเรียบร้อย รอระบบตัดสินสถานะจบบทเรียน" : ""}
          {status === "error" ? "ส่งยืนยันไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" : ""}
        </p>
      </div>
    </div>
  );
}
