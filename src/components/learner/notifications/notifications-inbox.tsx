/**
 * NotificationsInbox — มุมมองทั้งหน้า /my/notifications (NTF-001 · lane D · client component)
 *
 * - โหลดรายการฝั่ง client (GET /api/v1/me/notifications?limit=20) เพื่อให้ปุ่ม "อ่านแล้ว"/
 *   "โหลดเพิ่ม" จัดการ state ท้องถิ่นได้ทันที (POST read → refresh local ตามสัญญาของ lane D)
 *   · BFF ยังไม่ deploy = แผง error ไทย + ปุ่มลองใหม่ (ไม่ crash ไม่แสดง stack)
 * - ปุ่ม "อ่านแล้ว" ต่อรายการ · "ทำเครื่องหมายทั้งหมดว่าอ่านแล้ว" เรียก POST read ต่อรายการ
 *   ตามลำดับ id ที่ยังไม่อ่าน (contract มีเฉพาะ per-id — ไม่มีเส้น read-all)
 * - โหลดเพิ่มใช้ next_cursor ต่อจาก response ก่อนหน้า (keyset — cursor opaque ห้ามแกะ)
 * - ทุกครั้งที่ read สำเร็จ ยิง event NOTIF_READ_CHANGED_EVENT ให้กระดิ่ง (header) รีเฟรช
 *   ป้ายทันทีโดยไม่ต้องรอรอบ poll 60 วินาที
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  NOTIF_READ_CHANGED_EVENT,
  getMyNotifications,
  markNotificationRead,
  type NotificationItemParsed,
  type NotificationsPageParsed,
} from "./api";
import { NotificationsEmpty } from "./notifications-empty";
import { NotificationsErrorPanel } from "./notifications-error-panel";
import { formatRelativeThai } from "./relative-time";
import { SeverityIcon } from "./severity-icon";

/** จำนวนรายการต่อหน้าที่ขอจาก BFF — ใช้กับทั้งหน้าแรกและ "โหลดเพิ่ม" */
const PAGE_SIZE = 20;

/** ปุ่มหลัก/รองของหน้า — แบบเดียวกับปุ่มของ repo (rounded-[10px] · font-heading · shadow-card) */
const BUTTON_PRIMARY =
  "rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500";
const BUTTON_SECONDARY =
  "rounded-[10px] border border-brand-600 bg-white px-4 py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:border-mist-300 disabled:text-ink-500";

/** ข้อความ error ของ action ที่ล้ม — ข้อความไทยจาก envelope ของ BFF (ApiError) เสมอ */
function actionErrorText(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
}

export function NotificationsInbox() {
  /** null = ยังโหลด · error = โหลดทั้งหน้าล้ม (BFF หาย/ขัดข้อง) · ready = มีข้อมูลให้แสดง */
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [items, setItems] = useState<readonly NotificationItemParsed[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  /** id ของรายการที่กำลังกด "อ่านแล้ว" (กันดับเบิลคลิกรายการเดียวกัน) */
  const [pendingReadId, setPendingReadId] = useState<string | null>(null);
  /** กัน setState หลัง unmount — fetch ค้างขณะผู้ใช้เปลี่ยนหน้า (แบบเดียวกับกระดิ่ง) */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** apply ผล GET ลง state — ทั้งหน้าแรก (replace) และ "โหลดเพิ่ม" (append กัน id ซ้ำ) */
  const applyLoadedPage = useCallback((page: NotificationsPageParsed, mode: "replace" | "append"): void => {
      if (mode === "replace") {
        setItems(page.items);
      } else {
        setItems((previous) => {
          const seen = new Set(previous.map((item) => item.id));
          const fresh = page.items.filter((item) => !seen.has(item.id));
          return [...previous, ...fresh];
        });
      }
      // เลขไม่อ่านที่โชว์ derive จากรายการที่โหลดแล้ว (visibleUnread) — ไม่เก็บ state ซ้ำ
      setNextCursor(page.next_cursor);
    },
    [],
  );

  const loadFirstPage = useCallback(async (): Promise<void> => {
    setPhase("loading");
    setActionErrorMessage(null);
    try {
      const page = await getMyNotifications({ limit: PAGE_SIZE });
      if (!mountedRef.current) {
        return;
      }
      applyLoadedPage(page, "replace");
      setPhase("ready");
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setPhase("error");
    }
  }, [applyLoadedPage]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  /** ปรับ read_at ของ id เดียว + บอกกระดิ่ง (เรียกหลัง POST read สำเร็จเท่านั้น) */
  const applyMarkedRead = useCallback((id: string): void => {
    const readAt = new Date().toISOString();
    setItems((previous) =>
      previous.map((item) =>
        item.id === id && item.read_at === null ? { ...item, read_at: readAt } : item,
      ),
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(NOTIF_READ_CHANGED_EVENT));
    }
  }, []);

  const handleReadOne = useCallback(
    async (id: string): Promise<void> => {
      setPendingReadId(id);
      setActionErrorMessage(null);
      try {
        await markNotificationRead(id);
        if (!mountedRef.current) {
          return;
        }
        applyMarkedRead(id);
        setPendingReadId(null);
      } catch (error: unknown) {
        if (!mountedRef.current) {
          return;
        }
        setActionErrorMessage(actionErrorText(error));
      } finally {
        setPendingReadId(null);
      }
    },
    [applyMarkedRead],
  );

  /**
   * ทำเครื่องหมายทั้งหมดว่าอ่านแล้ว — POST read ต่อรายการตามลำดับ id ที่ยังไม่อ่าน
   * (contract มีเฉพาะ per-id · ล้มกลางทาง = หยุดและแจ้งผู้ใช้ รายการที่สำเร็จแล้วคงอยู่)
   */
  const handleReadAll = useCallback(async (): Promise<void> => {
    setMarkingAll(true);
    setActionErrorMessage(null);
    const unreadIds = items
      .filter((item) => item.read_at === null)
      .map((item) => item.id)
      .sort();
    try {
      for (const id of unreadIds) {
        await markNotificationRead(id);
        if (!mountedRef.current) {
          return;
        }
        applyMarkedRead(id);
      }
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      setActionErrorMessage(actionErrorText(error));
    } finally {
      setMarkingAll(false);
    }
  }, [items, applyMarkedRead]);

  /** โหลดเพิ่ม — ส่ง next_cursor ต่อจาก response ก่อนหน้า (cursor opaque ห้ามแกะ) */
  const handleLoadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setActionErrorMessage(null);
    try {
      const page = await getMyNotifications({ limit: PAGE_SIZE, cursor: nextCursor });
      if (!mountedRef.current) {
        return;
      }
      applyLoadedPage(page, "append");
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      setActionErrorMessage(actionErrorText(error));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, applyLoadedPage]);

  if (phase === "loading") {
    return (
      <div
        role="status"
        className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
      >
        <p className="text-sm text-ink-600">กำลังโหลดการแจ้งเตือน...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <NotificationsErrorPanel
        onRetry={() => {
          void loadFirstPage();
        }}
      />
    );
  }

  const visibleUnread = items.filter((item) => item.read_at === null).length;

  return (
    <div>
      {actionErrorMessage !== null ? (
        <div
          role="alert"
          className="mt-5 rounded-[10px] border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {actionErrorMessage}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-600">
          {visibleUnread > 0 ? `ยังไม่ได้อ่าน ${visibleUnread} รายการ` : "คุณอ่านครบทุกรายการแล้ว"}
        </p>
        {visibleUnread > 0 ? (
          <button
            type="button"
            data-testid="notif-read-all"
            onClick={() => {
              void handleReadAll();
            }}
            disabled={markingAll}
            className={BUTTON_PRIMARY}
          >
            {markingAll ? "กำลังตั้งค่าให้อ่านแล้ว..." : "ทำเครื่องหมายทั้งหมดว่าอ่านแล้ว"}
          </button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <NotificationsEmpty />
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((item) => (
            <NotificationsListItem
              key={item.id}
              item={item}
              pending={pendingReadId === item.id}
              onRead={() => {
                void handleReadOne(item.id);
              }}
            />
          ))}
        </ul>
      )}

      {nextCursor !== null && items.length > 0 ? (
        <div className="mt-5 text-center">
          <button
            type="button"
            data-testid="notif-load-more"
            onClick={() => {
              void handleLoadMore();
            }}
            disabled={loadingMore}
            className={BUTTON_SECONDARY}
          >
            {loadingMore ? "กำลังโหลด..." : "โหลดเพิ่ม"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** แถวแจ้งเตือนหนึ่งรายการ — จุดแดงเมื่อไม่อ่าน · ไอคอน severity · เวลาสัมพัทธ์ไทย · ปุ่มอ่านแล้ว */
function NotificationsListItem({
  item,
  pending,
  onRead,
}: {
  item: NotificationItemParsed;
  pending: boolean;
  onRead: () => void;
}) {
  const unread = item.read_at === null;
  return (
    <li
      data-testid="notif-item"
      className={`flex gap-3 rounded-[14px] border bg-white p-4 shadow-card sm:px-5 ${
        unread ? "border-brand-200" : "border-mist-200"
      }`}
    >
      <SeverityIcon severity={item.severity} wrapperClassName="self-start mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={`text-sm ${unread ? "font-bold text-ink-900" : "font-semibold text-ink-700"}`}>
            {item.title}
          </p>
          {unread ? (
            <span
              data-testid="notif-unread-badge"
              className="inline-block h-2.5 w-2.5 rounded-full bg-danger-600"
            >
              <span className="sr-only">ยังไม่ได้อ่าน</span>
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-ink-600">{item.body}</p>
        <p className="mt-1.5 text-xs text-ink-400">
          {formatRelativeThai(item.created_at, new Date())}
        </p>
      </div>
      {unread ? (
        <button
          type="button"
          data-testid="notif-read-btn"
          onClick={onRead}
          disabled={pending}
          className="self-start whitespace-nowrap rounded-[8px] border border-brand-600 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:border-mist-300 disabled:text-ink-500"
        >
          {pending ? "กำลังตั้งค่า..." : "อ่านแล้ว"}
        </button>
      ) : (
        <span className="self-start whitespace-nowrap text-xs text-success-600">อ่านแล้ว</span>
      )}
    </li>
  );
}
