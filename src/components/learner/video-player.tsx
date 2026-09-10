/**
 * VideoPlayer — DESIGN-SYSTEM §6.2 · SDS §3.3(b)
 * heartbeat ทุก heartbeatIntervalSec (config VIDEO_HEARTBEAT_SEC) → POST { positionSeconds }
 * เริ่มจับเมื่อ play · หยุดเมื่อ pause · cleanup ตอนออกจากหน้า · ห้ามส่ง `completed` (D12-1)
 */
"use client";

import { useCallback, useRef, useState } from "react";

import { useVideoHeartbeat, type SyncStatus } from "./use-video-heartbeat";

/** ฟอร์แมตเวลา mm:ss (tabular-nums ตาม DS §3.3) */
function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

const SYNC_TEXT: Record<SyncStatus, string> = {
  idle: "ยังไม่เริ่มบันทึกความคืบหน้า",
  saving: "กำลังบันทึกความคืบหน้า...",
  saved: "บันทึกความคืบหน้าการเรียนเรียบร้อย",
  error: "บันทึกความคืบหน้าไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ",
};

export function VideoPlayer({
  lessonId,
  title,
  src,
  durationSeconds,
  initialPositionSeconds,
  heartbeatIntervalSec,
}: {
  lessonId: string;
  title: string;
  src: string | null;
  durationSeconds: number;
  initialPositionSeconds: number;
  heartbeatIntervalSec: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [positionSeconds, setPositionSeconds] = useState(initialPositionSeconds);
  const [isPlaying, setIsPlaying] = useState(false);

  const getPositionSeconds = useCallback((): number | null => {
    const element = videoRef.current;
    if (!element || !Number.isFinite(element.currentTime) || element.currentTime <= 0) {
      return null;
    }
    return element.currentTime;
  }, []);

  const { syncStatus, savedAt } = useVideoHeartbeat({
    lessonId,
    intervalSec: heartbeatIntervalSec,
    enabled: isPlaying,
    getPositionSeconds,
  });

  const handleLoadedMetadata = useCallback(() => {
    const element = videoRef.current;
    if (element && initialPositionSeconds > 0 && initialPositionSeconds < element.duration) {
      element.currentTime = initialPositionSeconds;
    }
  }, [initialPositionSeconds]);

  return (
    <div>
      <h3 className="font-heading text-lg font-bold text-ink-900">{title}</h3>
      <div className="mt-3 aspect-video w-full overflow-hidden rounded-[14px] bg-ink-900 shadow-card">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={`วิดีโอบทเรียน ${title}`}
            className="h-full w-full"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={(event) => setPositionSeconds(event.currentTarget.currentTime)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
        ) : (
          <p className="flex h-full items-center justify-center px-4 text-center text-sm text-mist-200">
            ยังไม่มีไฟล์วิดีโอสำหรับบทเรียนนี้
          </p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-600">
        <p aria-live="polite" role="status">
          {SYNC_TEXT[syncStatus]}
          {syncStatus === "saved" && savedAt
            ? ` (${new Date(savedAt).toLocaleTimeString("th-TH")})`
            : ""}
        </p>
        <p className="tabular-nums">
          ตำแหน่ง {formatClock(positionSeconds)} / {formatClock(durationSeconds)}
        </p>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        ระบบบันทึกความคืบหน้าอัตโนมัติทุก {heartbeatIntervalSec} วินาทีระหว่างรับชม — สถานะจบบทเรียนตัดสินโดยระบบ
      </p>
    </div>
  );
}
