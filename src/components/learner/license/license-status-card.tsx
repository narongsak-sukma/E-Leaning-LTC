"use client";

/**
 * LicenseStatusCard — การ์ดสถานะใบอนุญาตว่าความของหน้า my/license (D-p5-4 · IDENT-005)
 *
 * - client component — โหลด GET /me/license ตอน mount: คำขอล่าสุด (pending/approved/rejected
 *   + เหตุผลเมื่อไม่ผ่าน + เวลาไทย) + ใบ verified ปัจจุบัน (เลขเดิมตาม RLS เจ้าของ) +
 *   canResubmit → แสดง LicenseResubmitForm · หลังยื่นสำเร็จ → โหลดสถานะใหม่ + ข้อความรอตรวจ
 *
 * ลำดับ useState (ผูกกับ test — ห้ามสลับ): 1 phase · 2 data · 3 afterActionMsg
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { formatThaiDateTime, getMyLicense, type MyLicenseView } from "./api";
import { LicenseResubmitForm } from "./license-resubmit-form";

type ApplicationStatus = NonNullable<MyLicenseView["application"]>["status"];

/** ป้ายไทย + ชั้นสีของแต่ละสถานะคำขอ — อ่านสถานะได้จากข้อความ (ไม่พึ่งสีเพียงอย่างเดียว) */
export const APPLICATION_STATUS_LABELS: Record<
  ApplicationStatus,
  { readonly label: string; readonly className: string }
> = {
  pending: {
    label: "รอเจ้าหน้าที่ตรวจสอบ",
    className: "bg-warning-50 text-warning-700 border-warning-200",
  },
  approved: {
    label: "ผ่านการตรวจสอบ",
    className: "bg-success-50 text-success-600 border-success-200",
  },
  rejected: {
    label: "ไม่ผ่านการตรวจสอบ",
    className: "bg-danger-50 text-danger-700 border-danger-200",
  },
};

/** ข้อความแจ้งหลัง action — kind=success → role=status · kind=error → role=alert */
interface AfterActionMessage {
  readonly kind: "success" | "error";
  readonly text: string;
}

export function LicenseStatusCard() {
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [data, setData] = useState<MyLicenseView | null>(null);
  const [afterActionMsg, setAfterActionMsg] = useState<AfterActionMessage | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadLicense = useCallback(async (): Promise<void> => {
    setPhase("loading");
    try {
      const view = await getMyLicense();
      if (!mountedRef.current) {
        return;
      }
      setData(view);
      setPhase("ready");
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadLicense();
  }, [loadLicense]);

  /** ฟอร์มยื่นสำเร็จ → ข้อความรอตรวจ + โหลดสถานะใหม่ (application จะเป็น pending) */
  const handleSubmitted = useCallback((): void => {
    setAfterActionMsg({
      kind: "success",
      text: "ส่งคำขอเรียบร้อยแล้ว — เจ้าหน้าที่จะตรวจสอบและแจ้งผลการพิจารณาให้ท่านทราบ",
    });
    void loadLicense();
  }, [loadLicense]);

  if (phase === "loading") {
    return (
      <div role="status" className="mt-5 rounded-[14px] border border-mist-200 bg-white p-8 text-center shadow-card">
        <p className="text-sm text-ink-600">กำลังโหลดสถานะใบอนุญาต...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div role="alert" className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center">
        <p className="font-heading text-base font-semibold text-danger-700">โหลดสถานะใบอนุญาตไม่สำเร็จ</p>
        <p className="mt-1 text-sm text-danger-600">กรุณาลองอีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่</p>
        <button
          type="button"
          data-testid="license-retry"
          onClick={() => {
            void loadLicense();
          }}
          className="mt-4 rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          ลองอีกครั้ง
        </button>
      </div>
    );
  }

  const view = data;
  if (view === null) {
    return null;
  }

  const application = view.application;
  const license = view.license;

  return (
    <div className="mt-5">
      {afterActionMsg !== null ? (
        afterActionMsg.kind === "success" ? (
          <p role="status" data-testid="license-after-action" className="mb-4 rounded-[10px] bg-success-50 p-3 text-sm text-success-600">
            {afterActionMsg.text}
          </p>
        ) : (
          <p role="alert" data-testid="license-after-action" className="mb-4 rounded-[10px] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            {afterActionMsg.text}
          </p>
        )
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* ใบอนุญาตปัจจุบัน (verified) */}
        <div className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card">
          <h2 className="font-heading text-base font-semibold text-ink-900">ใบอนุญาตว่าความปัจจุบัน</h2>
          {license !== null ? (
            <div className="mt-3">
              <p className="text-sm text-ink-600">เลขที่ใบอนุญาต</p>
              <p data-testid="license-current-no" className="font-heading text-xl font-bold text-ink-900">
                {license.licenseNo}
              </p>
              <p className="mt-1 text-xs text-ink-500">
                ยืนยันเมื่อ {formatThaiDateTime(license.verifiedAt)}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-600">ยังไม่มีใบอนุญาตที่ได้รับการยืนยัน</p>
          )}
        </div>

        {/* คำขอล่าสุด */}
        <div className="rounded-[14px] border border-mist-200 bg-white p-5 shadow-card">
          <h2 className="font-heading text-base font-semibold text-ink-900">คำขอล่าสุด</h2>
          {application !== null ? (
            <div className="mt-3">
              <span data-testid="license-application-status" className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${APPLICATION_STATUS_LABELS[application.status].className}`}>
                {APPLICATION_STATUS_LABELS[application.status].label}
              </span>
              <p className="mt-2 text-xs text-ink-500">
                ยื่นเมื่อ {formatThaiDateTime(application.submittedAt)}
              </p>
              {application.decidedAt !== null ? (
                <p className="mt-1 text-xs text-ink-500">
                  ตัดสินเมื่อ {formatThaiDateTime(application.decidedAt)}
                  </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-600">ยังไม่เคยยื่นคำขอ</p>
          )}
        </div>
      </div>

        {/* เหตุผลที่ไม่ผ่าน — แสดงชัดเมื่อ rejected (ตาม IDENT-005) */}
        {application !== null && application.status === "rejected" && application.rejectedReason !== null ? (
          <div className="mt-4 rounded-[10px] border border-danger-200 bg-danger-50 p-4">
            <p className="text-sm font-semibold text-danger-700">เหตุผลที่ไม่ผ่านการตรวจสอบ</p>
            <p className="mt-1 text-sm text-danger-600">{application.rejectedReason}</p>
          </div>
        ) : null}

        {/* ฟอร์มยื่น/ยื่นซ้ำ — แสดงเมื่อ canResubmit (ไม่มี pending) ตาม D-p5-4 */}
        {view.canResubmit ? <LicenseResubmitForm onSubmitted={handleSubmitted} /> : null}
      </div>
  );
}
