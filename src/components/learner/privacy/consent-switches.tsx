"use client";

/**
 * ConsentSwitches — สวิตช์ความยินยอมเสริมของหน้า my/privacy (D-p5-13 item 2 · lane E)
 *
 * - โหลดค่าจริงจาก GET /profile/consents ตอน mount (missing type = ปิด — conservative
 *   default ตาม append-only table: ไม่มีแถว granted ล่าสุด = ไม่ได้ยินยอม)
 * - toggle หนึ่งรายการ → PATCH /profile/consents { type, action } ทีละ type ตามสัญญา
 *   · สำเร็จ → อัปเดตสถานะจาก response {type,status} (ไม่ optimistic — สวิตช์แสดงค่าจาก
 *   server เสมอ กันจอเพี้ยนถ้า PATCH ล้ม) · ล้ม → คงสถานะเดิม + ข้อความไทย role=alert
 * - section notice_acknowledgments อ่านอย่างเดียว — แสดงข้อความกำกับ (append-only)
 *
 * ลำดับ useState (ผูกกับ test — ห้ามสลับ): 1 phase · 2 items · 3 pendingType · 4 status
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CONSENT_TYPES,
  getMyConsents,
  updateMyConsent,
  type ConsentEntryParsed,
  type ConsentType,
} from "./api";

/** ป้ายไทย + คำอธิบายของแต่ละ type (D12-17 — optional consents) */
export const CONSENT_LABELS: Record<ConsentType, { readonly label: string; readonly hint: string }> = {
  marketing: {
    label: "รับข่าวสารและกิจกรรมการอบรม",
    hint: "ยินยอมให้สภาทนายความฯ ส่งข่าวสารหรือกิจกรรมฝึกอบรมที่ไม่ใช่ธุรกรรมบังคับทางอีเมล",
  },
  email_notify: {
    label: "รับการแจ้งเตือนทางอีเมล",
    hint: "ยินยอมให้ระบบส่งการแจ้งเตือนบางประเภททางอีเมล นอกจากการแจ้งเตือนในระบบ",
  },
};

/** สถานะบนจอของสวิตช์แต่ละ type — จากแถวล่าสุดของ server */
export interface ConsentItemState {
  readonly granted: boolean;
  readonly updatedAt: string | null;
}

/**
 * แผนที่ type → สถานะ — missing type = revoked (ไม่ได้ยินยอม) ตาม append-only
 * (route เดิมคืนเฉพาะแถว active ของ optional types — ไม่มีแถว = ไม่เคยให้)
 */
export function deriveConsentState(
  view: { readonly consents: readonly ConsentEntryParsed[] },
): Record<ConsentType, ConsentItemState> {
  const out = {} as Record<ConsentType, ConsentItemState>;
  for (const type of CONSENT_TYPES) {
    out[type] = { granted: false, updatedAt: null };
  }
  for (const entry of view.consents) {
    out[entry.type] = { granted: entry.status === "granted", updatedAt: entry.updated_at };
  }
  return out;
}

/** สถานะการเปลี่ยนล่าสุด — role=status/alert คงอยู่จน action ถัดไป (repo ไม่มี toast library) */
interface SwitchStatus {
  readonly kind: "success" | "error";
  readonly message: string;
}

/** ข้อความ error จาก envelope ของ BFF (ApiError) — fallback ไทยเมื่อไม่มี message */
function switchErrorText(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    (error as { message: string }).message.length > 0
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}

export function ConsentSwitches() {
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [items, setItems] = useState<Record<ConsentType, ConsentItemState> | null>(null);
  const [pendingType, setPendingType] = useState<ConsentType | null>(null);
  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadConsents = useCallback(async (): Promise<void> => {
    setPhase("loading");
    try {
      const view = await getMyConsents();
      if (!mountedRef.current) {
        return;
      }
      setItems(deriveConsentState(view));
      setPhase("ready");
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadConsents();
  }, [loadConsents]);

  /** toggle หนึ่ง type — PATCH ทันที (สัญญาทีละ type) · กันซ้อน: มี pending อยู่ = ไม่ทำอะไร */
  const handleToggle = useCallback(async (type: ConsentType, next: boolean): Promise<void> => {
    if (pendingType !== null) {
      return;
    }
    setPendingType(type);
    setStatus(null);
    try {
      const row = await updateMyConsent(type, next ? "grant" : "revoke");
      if (!mountedRef.current) {
        return;
      }
      setItems((previous) => {
        if (previous === null) {
          return previous;
        }
        return { ...previous, [row.type]: { granted: row.status === "granted", updatedAt: new Date().toISOString() } };
      });
      setStatus({ kind: "success", message: "บันทึกความยินยอมเรียบร้อยแล้ว" });
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      setStatus({
        kind: "error",
        message: switchErrorText(error, "เปลี่ยนความยินยอมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"),
      });
    } finally {
      setPendingType(null);
    }
  }, [pendingType]);

  if (phase === "loading") {
    return (
      <section aria-labelledby="consents-heading" className="mt-6">
        <h2 id="consents-heading" className="font-heading text-lg font-semibold text-ink-900">ความยินยอมเสริม</h2>
        <div role="status" className="mt-3 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card">
          <p className="text-sm text-ink-600">กำลังโหลดความยินยอม...</p>
        </div>
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section aria-labelledby="consents-heading" className="mt-6">
        <h2 id="consents-heading" className="font-heading text-lg font-semibold text-ink-900">ความยินยอมเสริม</h2>
        <div role="alert" className="mt-3 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center">
          <p className="font-heading text-base font-semibold text-danger-700">โหลดความยินยอมไม่สำเร็จ</p>
          <p className="mt-1 text-sm text-danger-600">กรุณาลองอีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่</p>
          <button
            type="button"
            data-testid="consents-retry"
            onClick={() => {
              void loadConsents();
            }}
            className="mt-4 rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
          >
            ลองอีกครั้ง
          </button>
        </div>
      </section>
    );
  }

  const view = items;
  if (view === null) {
    return null;
  }

  return (
    <section aria-labelledby="consents-heading" className="mt-6">
      <h2 id="consents-heading" className="font-heading text-lg font-semibold text-ink-900">ความยินยอมเสริม</h2>
      <p className="mt-1 text-sm text-ink-600">
        เลือกได้ว่าจะให้ระบบใช้ข้อมูลของท่านเพื่ออะไรบ้าง — ปิดได้ทุกเมื่อ
      </p>
      {status !== null ? (
        status.kind === "success" ? (
          <p role="status" data-testid="consent-status" className="mt-3 rounded-[10px] bg-success-50 p-3 text-sm text-success-600">
            {status.message}
          </p>
        ) : (
          <p role="alert" data-testid="consent-status" className="mt-3 rounded-[10px] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            {status.message}
          </p>
        )
      ) : null}

      <div className="mt-3 overflow-hidden rounded-[14px] border border-mist-200 bg-white shadow-card">
        {CONSENT_TYPES.map((type) => (
          <div key={type} className="flex items-center justify-between gap-4 border-b border-mist-200 px-4 py-4 last:border-b-0">
            <div>
              <p className="font-semibold text-ink-900">{CONSENT_LABELS[type].label}</p>
              <p className="mt-0.5 text-xs text-ink-500">{CONSENT_LABELS[type].hint}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={view[type].granted}
              aria-label={CONSENT_LABELS[type].label}
              data-testid={`consent-toggle-${type}`}
              onClick={() => {
                void handleToggle(type, !view[type].granted);
              }}
              disabled={pendingType !== null}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                view[type].granted ? "bg-brand-600" : "bg-mist-300"
              }`}
            >
              <span
                className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform ${
                  view[type].granted ? "translate-x-[22px]" : "translate-x-[3px]"
                }`}
              />
            </button>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-500">
        การรับทราบประกาศความเป็นส่วนตัวเป็นการรับทราบอัตโนมัติเมื่อสมัครบัญชี (อ่านอย่างเดียว)
        ส่วนความยินยอมที่จำเป็นต่อการใช้งานระบบไม่สามารถถอนได้
      </p>
    </section>
  );
}
