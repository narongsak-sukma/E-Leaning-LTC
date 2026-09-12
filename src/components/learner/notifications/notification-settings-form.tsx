/**
 * NotificationSettingsForm — ตารางตั้งค่าการแจ้งเตือนราย family/ช่องทาง (NTF-005 · lane D)
 *
 * - client component — โหลดค่าจริงจาก GET /api/v1/me/notification-settings ตอน mount
 *   (missing family = default on ตาม D-p4-4 — normalize ที่ api.ts แล้ว)
 * - แถวละ 1 family (ผลสอบ/ใบประกาศนียบัตร/หน่วยกิตสะสม/รอบต่ออายุ) × 2 toggle (ในระบบ/อีเมล)
 * - "บันทึกการตั้งค่า" PATCH เฉพาะ family ที่เปลี่ยน (diff กับค่า server ล่าสุด) → แจ้งผล
 *   สำเร็จ/ล้มเป็นข้อความ role=status/alert แบบเดียวกับหน้า admin (repo ไม่มี toast library)
 * - ผิดพลาดทุกกรณี = ข้อความไทย (ข้อความจาก envelope ของ BFF) — ไม่ crash ไม่แสดง stack
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  NOTIF_FAMILIES,
  getNotificationSettings,
  updateNotificationSettings,
  type FamilyChannelsParsed,
  type NotifFamily,
  type SettingsByFamily,
} from "./api";

/** ป้ายไทย + คำอธิบายของแต่ละ family (D-p4-5) — แสดงบนจอทั้งหมด */
const FAMILY_LABELS: Record<NotifFamily, { readonly label: string; readonly hint: string }> = {
  "exam.result": {
    label: "ผลสอบ",
    hint: "แจ้งผลการสอบของท่านทั้งกรณีผ่านและไม่ผ่าน",
  },
  certificate: {
    label: "ใบประกาศนียบัตร",
    hint: "แจ้งเมื่อออกใบประกาศนียบัตร หรือเพิกถอนใบที่ออกไปแล้ว",
  },
  credit: {
    label: "หน่วยกิตสะสม",
    hint: "แจ้งการปรับหน่วยกิตสะสมของท่านโดยเจ้าหน้าที่",
  },
  renewal: {
    label: "รอบต่ออายุ",
    hint: "เตือนล่วงหน้า 30 และ 7 วันก่อนรอบต่ออายุใบอนุญาตว่าความสิ้นสุด",
  },
};

/** ช่องทางทั้งสอง — ลำดับคอลัมน์ของตาราง */
const CHANNELS = [
  { key: "in_app", label: "ในระบบ" },
  { key: "email", label: "อีเมล" },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];

/** toggle เดี่ยว — role="switch" (screen reader อ่านสถานะได้) · เปิด = brand-600 · ปิด = mist-300 */
function ChannelToggle({
  checked,
  disabled,
  testId,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  testId: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-brand-600" : "bg-mist-300"
      }`}
    >
      <span
        className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-[3px]"
        }`}
      />
    </button>
  );
}

/** สถานะการบันทึกล่าสุด — "toast" ของ repo: ข้อความ role=status/alert คงอยู่จนกดซ้ำ (แบบ admin) */
interface SaveStatus {
  readonly kind: "success" | "error";
  readonly message: string;
}

/** ข้อความ error จาก envelope ของ BFF (ApiError) — fallback ไทยเมื่อไม่มี message */
function saveErrorText(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    (error as { message: string }).message.length > 0
  ) {
    return (error as { message: string }).message;
  }
  return "บันทึกการตั้งค่าไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
}

export function NotificationSettingsForm() {
  /** null = ยังโหลด · error = โหลดล้ม (BFF หาย) · ready = พร้อมแก้ไข */
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  /** ค่าฝั่ง server ล่าสุด — ฐานของการ diff ตอน PATCH (ส่งเฉพาะ family ที่เปลี่ยน) */
  const [serverSettings, setServerSettings] = useState<SettingsByFamily | null>(null);
  /** ค่าบนจอ (draft) — ผู้ใช้ toggle แล้วยังไม่บันทึก */
  const [draft, setDraft] = useState<SettingsByFamily | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  /** กัน setState หลัง unmount — fetch ค้างขณะผู้ใช้เปลี่ยนหน้า */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSettings = useCallback(async (): Promise<void> => {
    setPhase("loading");
    try {
      const settings = await getNotificationSettings();
      if (!mountedRef.current) {
        return;
      }
      setServerSettings(settings);
      setDraft(settings);
      setPhase("ready");
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  /** toggle หนึ่งช่อง — ปรับ draft เท่านั้น (ยังไม่แตะ server จนกดบันทึก) */
  const toggleChannel = useCallback((family: NotifFamily, channel: ChannelKey): void => {
    setDraft((previous) => {
      if (previous === null) {
        return previous;
      }
      const current = previous[family];
      const next: FamilyChannelsParsed =
        channel === "in_app"
          ? { ...current, in_app: !current.in_app }
          : { ...current, email: !current.email };
      return { ...previous, [family]: next };
    });
  }, []);

  /** family ที่ draft ต่างจาก server — เป็นตัวกำหนด dirty และ payload ของ PATCH */
  function changedFamilies(
    server: SettingsByFamily,
    currentDraft: SettingsByFamily,
  ): Partial<Record<NotifFamily, FamilyChannelsParsed>> {
    const changed: Partial<Record<NotifFamily, FamilyChannelsParsed>> = {};
    for (const family of NOTIF_FAMILIES) {
      const s = server[family];
      const d = currentDraft[family];
      if (s.in_app !== d.in_app || s.email !== d.email) {
        changed[family] = { in_app: d.in_app, email: d.email };
      }
    }
    return changed;
  }

  const handleSave = useCallback(async (): Promise<void> => {
    if (serverSettings === null || draft === null || saving) {
      return;
    }
    const changed = changedFamilies(serverSettings, draft);
    if (Object.keys(changed).length === 0) {
      return;
    }
    setSaving(true);
    setSaveStatus(null);
    try {
      const settings = await updateNotificationSettings(changed);
      if (!mountedRef.current) {
        return;
      }
      setServerSettings(settings);
      setDraft(settings);
      setSaveStatus({
        kind: "success",
        message: "บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว",
      });
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      setSaveStatus({ kind: "error", message: saveErrorText(error) });
    } finally {
      setSaving(false);
    }
  }, [serverSettings, draft, saving]);

  const changed =
    serverSettings !== null && draft !== null ? changedFamilies(serverSettings, draft) : {};
  const dirty = Object.keys(changed).length > 0;

  const resetDraft = useCallback((): void => {
    setDraft(serverSettings);
    setSaveStatus(null);
  }, [serverSettings]);

  if (phase === "loading") {
    return (
      <div
        role="status"
        className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card"
      >
        <p className="text-sm text-ink-600">กำลังโหลดการตั้งค่า...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div
        role="alert"
        className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center"
      >
        <p className="font-heading text-base font-semibold text-danger-700">
          โหลดการตั้งค่าการแจ้งเตือนไม่สำเร็จ
        </p>
        <p className="mt-1 text-sm text-danger-600">
          ขออภัย ติดต่อระบบไม่ได้ในขณะนี้ กรุณาลองอีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
        </p>
        <button
          type="button"
          onClick={() => {
            void loadSettings();
          }}
          className="mt-4 rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          ลองอีกครั้ง
        </button>
      </div>
    );
  }

  // phase === "ready" — loader ตั้ง draft ก่อนเปลี่ยน phase เสมอ (กัน null ฝืนระบบ type)
  const view = draft;
  if (view === null) {
    return null;
  }

  return (
    <div>
      {saveStatus !== null ? (
        saveStatus.kind === "success" ? (
          <p role="status" className="mt-5 rounded-[10px] bg-success-50 p-3 text-sm text-success-600">
            {saveStatus.message}
          </p>
        ) : (
          <p
            role="alert"
            className="mt-5 rounded-[10px] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {saveStatus.message}
          </p>
        )
      ) : null}

      <div className="mt-5 overflow-x-auto rounded-[14px] border border-mist-200 bg-white shadow-card">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-mist-200 bg-mist-50">
              <th scope="col" className="px-4 py-3 font-heading font-semibold text-ink-700">
                ประเภทการแจ้งเตือน
              </th>
              <th scope="col" className="px-4 py-3 text-center font-heading font-semibold text-ink-700">
                ในระบบ
              </th>
              <th scope="col" className="px-4 py-3 text-center font-heading font-semibold text-ink-700">
                อีเมล
              </th>
            </tr>
          </thead>
          <tbody>
            {NOTIF_FAMILIES.map((family) => (
              <SettingsRow
                key={family}
                family={family}
                channels={view[family]}
                disabled={saving}
                onToggle={toggleChannel}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="settings-save"
          onClick={() => {
            void handleSave();
          }}
          disabled={saving || !dirty}
          className="rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
        >
          {saving ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
        </button>
        {dirty ? (
          <button
            type="button"
            onClick={resetDraft}
            disabled={saving}
            className="rounded-[10px] border border-mist-300 bg-white px-4 py-2.5 font-heading text-sm font-semibold text-ink-600 hover:bg-mist-50 disabled:cursor-not-allowed"
          >
            เลิกทำการเปลี่ยนแปลง
          </button>
        ) : null}
        <p className="text-xs text-ink-500">
          หากปิดอีเมลของประเภทใด ระบบจะไม่ส่งอีเมลแจ้งเตือนประเภทนั้นทันทีที่บันทึก
          (การแจ้งในระบบแสดงปกติ)
        </p>
      </div>
    </div>
  );
}

/**
 * แถวของตาราง — ป้ายไทย + คำอธิบาย + toggle 2 ช่องทาง
 * testid ตามสัญญาของ lane D/E: settings-toggle-{family}-{channel} (เช่น settings-toggle-exam.result-in_app)
 */
function SettingsRow({
  family,
  channels,
  disabled,
  onToggle,
}: {
  family: NotifFamily;
  channels: FamilyChannelsParsed;
  disabled: boolean;
  onToggle: (family: NotifFamily, channel: ChannelKey) => void;
}) {
  const meta = FAMILY_LABELS[family];
  return (
    <tr className="border-b border-mist-200 last:border-b-0">
      <td className="px-4 py-4">
        <p className="font-semibold text-ink-900">{meta.label}</p>
        <p className="mt-0.5 text-xs text-ink-500">{meta.hint}</p>
      </td>
      {CHANNELS.map((channel) => (
        <td key={channel.key} className="px-4 py-4 text-center">
          <ChannelToggle
            checked={channels[channel.key]}
            disabled={disabled}
            testId={`settings-toggle-${family}-${channel.key}`}
            label={`${channel.label} — ${meta.label}`}
            onToggle={() => onToggle(family, channel.key)}
          />
        </td>
      ))}
    </tr>
  );
}
