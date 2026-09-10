/**
 * useVideoHeartbeat — heartbeat วิดีโอ (SDS §3.3(b))
 *
 * ทุก `intervalSec` → saveLessonProgress (POST /api/v1/lessons/{id}/progress body { positionSeconds })
 * เริ่มจับเมื่อ play · หยุดเมื่อ pause/unmount (clearInterval) · ห้ามส่ง flag `completed` (D12-1)
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { saveLessonProgress } from "@/lib/fixtures/learning";

export type SyncStatus = "idle" | "saving" | "saved" | "error";

interface Options {
  lessonId: string;
  intervalSec: number; // จาก config VIDEO_HEARTBEAT_SEC (server ส่งเป็น prop)
  enabled: boolean; // true เฉพาะตอนเล่น
  getPositionSeconds: () => number | null;
}

export function useVideoHeartbeat({ lessonId, intervalSec, enabled, getPositionSeconds }: Options) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // ref กัน interval restart ทุกครั้งที่ตำแหน่งเลื่อน
  const getPositionRef = useRef(getPositionSeconds);
  useEffect(() => {
    getPositionRef.current = getPositionSeconds;
  });

  const sendHeartbeat = useCallback(async () => {
    const position = getPositionRef.current();
    if (position === null) {
      return;
    }
    setSyncStatus("saving");
    try {
      await saveLessonProgress(lessonId, { positionSeconds: Math.floor(position) });
      setSavedAt(new Date().toISOString());
      setSyncStatus("saved");
    } catch {
      setSyncStatus("error");
    }
  }, [lessonId]);

  useEffect(() => {
    if (!enabled || intervalSec <= 0) {
      return;
    }
    const timer = setInterval(() => {
      void sendHeartbeat();
    }, intervalSec * 1000);
    return () => {
      clearInterval(timer);
    };
  }, [enabled, intervalSec, sendHeartbeat]);

  return { syncStatus, savedAt };
}
