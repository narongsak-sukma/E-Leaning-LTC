/**
 * relative-time.test — pure function ไม่มี dependency — ทดสอบตรง ๆ (แบบแผนของ repo)
 * ครอบทุกชั้นเวลาตามสัญญา: วินาที/นาที/ชั่วโมง/วัน/เดือน/ปี + เส้นแบ่ง inclusive/exclusive
 * + เวลาอนาคต (เพดาน "เมื่อสักครู่") + วันที่เสีย ("—")
 */
import { describe, expect, it } from "vitest";

import { formatRelativeThai } from "./relative-time";

/** now อ้างอิงกลาง — 2026-09-12T10:00:00Z */
const NOW = new Date("2026-09-12T10:00:00Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe("formatRelativeThai — เวลาสัมพัทธ์ภาษาไทย (NTF-001)", () => {
  it("ช่วงวินาที (< 1 นาที) → เมื่อสักครู่", () => {
    expect(formatRelativeThai("2026-09-12T09:59:59Z", NOW)).toBe("เมื่อสักครู่");
    expect(formatRelativeThai("2026-09-12T10:00:00Z", NOW)).toBe("เมื่อสักครู่");
  });

  it("เส้นแบ่ง 1 นาที — 59 วินาที = เมื่อสักครู่ · 60 วินาที = 1 นาทีที่แล้ว", () => {
    expect(formatRelativeThai(minutesAgo(0.98), NOW)).toBe("เมื่อสักครู่");
    expect(formatRelativeThai(minutesAgo(1), NOW)).toBe("1 นาทีที่แล้ว");
    expect(formatRelativeThai(minutesAgo(30), NOW)).toBe("30 นาทีที่แล้ว");
    expect(formatRelativeThai(minutesAgo(59), NOW)).toBe("59 นาทีที่แล้ว");
  });

  it("ชั่วโมง — 60 นาที = 1 ชั่วโมงที่แล้ว · 23 ชั่วโมง · 24 ชั่วโมงขึ้นไปข้ามไปวัน", () => {
    expect(formatRelativeThai(minutesAgo(60), NOW)).toBe("1 ชั่วโมงที่แล้ว");
    expect(formatRelativeThai(hoursAgo(3), NOW)).toBe("3 ชั่วโมงที่แล้ว");
    expect(formatRelativeThai(hoursAgo(23), NOW)).toBe("23 ชั่วโมงที่แล้ว");
    expect(formatRelativeThai(hoursAgo(24), NOW)).toBe("1 วันที่แล้ว");
  });

  it("วัน — 2 วัน · 29 วัน · 30 วันขึ้นไปข้ามไปเดือน", () => {
    expect(formatRelativeThai(daysAgo(2), NOW)).toBe("2 วันที่แล้ว");
    expect(formatRelativeThai(daysAgo(29), NOW)).toBe("29 วันที่แล้ว");
    expect(formatRelativeThai(daysAgo(30), NOW)).toBe("1 เดือนที่แล้ว");
  });

  it("เดือน — 3 เดือน · 11 เดือน · 365 วันขึ้นไปข้ามไปวันที่แบบพุทธศักราช", () => {
    expect(formatRelativeThai(daysAgo(95), NOW)).toBe("3 เดือนที่แล้ว");
    expect(formatRelativeThai(daysAgo(364), NOW)).toBe("12 เดือนที่แล้ว");
  });

  it("ปี — ≥ 365 วัน แสดงวันที่จริงแบบพุทธศักราช (เดือนไทย + พ.ศ.)", () => {
    expect(formatRelativeThai("2024-03-05T03:30:00Z", NOW)).toMatch(/มีนาคม/);
    expect(formatRelativeThai("2024-03-05T03:30:00Z", NOW)).toMatch(/2567/);
  });

  it("เวลาอนาคต (นาฬิกาเครื่องผู้ใช้เพี้ยน) = เพดาน เมื่อสักครู่ — ไม่แสดงเวลาติดลบ", () => {
    expect(formatRelativeThai("2026-09-13T10:00:00Z", NOW)).toBe("เมื่อสักครู่");
    expect(formatRelativeThai("2027-01-01T00:00:00Z", NOW)).toBe("เมื่อสักครู่");
  });

  it("วันที่เสีย = — ไม่ throw", () => {
    expect(formatRelativeThai("not-a-date", NOW)).toBe("—");
    expect(formatRelativeThai("", NOW)).toBe("—");
  });

  it("offset timezone (+07:00) ใช้ได้เหมือน Z", () => {
    expect(formatRelativeThai("2026-09-12T17:00:00+07:00", NOW)).toBe("เมื่อสักครู่");
  });
});
