"use client";

/**
 * LicenseResubmitForm — ฟอร์มยื่น/ยื่นซ้ำคำขอผูกใบอนุญาตว่าความ (D-p5-4 · IDENT-002/005)
 *
 * - client component — แสดงเมื่อ canResubmit (ไม่มีคำขอ pending) · PUT /me/license multipart
 *   (license_no + ไฟล์ jpg/png/pdf ≤10MB — ตรวจฝั่ง client ก่อนส่ง mirror BFF)
 * - สำเร็จ (202) → รีเซ็ตฟอร์ม + เรียก onSubmitted() ให้การ์ดสถานะโหลดใหม่
 * - ล้ม (เช่น 409 มี pending อยู่) → ข้อความไทยจาก envelope หรือ fallback
 *
 * ลำดับ useState (ผูกกับ test — ห้ามสลับ): 1 licenseNo · 2 file · 3 busy · 4 fieldError ·
 * 5 formError
 */
import { useCallback, useState } from "react";

import { submitMyLicense, validateLicenseFile, validateLicenseNo } from "./api";

/** แอตทริบิวต์ accept ของ input file — mirror กฎไฟล์ของ PUT /me/license */
export const LICENSE_FILE_ACCEPT = ".jpg,.jpeg,.png,.pdf";

export function LicenseResubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [licenseNo, setLicenseNo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (busy) {
      return;
    }
    const noError = validateLicenseNo(licenseNo);
    const fileError =
      file === null
        ? "กรุณาแนบไฟล์หลักฐาน (JPG, PNG หรือ PDF)"
        : validateLicenseFile(file);
    setFieldError(noError ?? fileError);
    if (noError !== null || fileError !== null) {
      return;
    }
    if (file === null) {
      return;
    }
    const attached = file;
    setBusy(true);
    setFormError(null);
    try {
      await submitMyLicense({ licenseNo: licenseNo.trim(), file: attached });
      setLicenseNo("");
      setFile(null);
      setFieldError(null);
      onSubmitted();
    } catch (error: unknown) {
      const message =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message: unknown }).message === "string" &&
        (error as { message: string }).message.length > 0
          ? (error as { message: string }).message
          : "ยื่นคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
      setFormError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, licenseNo, file, onSubmitted]);

  return (
    <form
      className="mt-4 rounded-[14px] border border-mist-200 bg-white p-4 shadow-card"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <p className="font-heading text-base font-semibold text-ink-900">ยื่นคำขอผูกใบอนุญาตว่าความ</p>
      <p className="mt-1 text-xs text-ink-500">
        กรอกเลขที่ใบอนุญาตว่าความและแนบไฟล์หลักฐาน (JPG, PNG หรือ PDF ไม่เกิน 10 MB)
        เจ้าหน้าที่จะตรวจสอบและแจ้งผลการพิจารณาทางการแจ้งเตือนและอีเมล
      </p>

      <label htmlFor="license-no" className="mt-3 block text-sm font-semibold text-ink-700">
        เลขที่ใบอนุญาตว่าความ <span className="text-danger-600">*</span>
      </label>
      <input
        id="license-no"
        type="text"
        inputMode="numeric"
        data-testid="license-no-input"
        value={licenseNo}
        onChange={(event) => {
          setLicenseNo(event.target.value);
        }}
        disabled={busy}
        placeholder="เช่น 1234567"
        className="mt-1 w-full rounded-[10px] border border-mist-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-600 focus:outline-none"
      />

      <label htmlFor="license-file" className="mt-3 block text-sm font-semibold text-ink-700">
        ไฟล์หลักฐาน <span className="text-danger-600">*</span>
      </label>
      <input
        id="license-file"
        type="file"
        accept={LICENSE_FILE_ACCEPT}
        data-testid="license-file-input"
        onChange={(event) => {
          const files = event.target.files;
          setFile(files !== null && files.length > 0 ? (files[0] ?? null) : null);
        }}
        disabled={busy}
        className="mt-1 w-full text-sm text-ink-700"
      />

      {fieldError !== null ? (
        <p role="alert" data-testid="license-form-error" className="mt-2 text-xs text-danger-600">
          {fieldError}
        </p>
      ) : null}
      {formError !== null ? (
        <p role="alert" data-testid="license-form-error" className="mt-2 text-xs text-danger-600">
          {formError}
        </p>
      ) : null}

      <button
        type="submit"
        data-testid="license-submit"
        disabled={busy}
        className="mt-3 rounded-[10px] bg-brand-600 px-5 py-2.5 font-heading text-sm font-semibold text-white shadow-card hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-mist-300 disabled:text-ink-500"
      >
        {busy ? "กำลังส่งคำขอ..." : "ส่งคำขอ"}
      </button>
    </form>
  );
}
