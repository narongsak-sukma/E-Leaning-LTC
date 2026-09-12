"use client";

/**
 * UserActions — ปุ่ม/โมดัลจัดการบัญชีผู้ใช้ของหน้า /admin/users (Wave E Phase 5 · lane F · ADM-002)
 *
 * - UserRowActions — ต่อแถว: ปิด/เปิดใช้งาน (PATCH /api/v1/admin/users/{id} · disable บังคับ
 *   reason ≥10 ตัวอักษร — แบบแผน revoke) · มอบ/ถอดบทบาท (POST/DELETE /api/v1/admin/users/{id}/roles)
 * - CreateStaffButton — สร้างบัญชีเจ้าหน้าที่ (POST /api/v1/admin/users — super_admin เท่านั้น ·
 *   บังคับ MFA ตั้งแต่วันแรกเป็นหน้าที่ของ BFF)
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

/** ความยาวขั้นต่ำของเหตุผล (mirror zod ของ BFF — แบบแผน revoke/D-p5-6) */
export const REASON_MIN_LENGTH = 10;

/** pure — เหตุผลผ่านเงื่อนไข — trim แล้วยาว ≥10 (mirror BFF) */
export function reasonValid(reason: string): boolean {
  return reason.trim().length >= REASON_MIN_LENGTH;
}

/** มุมมองสถานะบัญชีสำหรับ badge (ทะเบียนไทย + โทนตาม StatusBadge) */
export const USER_STATUS_VIEW: Record<string, { label: string; tone: "success" | "danger" | "neutral" }> = {
  active: { label: "ใช้งาน", tone: "success" },
  disabled: { label: "ปิดใช้งาน", tone: "danger" },
  banned: { label: "ปิดใช้งาน", tone: "danger" },
};

/** pure — สถานะที่ไม่รู้จักแสดงเป็นกลาง ไม่ตัดสินแทน (ค่าจริงมาจาก BFF) */
export function userStatusViewOf(status: string): { label: string; tone: "success" | "danger" | "neutral" } {
  const known = USER_STATUS_VIEW[status];
  return known ?? { label: status, tone: "neutral" };
}

/** ป้ายบทบาทไทย (จากทะเบียน ROLES ของ src/lib/rbac.ts) */
export const ROLE_LABEL_TH: Record<string, string> = {
  citizen: "ประชาชน",
  lawyer: "ทนายความ",
  instructor: "ผู้สอน",
  "staff:viewer": "เจ้าหน้าที่ (ดูข้อมูล)",
  "staff:content": "เจ้าหน้าที่ (เนื้อหา)",
  "staff:exam": "เจ้าหน้าที่ (สอบ)",
  "staff:registrar": "เจ้าหน้าที่ (ทะเบียน)",
  super_admin: "ผู้ดูแลระบบสูงสุด",
};

/** pure — บทบาทที่ไม่อยู่ในทะเบียนแสดงรหัสเดิม (ไม่เดาความหมาย) */
export function roleLabelOf(role: string): string {
  return ROLE_LABEL_TH[role] ?? role;
}

/** ชุดบทบาทที่มอบได้ผ่าน endpoint (super_admin ห้ามผ่าน endpoint — bootstrap เท่านั้น) */
export const GRANTABLE_ROLES = [
  "lawyer",
  "instructor",
  "staff:viewer",
  "staff:content",
  "staff:exam",
  "staff:registrar",
] as const;

/** pure — ตัวเลือกบทบาทต่อผู้เรียก (spec แถว 214: registrar มอบได้เฉพาะ lawyer) */
export function roleOptionsForCaller(roles: readonly string[]): readonly string[] {
  if (roles.includes("super_admin")) {
    return GRANTABLE_ROLES;
  }
  if (roles.includes("staff:registrar")) {
    return ["lawyer"];
  }
  return [];
}

/** pure — มีสิทธิ์ปิด/เปิดใช้งานบัญชี (spec แถว 212) */
export function canDisableUser(roles: readonly string[]): boolean {
  return roles.includes("super_admin") || roles.includes("staff:registrar");
}

/** pure — มีสิทธิ์มอบ/ถอดบทบาท (spec แถว 214-215) */
export function canManageRoles(roles: readonly string[]): boolean {
  return roles.includes("super_admin") || roles.includes("staff:registrar");
}

/** pure — บอดี้ของ PATCH ปิดใช้งาน (reason ตัดช่องว่างก่อนส่ง — mirror BFF) */
export function buildDisableBody(reason: string): { action: "disable"; reason: string } {
  return { action: "disable", reason: reason.trim() };
}

/** pure — บอดี้ของ PATCH เปิดใช้งาน (ไม่มี reason — BFF ไม่เรียกใช้ตอน enable) */
export function buildEnableBody(): { action: "enable" } {
  return { action: "enable" };
}

/** pure — บอดี้ของ POST มอบบทบาท */
export function buildGrantRoleBody(role: string, reason: string): { role: string; reason: string } {
  return { role, reason: reason.trim() };
}

/** pure — path ของ DELETE ถอดบทบาท (role ผูกใน query — ไม่แนบ body) */
export function roleRevokePath(userId: string, role: string): string {
  return `/api/v1/admin/users/${encodeURIComponent(userId)}/roles?role=${encodeURIComponent(role)}`;
}

/** pure — path ของ PATCH/POST ต่อผู้ใช้ (กัน id ว่าง/มีตัวอักษรควบคุม) */
export function userActionPath(userId: string): string {
  return `/api/v1/admin/users/${encodeURIComponent(userId)}`;
}

/** uuid แบบง่าย — กันส่ง id มั่ว ๆ ขึ้น BFF (BFF ยังตรวจซ้ำเสมอ) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pure — id รูปแบบ uuid หรือไม่ */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** ฟอร์มสร้างบัญชีเจ้าหน้าที่ (mirror POST /admin/users — super_admin) */
export type CreateStaffFormState = {
  email: string;
  displayName: string;
  role: string;
};

/** ค่าเริ่มต้นของฟอร์มสร้างบัญชี */
export const CREATE_STAFF_FORM_DEFAULTS: CreateStaffFormState = {
  email: "",
  displayName: "",
  role: "",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** pure — ตรวจฟอร์มสร้างบัญชี — คืนข้อความไทยต่อช่อง ({} = ผ่านทั้งหมด) */
export function validateCreateStaffForm(
  form: CreateStaffFormState,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (EMAIL_PATTERN.test(form.email.trim()) === false) {
    errors["email"] = "รูปแบบอีเมลไม่ถูกต้อง";
  }
  const name = form.displayName.trim();
  if (name.length < 1 || name.length > 120) {
    errors["displayName"] = "ชื่อ-นามสกุลต้องยาว 1-120 ตัวอักษร";
  }
  if (form.role.length === 0) {
    errors["role"] = "เลือกบทบาทเริ่มต้นของบัญชี";
  }
  return errors;
}

/** pure — บอดี้ของ POST สร้างบัญชี (camelCase เป๊ะ ไม่แนบคีย์ว่าง) */
export function buildCreateStaffBody(form: CreateStaffFormState):
  | { ok: true; body: { email: string; displayName: string; role: string } }
  | { ok: false } {
  const errors = validateCreateStaffForm(form);
  if (Object.keys(errors).length > 0) {
    return { ok: false };
  }
  return {
    ok: true,
    body: {
      email: form.email.trim(),
      displayName: form.displayName.trim(),
      role: form.role,
    },
  };
}

/** pure — มีสิทธิ์สร้างบัญชีเจ้าหน้าที่ (POST /admin/users — super_admin เท่านั้น · spec แถว 211) */
export function canCreateStaffUser(roles: readonly string[]): boolean {
  return roles.includes("super_admin");
}

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
    hint: "เลือกบทบาทที่ต้องการถอด — บัญชีต้องเหลือบทบาทไว้อย่างน้อย 1 บทบาทเสมอ",
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

  const isDisabledAccount = status === "disabled" || status === "banned";

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
      await deleteAdminJson(roleRevokePath(userId, selectedRole));
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
      {canDisable && isDisabledAccount === false ? (
        <button
          type="button"
          onClick={() => setModal("disable")}
          className="rounded-[10px] border border-danger-600 bg-white px-3 py-1.5 text-sm font-semibold text-danger-600 hover:bg-danger-50"
        >
          ปิดใช้งาน
        </button>
      ) : null}
      {canDisable && isDisabledAccount ? (
        <button
          type="button"
          onClick={() => setModal("enable")}
          className="rounded-[10px] border border-brand-600 bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          เปิดใช้งาน
        </button>
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
          (modal === "grant" && reasonValid(reason) === false) ||
          submitting
        }
        confirmDisabledReason={
          submitting
            ? "กำลังส่งข้อมูล โปรดรอสักครู่"
            : selectedRole.length === 0
              ? "เลือกบทบาทก่อนยืนยัน"
              : modal === "grant" && reasonValid(reason) === false
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
          {modal === "grant" ? (
            <ReasonField
              id={`grant-reason-${userId}`}
              label="เหตุผลที่มอบบทบาท (บังคับ)"
              value={reason}
              onChange={setReason}
              hint="เหตุผลจะถูกบันทึกในบันทึกการตรวจสอบ (audit) — ยาวอย่างน้อย 10 ตัวอักษร"
            />
          ) : (
            <p className="text-xs text-ink-500">
              การถอดบทบาทไม่ต้องระบุเหตุผลในแบบฟอร์ม — ระบบบันทึกผู้ถอดและเวลาในบันทึกการตรวจสอบให้อัตโนมัติ
            </p>
          )}
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
          </div>
        </div>
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>
    </div>
  );
}
