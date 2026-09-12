"use client";

/**
 * ProfileForm — ฟอร์มแก้โปรไฟล์ของตัวเอง (Wave E Phase 5 · IDENT-001 · lane E)
 *
 * หน้า my/profile (D-p5-13): แก้เขต self-edit เท่านั้น (guard 0010 · D20-M2) —
 * display_name / phone / preferred_locale (th|en) · first/last_name เป็นข้อมูลนิติบุคคล
 * เจ้าของแก้เองไม่ได้ — แสดงอ่านอย่างเดียวเมื่อ BFF ส่งมาพร้อมข้อความชี้แจง
 *
 * - client component — โหลดค่าจริงจาก GET /api/v1/me ตอน mount · PATCH /api/v1/me ส่งเฉพาะ
 *   เขต self-edit (camelCase mirror ขาออกของ /me) · สำเร็จ → โหลด GET ซ้ำ (แหล่งความจริงเดียว)
 *   + ข้อความสำเร็จ role=status
 * - ตรวจฝั่ง client ก่อนส่ง (mirror กฎ BFF): display_name ต้องไม่ว่าง (1-100 อักขระ) ·
 *   phone เว้นได้ แต่ถ้ากรอกต้อง 7-20 อักขระ ตัวเลข/+/-/()/ช่องว่าง · preferred_locale th|en
 * - ผิดพลาดทุกกรณี = ข้อความไทย (จาก envelope ของ BFF เมื่อมี) — ไม่ crash ไม่แสดง stack
 *
 * ลำดับ useState (ผูกกับ test — ห้ามสลับ): 1 phase · 2 profile · 3 draft · 4 saving ·
 * 5 saveStatus · 6 fieldErrors
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { getMyProfile, updateMyProfile, type MeProfile } from "./api";

/** ตัวเลือกภาษา — ตาม CHECK preferred_locale IN ('th','en') (DD §3.1) */
export const LOCALE_OPTIONS = [
  { value: "th", label: "ไทย" },
  { value: "en", label: "อังกฤษ" },
] as const;

/** ข้อผิดพลาดรายฟิลด์ — key ตามเขต self-edit */
export type ProfileFieldErrors = Partial<
  Record<"displayName" | "phone" | "preferredLocale", string>
>;

/** ค่า draft ของฟอร์ม — ตามเขต self-edit */
export type ProfileFormDraft = {
  displayName: string;
  phone: string;
  preferredLocale: string;
};

/** ข้อความตรวจสอบรายฟิลด์ (mirror กฎ BFF) — คืน {} เมื่อผ่านทั้งหมด */
export function validateProfileForm(input: ProfileFormDraft): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    errors.displayName = "กรุณากรอกชื่อที่ใช้แสดง";
  } else if (displayName.length > 100) {
    errors.displayName = "ชื่อที่ใช้แสดงยาวได้ไม่เกิน 100 อักขระ";
  }
  const phone = input.phone.trim();
  if (phone.length > 0 && !/^[0-9+()\-\s]{7,20}$/.test(phone)) {
    errors.phone = "เบอร์โทรศัพท์ต้องเป็นตัวเลข 7-20 หลัก (ใส่ + วงเล็บ หรือขีดได้)";
  }
  if (input.preferredLocale !== "th" && input.preferredLocale !== "en") {
    errors.preferredLocale = "กรุณาเลือกภาษาที่ต้องการ";
  }
  return errors;
}

/** สถานะการบันทึกล่าสุด — ข้อความ role=status/alert คงอยู่จน action ถัดไป (repo ไม่มี toast library) */
interface SaveStatus {
  readonly kind: "success" | "error";
  readonly message: string;
}

/** ข้อความ error จาก envelope ของ BFF (ApiError) — fallback ไทยเมื่อไม่มี message */
function saveErrorText(error: unknown, fallback: string): string {
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

export function ProfileForm() {
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [profile, setProfile] = useState<MeProfile | null>(null);
  const [draft, setDraft] = useState<ProfileFormDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadProfile = useCallback(async (): Promise<void> => {
    setPhase("loading");
    try {
      const loaded = await getMyProfile();
      if (!mountedRef.current) {
        return;
      }
      setProfile(loaded);
      setDraft({
        displayName: loaded.displayName,
        phone: loaded.phone ?? "",
        preferredLocale: loaded.preferredLocale,
      });
      setPhase("ready");
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (saving || draft === null) {
      return;
    }
    const errors = validateProfileForm(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    setSaving(true);
    setSaveStatus(null);
    try {
      await updateMyProfile({
        displayName: draft.displayName.trim(),
        phone: draft.phone.trim().length > 0 ? draft.phone.trim() : null,
        preferredLocale: draft.preferredLocale === "en" ? "en" : "th",
      });
      if (!mountedRef.current) {
        return;
      }
      setSaveStatus({ kind: "success", message: "บันทึกการเปลี่ยนแปลงโปรไฟล์เรียบร้อยแล้ว" });
      await loadProfile();
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      setSaveStatus({
        kind: "error",
        message: saveErrorText(error, "บันทึกโปรไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"),
      });
    } finally {
      setSaving(false);
    }
  }, [draft, saving, loadProfile]);

  if (phase === "loading") {
    return (
      <div role="status" className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card">
        <p className="text-sm text-ink-600">กำลังโหลดข้อมูลโปรไฟล์...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div role="alert" className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center">
        <p className="font-heading text-base font-semibold text-danger-700">โหลดข้อมูลโปรไฟล์ไม่สำเร็จ</p>
        <p className="mt-1 text-sm text-danger-600">
          ขออภัย ติดต่อระบบไม่ได้ในขณะนี้ กรุณาลองอีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
        </p>
        <button
          type="button"
          data-testid="profile-retry"
          onClick={() => {
            void loadProfile();
          }}
          className="mt-4 rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          ลองอีกครั้ง
        </button>
      </div>
    );
  }

  if (profile === null || draft === null) {
    return null;
  }

  return (
    <form
      className="mt-5"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      {saveStatus !== null ? (
        saveStatus.kind === "success" ? (
          <p role="status" data-testid="profile-save-status" className="mb-4 rounded-[10px] bg-success-50 p-3 text-sm text-success-600">
            {saveStatus.message}
          </p>
        ) : (
          <p role="alert" data-testid="profile-save-status" className="mb-4 rounded-[10px] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            {saveStatus.message}
          </p>
        )
      ) : null}

      <div className="rounded-[14px] border border-mist-200 bg-white p-6 shadow-card">
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="profile-email" className="block text-sm font-semibold text-ink-700">อีเมล (ใช้เข้าสู่ระบบ)</label>
            <input
              id="profile-email"
              type="email"
              value={profile.email}
              readOnly
              disabled
              className="mt-1 w-full rounded-[10px] border border-mist-200 bg-mist-50 px-3 py-2 text-sm text-ink-500"
            />
          </div>

          <div>
            <label htmlFor="profile-display-name" className="block text-sm font-semibold text-ink-700">ชื่อที่ใช้แสดง <span className="text-danger-600">*</span></label>
            <input
              id="profile-display-name"
              type="text"
              data-testid="profile-display-name"
              value={draft.displayName}
              onChange={(event) => {
                const value = event.target.value;
                setDraft({ ...draft, displayName: value });
              }}
              disabled={saving}
              maxLength={120}
              className="mt-1 w-full rounded-[10px] border border-mist-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none"
            />
            {fieldErrors.displayName !== undefined ? (
              <p role="alert" className="mt-1 text-xs text-danger-600">{fieldErrors.displayName}</p>
            ) : null}
          </div>

          <div>
            <label htmlFor="profile-phone" className="block text-sm font-semibold text-ink-700">เบอร์โทรศัพท์</label>
            <input
              id="profile-phone"
              type="tel"
              data-testid="profile-phone"
              value={draft.phone}
              onChange={(event) => {
                const value = event.target.value;
                setDraft({ ...draft, phone: value });
              }}
              disabled={saving}
              maxLength={30}
              className="mt-1 w-full rounded-[10px] border border-mist-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none"
            />
            {fieldErrors.phone !== undefined ? (
              <p role="alert" className="mt-1 text-xs text-danger-600">{fieldErrors.phone}</p>
            ) : null}
          </div>

          <div>
            <label htmlFor="profile-locale" className="block text-sm font-semibold text-ink-700">ภาษาที่ใช้แสดงผล</label>
            <select
              id="profile-locale"
              data-testid="profile-locale"
              value={draft.preferredLocale}
              onChange={(event) => {
                const value = event.target.value;
                setDraft({ ...draft, preferredLocale: value });
              }}
              disabled={saving}
              className="mt-1 w-full rounded-[10px] border border-mist-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none"
            >
              {LOCALE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {fieldErrors.preferredLocale !== undefined ? (
              <p role="alert" className="mt-1 text-xs text-danger-600">{fieldErrors.preferredLocale}</p>
            ) : null}
          </div>

          {profile.firstName !== null || profile.lastName !== null ? (
            <div className="rounded-[10px] border border-mist-200 bg-mist-50 p-4">
              <p className="text-sm font-semibold text-ink-700">ชื่อ-นามสกุลตามทะเบียน (ข้อมูลนิติบุคคล)</p>
              <p className="mt-1 text-sm text-ink-900">{[profile.firstName, profile.lastName].filter(Boolean).join(" ")}</p>
              <p className="mt-1 text-xs text-ink-500">ข้อมูลนิติบุคคล — แก้ไขผ่านเจ้าหน้าที่ได้เท่านั้น</p>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            data-testid="profile-save"
            disabled={saving}
            className="rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
          >
            {saving ? "กำลังบันทึก..." : "บันทึก"}
          </button>
          <Link
            href="/my/privacy"
            data-testid="profile-privacy-link"
            className="text-sm font-semibold text-brand-700 hover:text-brand-800 hover:underline"
          >
            จัดการข้อมูลส่วนบุคคลและความยินยอม
          </Link>
        </div>
      </div>
    </form>
  );
}
