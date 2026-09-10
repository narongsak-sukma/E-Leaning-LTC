/**
 * DocumentViewer — บทเรียนเอกสาร (SDS §3.3(c) — client attestation)
 * ปุ่ม "อ่านจบแล้ว" → POST /api/v1/lessons/{id}/progress body { documentRead: true }
 * (positionSeconds XOR documentRead — D12-12) · ห้ามส่ง `completed` (D12-1)
 */
"use client";

import { useState } from "react";

import { lessonProgressUrl, type SendAttestationFn } from "@/lib/fixtures/learning";

type AttestStatus = "idle" | "sending" | "done" | "error";

export function DocumentViewer({
  lessonId,
  documentTitle,
  paragraphs,
  sendAttestation,
}: {
  lessonId: string;
  documentTitle: string;
  paragraphs: readonly string[];
  sendAttestation?: SendAttestationFn;
}) {
  const [status, setStatus] = useState<AttestStatus>("idle");

  const handleAttest = async () => {
    setStatus("sending");
    try {
      if (sendAttestation) {
        await sendAttestation();
      } else {
        const response = await fetch(lessonProgressUrl(lessonId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentRead: true }),
        });
        if (!response.ok) {
          throw new Error(`progress ${response.status}`);
        }
      }
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div>
      <h3 className="font-heading text-lg font-bold text-ink-900">{documentTitle}</h3>
      <div className="mt-3 space-y-4 rounded-[14px] border border-mist-200 bg-white p-5 shadow-card">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="text-[15px] leading-8 text-ink-700">
            {paragraph}
          </p>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void handleAttest();
          }}
          disabled={status === "sending" || status === "done"}
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
