"use client";

/**
 * UserActions — ปุ่ม/โมดัลจัดการบัญชีผู้ใช้ของหน้า /admin/users (Wave E Phase 5 · lane F · ADM-002)
 *
 * - UserRowActions — ต่อแถว: ปิด/เปิดใช้งาน (PATCH /api/v1/admin/users/{id} body {is_active, reason?}
 *   — API-SPEC 1.2.3 §3.7 แถว 212 · disable บังคับ reason ≥10) · มอบ/ถอดบทบาท (POST/DELETE
 *   /api/v1/admin/users/{id}/roles — ทั้งคู่บังคับ body {role, reason 10-500})
 * - CreateStaffButton — สร้างบัญชีเจ้าหน้าที่ (POST /api/v1/admin/users — super_admin เท่านั้น ·
 *   body {email, displayName, role, reason 10-500} · บังคับ MFA ตั้งแต่วันแรกเป็นหน้าที่ของ BFF)
 * - ทุก action ผ่าน ConfirmModal ภาษาไทยก่อนยิงเสมอ · 403 → แสดงข้อความจาก BFF ไม่ crash ·
 *   pure helpers ทั้งหมดถูก export เพื่อ unit test ใน node env (แบบ AssessmentFormModal)
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmModal } from "@/components/admin/ConfirmModal";
import { AdminApiError } from "@/lib/exam-admin.client";
import {
  deleteAdminJson,
  patchAdminJson,
  postAdminJson,
} from "@/components/admin/users/api-client";

// pure helpers ทั้งหมดย้ายไป user-actions.view.ts (ไม่มี "use client") เพื่อให้หน้า
// server /admin/users เรียกได้ — Next.js ห้ามเรียกฟังก์ชันของโมดูล client จาก server
// (e2e-16 t2 จับ: SSR ล่มทุกคำขอแม้ BFF 200) · re-export ต่อเพื่อโมดูล/test เดิม
import {
  buildCreateStaffBody,
  buildDisableBody,
  buildEnableBody,
  buildGrantRoleBody,
  buildRevokeRoleBody,
  CREATE_STAFF_FORM_DEFAULTS,
  reasonValid,
  roleLabelOf,
  roleRevokePath,
  userActionPath,
  validateCreateStaffForm,
  type CreateStaffFormState,
} from "./user-actions.view";

export * from "./user-actions.view";


/** ป้าย/ข้อความของโมดัลบทบาท — ใช้ซ้ำทั้ง grant/revoke */
const ROLE_MODAL_COPY = {
  grant: {
    title: "มอบบทบาท",
    confirm: "มอบบทบาท",
    hint: "เลือกบทบาทที่ต้องการมอบ — staff:registrar มอบได้เฉพาะ “ทนายความ” หลังยืนยันใบอนุญาต (ตรวจสิทธิ์อีกชั้นที่ระบบหลังบ้านเสมอ)",
  },
  revoke: {
    title: "ถอดบทบาท",
    confirm: "ถอดบทบาท",
    hint: "เลือกบทบาทที่ต้องการถอด — บัญชีต้องเหลือบทบาทไว้อย่างน้อย 1 บทบาทเสมอ (ต้องระบุเหตุผลตามสัญญา route)",
  },
} as const;

/** แผงข้อผิดพลาดในโมดัล — ข้อความไทยจาก envelope ของ BFF */
function ErrorPanel({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-3 rounded-[10px] bg-danger-50 px-3 py-2 text-sm text-danger-600">
      {message}
    </p>
  );
}

/** ป้ายเหตุผล + textarea ร่วมของโมดัลที่บังคับ reason */
function ReasonField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        maxLength={500}
        className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
      />
      <p className="mt-1 text-xs text-ink-500">{hint}</p>
    </div>
  );
}

/** ประเภท modal ที่เปิดอยู่ของแถวผู้ใช้ */
type UserRowModal = "disable" | "enable" | "grant" | "revoke" | null;

export type UserRowActionsProps = {
  userId: string;
  displayName: string;
  status: string;
  roles: readonly string[];
  canDisable: boolean;
  canManageRoles: boolean;
  /** ตัวเลือกบทบาทของ "ผู้ใช้หลังบ้านที่กำลังเข้าใช้" (คำนวณฝั่ง server จาก session จริง) */
  callerRoleOptions: readonly string[];
};

/** ปุ่ม + โมดัลจัดการต่อแถวผู้ใช้ (disable/enable · มอบ/ถอดบทบาท) */
export function UserRowActions({
  userId,
  displayName,
  status,
  roles,
  canDisable,
  canManageRoles,
  callerRoleOptions,
}: UserRowActionsProps) {
  const router = useRouter();
  const [modal, setModal] = useState<UserRowModal>(null);
  const [reason, setReason] = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // สถานะจากแถวรายการบอกได้แค่ active/deleted — แถวที่ถูกลบไม่นำเข้าโมดัลจัดการอีก
  // (สถานะ ban ของ GoTrue ไม่อยู่ในขาออกของ RPC — ปุ่มปิด/เปิดจึงแสดงคู่กันตามสิทธิ์)
  const isDeleted = status === "deleted";

  function resetAndClose() {
    setModal(null);
    setReason("");
    setSelectedRole("");
    setError(null);
    setSubmitting(false);
  }

  async function submitDisable() {
    setSubmitting(true);
    setError(null);
    try {
      await patchAdminJson(userActionPath(userId), buildDisableBody(reason));
      resetAndClose();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  async function submitEnable() {
    setSubmitting(true);
    setError(null);
    try {
      await patchAdminJson(userActionPath(userId), buildEnableBody());
      resetAndClose();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  async function submitGrant() {
    setSubmitting(true);
    setError(null);
    try {
      await postAdminJson(
        `${userActionPath(userId)}/roles`,
        buildGrantRoleBody(selectedRole, reason),
      );
      resetAndClose();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  async function submitRevoke() {
    setSubmitting(true);
    setError(null);
    try {
      await deleteAdminJson(roleRevokePath(userId), buildRevokeRoleBody(selectedRole, reason));
      resetAndClose();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  const roleChoices = modal === "revoke" ? roles : callerRoleOptions;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canDisable && isDeleted === false ? (
        <>
          <button
            type="button"
            onClick={() => setModal("disable")}
            className="rounded-[10px] border border-danger-600 bg-white px-3 py-1.5 text-sm font-semibold text-danger-600 hover:bg-danger-50"
          >
            ปิดใช้งาน
          </button>
          <button
            type="button"
            onClick={() => setModal("enable")}
            className="rounded-[10px] border border-brand-600 bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50"
          >
            เปิดใช้งาน
          </button>
        </>
      ) : null}
      {canManageRoles ? (
        <>
          <button
            type="button"
            onClick={() => setModal("grant")}
            className="rounded-[10px] border border-brand-600 bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50"
          >
            มอบบทบาท
            <span className="sr-only">ให้ {displayName}</span>
          </button>
          {roles.length > 0 ? (
            <button
              type="button"
              onClick={() => setModal("revoke")}
              className="rounded-[10px] border border-mist-300 bg-white px-3 py-1.5 text-sm font-semibold text-ink-600 hover:bg-mist-100"
            >
              ถอดบทบาท
              <span className="sr-only">ของ {displayName}</span>
            </button>
          ) : null}
        </>
      ) : null}

      <ConfirmModal
        open={modal === "disable"}
        onClose={() => (submitting ? undefined : resetAndClose())}
        title={`ปิดใช้งานบัญชี ${displayName}`}
        description="บัญชีที่ปิดใช้งานจะเข้าสู่ระบบไม่ได้ทันที สามารถเปิดใช้งานคืนได้ภายหลัง"
        confirmLabel="ปิดใช้งานบัญชี"
        confirmDisabled={reasonValid(reason) === false || submitting}
        confirmDisabledReason={
          submitting ? "กำลังส่งข้อมูล โปรดรอสักครู่" : "ระบุเหตุผลให้ยาวอย่างน้อย 10 ตัวอักษรก่อนยืนยัน"
        }
        onConfirm={() => void submitDisable()}
      >
        <ReasonField
          id={`disable-reason-${userId}`}
          label="เหตุผลที่ปิดใช้งาน (บังคับ)"
          value={reason}
          onChange={setReason}
          hint="เหตุผลจะถูกบันทึกในบันทึกการตรวจสอบ (audit) — ยาวอย่างน้อย 10 ตัวอักษร"
        />
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>

      <ConfirmModal
        open={modal === "enable"}
        onClose={() => (submitting ? undefined : resetAndClose())}
        title={`เปิดใช้งานบัญชี ${displayName}`}
        description="ผู้ใช้จะเข้าสู่ระบบได้ตามปกติทันทีหลังเปิดใช้งาน"
        confirmLabel="เปิดใช้งาน"
        confirmDisabled={submitting}
        confirmDisabledReason={submitting ? "กำลังส่งข้อมูล โปรดรอสักครู่" : undefined}
        onConfirm={() => void submitEnable()}
      >
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>

      <ConfirmModal
        open={modal === "grant" || modal === "revoke"}
        onClose={() => (submitting ? undefined : resetAndClose())}
        title={modal === "revoke" ? `${ROLE_MODAL_COPY.revoke.title} · ${displayName}` : `${ROLE_MODAL_COPY.grant.title} · ${displayName}`}
        description={modal === "revoke" ? ROLE_MODAL_COPY.revoke.hint : ROLE_MODAL_COPY.grant.hint}
        confirmLabel={modal === "revoke" ? ROLE_MODAL_COPY.revoke.confirm : ROLE_MODAL_COPY.grant.confirm}
        confirmDisabled={
          selectedRole.length === 0 ||
          reasonValid(reason) === false ||
          submitting
        }
        confirmDisabledReason={
          submitting
            ? "กำลังส่งข้อมูล โปรดรอสักครู่"
            : selectedRole.length === 0
              ? "เลือกบทบาทก่อนยืนยัน"
              : reasonValid(reason) === false
                ? "ระบุเหตุผลให้ยาวอย่างน้อย 10 ตัวอักษรก่อนยืนยัน"
                : undefined
        }
        onConfirm={() => void (modal === "revoke" ? submitRevoke() : submitGrant())}
      >
        <div className="space-y-3">
          <div>
            <label htmlFor={`role-select-${userId}`} className="block text-sm font-medium text-ink-700">
              {modal === "revoke" ? "บทบาทที่ถืออยู่" : "บทบาทที่จะมอบ"}
            </label>
            <select
              id={`role-select-${userId}`}
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.target.value)}
              className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            >
              <option value="">— เลือกบทบาท —</option>
              {roleChoices.map((role) => (
                <option key={role} value={role}>
                  {roleLabelOf(role)}
                </option>
              ))}
            </select>
          </div>
          <ReasonField
            id={`${modal === "revoke" ? "revoke" : "grant"}-reason-${userId}`}
            label={modal === "revoke" ? "เหตุผลที่ถอดบทบาท (บังคับ)" : "เหตุผลที่มอบบทบาท (บังคับ)"}
            value={reason}
            onChange={setReason}
            hint="เหตุผลจะถูกบันทึกในบันทึกการตรวจสอบ (audit) — ยาวอย่างน้อย 10 ตัวอักษร"
          />
        </div>
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>
    </div>
  );
}

/** ปุ่ม + โมดัลสร้างบัญชีเจ้าหน้าที่ (POST /api/v1/admin/users — super_admin เท่านั้น) */
export function CreateStaffButton({ callerRoleOptions }: { callerRoleOptions: readonly string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateStaffFormState>(CREATE_STAFF_FORM_DEFAULTS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function resetAndClose() {
    setOpen(false);
    setForm(CREATE_STAFF_FORM_DEFAULTS);
    setErrors({});
    setError(null);
    setSubmitting(false);
  }

  async function submitCreate() {
    setSubmitting(true);
    setError(null);
    const built = buildCreateStaffBody(form);
    if (built.ok === false) {
      setErrors(validateCreateStaffForm(form));
      setSubmitting(false);
      return;
    }
    try {
      await postAdminJson("/api/v1/admin/users", built.body);
      resetAndClose();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  const formValid = Object.keys(validateCreateStaffForm(form)).length === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
      >
        สร้างบัญชีเจ้าหน้าที่
      </button>
      <ConfirmModal
        open={open}
        onClose={() => (submitting ? undefined : resetAndClose())}
        title="สร้างบัญชีเจ้าหน้าที่"
        description="บัญชีใหม่จะถูกบังคับตั้ง MFA ตั้งแต่วันแรกของการใช้งาน (ดูแลโดยระบบหลังบ้าน)"
        confirmLabel="สร้างบัญชี"
        confirmDisabled={formValid === false || submitting}
        confirmDisabledReason={
          submitting ? "กำลังส่งข้อมูล โปรดรอสักครู่" : "กรอกข้อมูลให้ครบถ้วนถูกต้องก่อนยืนยัน"
        }
        onConfirm={() => void submitCreate()}
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="staff-email" className="block text-sm font-medium text-ink-700">
              อีเมล
            </label>
            <input
              id="staff-email"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              maxLength={200}
              className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            {errors["email"] ? <p className="mt-1 text-xs text-danger-600">{errors["email"]}</p> : null}
          </div>
          <div>
            <label htmlFor="staff-name" className="block text-sm font-medium text-ink-700">
              ชื่อ-นามสกุล
            </label>
            <input
              id="staff-name"
              type="text"
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              maxLength={120}
              className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            {errors["displayName"] ? (
              <p className="mt-1 text-xs text-danger-600">{errors["displayName"]}</p>
            ) : null}
          </div>
          <div>
            <label htmlFor="staff-role" className="block text-sm font-medium text-ink-700">
              บทบาทเริ่มต้น
            </label>
            <select
              id="staff-role"
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
              className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            >
              <option value="">— เลือกบทบาท —</option>
              {callerRoleOptions.map((role) => (
                <option key={role} value={role}>
                  {roleLabelOf(role)}
                </option>
              ))}
            </select>
            {errors["role"] ? <p className="mt-1 text-xs text-danger-600">{errors["role"]}</p> : null}
          </div>
          <ReasonField
            id="staff-reason"
            label="เหตุผลที่สร้างบัญชี (บังคับ)"
            value={form.reason}
            onChange={(reason) => setForm({ ...form, reason })}
            hint="เหตุผลจะถูกบันทึกในบันทึกการตรวจสอบ (audit) — ยาวอย่างน้อย 10 ตัวอักษร"
          />
          {errors["reason"] ? <p className="text-xs text-danger-600">{errors["reason"]}</p> : null}
        </div>
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>
    </div>
  );
}
