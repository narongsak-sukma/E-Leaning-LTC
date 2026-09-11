/**
 * exam-timer.test — unit test ของคณิตนาฬิกาสอบ (ธง lead: timer จาก server เท่านั้น)
 *
 * - serverOffsetMsOf: offset = server - client · ISO ผิดรูป = null (fail-closed)
 * - remainingMsOf: remaining = deadline - (client + offset) · ผิดรูป = null
 * - examTimerTone: 15/5 นาที ตาม DS 7.1 · formatExamClock เป็น HH:MM:SS
 */
import { describe, expect, it } from "vitest";

import {
  clampRemainingMs,
  examTimerTone,
  formatExamClock,
  formatSavedAtTime,
  remainingMsOf,
  serverOffsetMsOf,
} from "./exam-timer";

const DEADLINE = "2026-09-10T09:00:00+07:00"; // 02:00:00 UTC

describe("serverOffsetMsOf", () => {
  it("คืน offset เป็น server ลบ client ณ จุดรับ response", () => {
    // client ช้ากว่า server 30 วินาที → offset = +30000
    const clientNow = Date.parse("2026-09-10T08:59:30+07:00");
    expect(serverOffsetMsOf("2026-09-10T09:00:00+07:00", clientNow)).toBe(30_000);
  });

  it("offset เป็นลบเมื่อนาฬิกา client วิ่งนำหน้า server", () => {
    const clientNow = Date.parse("2026-09-10T09:00:05+07:00");
    expect(serverOffsetMsOf("2026-09-10T09:00:00+07:00", clientNow)).toBe(-5_000);
  });

  it("ISO ผิดรูป = null (fail-closed ไม่เดาเป็น 0)", () => {
    expect(serverOffsetMsOf("not-a-date", 1_000)).toBeNull();
    expect(serverOffsetMsOf("", 1_000)).toBeNull();
  });
});

describe("remainingMsOf", () => {
  it("เหลือเวลา = deadline ลบ (client + offset) — อิงเวลา server แม้นาฬิกา client เพี้ยน", () => {
    // server เห็นเวลา 08:55:00+07:00 (เหลือ 5 นาที) แม้ client คิดว่าตัวเองเป็น 09:00:00
    const clientNow = Date.parse("2026-09-10T09:00:00+07:00");
    const offset = Date.parse("2026-09-10T08:55:00+07:00") - clientNow; // -5 นาที
    expect(remainingMsOf(DEADLINE, offset, clientNow)).toBe(5 * 60 * 1000);
  });

  it("หมดเวลา = ค่าติดลบ (ไม่ clamp ในชั้นคำนวณ)", () => {
    const clientNow = Date.parse("2026-09-10T09:10:00+07:00");
    expect(remainingMsOf(DEADLINE, 0, clientNow)).toBe(-10 * 60 * 1000);
  });

  it("deadline ผิดรูป = null (fail-closed)", () => {
    expect(remainingMsOf("garbage", 0, 1_000)).toBeNull();
  });
});

describe("clampRemainingMs / examTimerTone", () => {
  it("clamp ตัดลบเหลือ 0", () => {
    expect(clampRemainingMs(-1)).toBe(0);
    expect(clampRemainingMs(1_500)).toBe(1_500);
  });

  it("โทน normal เมื่อเหลือมากกว่า 15 นาที", () => {
    expect(examTimerTone(15 * 60 * 1000 + 1)).toBe("normal");
  });

  it("โทน warning เมื่อเหลือ ≤ 15 นาที และมากกว่า 5 นาที", () => {
    expect(examTimerTone(15 * 60 * 1000)).toBe("warning");
    expect(examTimerTone(5 * 60 * 1000 + 1)).toBe("warning");
  });

  it("โทน danger เมื่อเหลือ ≤ 5 นาที รวมถึงหมดเวลา", () => {
    expect(examTimerTone(5 * 60 * 1000)).toBe("danger");
    expect(examTimerTone(0)).toBe("danger");
    expect(examTimerTone(-100)).toBe("danger");
  });
});

describe("formatExamClock / formatSavedAtTime", () => {
  it("จัดรูป HH:MM:SS", () => {
    expect(formatExamClock(0)).toBe("00:00:00");
    expect(formatExamClock(59_999)).toBe("00:00:59");
    expect(formatExamClock(2 * 3600_000 + 5 * 60_000 + 9_000)).toBe("02:05:09");
    expect(formatExamClock(-1_000)).toBe("00:00:00");
  });

  it("savedAt ผิดรูป = null", () => {
    expect(formatSavedAtTime("junk")).toBeNull();
  });

  it("savedAt ถูกรูป = คืนข้อความเวลา (แปลงตามเขมาเครื่อง)", () => {
    const iso = "2026-09-10T03:00:00Z";
    expect(formatSavedAtTime(iso)).toBeTypeOf("string");
    expect(formatSavedAtTime(iso)?.length ?? 0).toBeGreaterThan(3);
  });
});
