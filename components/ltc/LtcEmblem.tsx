"use client";

import React from "react";

export function LtcEmblem({
  size = 42,
  variant = "navy",
}: {
  size?: number;
  variant?: "navy" | "gold" | "light";
}) {
  const bgClass =
    variant === "gold"
      ? "bg-gradient-to-br from-[#e2b857] to-[#a97c22] text-[#0b1f3a] border-[#e2b857]/40"
      : variant === "light"
        ? "bg-white/10 text-[#e2b857] border-white/20"
        : "bg-gradient-to-br from-[#0b1f3a] to-[#1a4373] text-[#e2b857] border-[#c89b3c]/40";

  return (
    <div
      style={{ width: size, height: size }}
      className={`rounded-xl flex items-center justify-center border shadow-sm shrink-0 ${bgClass}`}
      aria-hidden="true"
    >
      <svg
        width={Math.round(size * 0.56)}
        height={Math.round(size * 0.56)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v18" />
        <path d="M5 7h14" />
        <path d="M5 7l-3 6h6l-3-6z" />
        <path d="M19 7l-3 6h6l-3-6z" />
        <path d="M8 21h8" />
      </svg>
    </div>
  );
}

export function formatThaiDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const months = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];
  const day = d.getDate();
  const month = months[d.getMonth()] ?? "";
  const yearBuddhist = d.getFullYear() + 543;
  return `${day} ${month} ${yearBuddhist}`;
}

export function formatThaiDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatThaiDate(iso)} · ${hh}:${mm} น.`;
}

export const ROLE_LABELS_TH: Record<string, string> = {
  citizen: "ประชาชนทั่วไป (Citizen)",
  lawyer: "ทนายความ (Lawyer)",
  instructor: "วิทยากรผู้สอน (Instructor)",
  "staff:viewer": "เจ้าหน้าที่ตรวจสอบ (Viewer)",
  "staff:content": "เจ้าหน้าที่ฝ่ายเนื้อหาหลักสูตร (Content)",
  "staff:exam": "เจ้าหน้าที่ฝ่ายคลังข้อสอบ (Exam)",
  "staff:registrar": "นายทะเบียนสภาทนายความ (Registrar)",
  super_admin: "ผู้ดูแลระบบสูงสุด (Super Admin)",
};
