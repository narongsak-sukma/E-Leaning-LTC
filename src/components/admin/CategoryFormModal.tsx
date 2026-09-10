"use client";

import { useState } from "react";
import type { AdminCategory } from "@/lib/fixtures/admin";
import { ConfirmModal } from "./ConfirmModal";

/**
 * ปุ่ม "เพิ่มหมวด" + Modal ฟอร์มหมวดหลักสูตร — DESIGN-SYSTEM §5.2 (Input) + §5.8 (Modal)
 *
 * Phase 0 (skeleton): ฟอร์มเปิดและกรอกได้ในเครื่องผู้ใช้เท่านั้น ปุ่มบันทึก disabled
 * พร้อมคำอธิบายตรงไปตรงมาว่าจะเชื่อมต่อ POST /api/v1/admin/categories ในเฟสถัดไป
 * แสดงเฉพาะบทบาทที่มีสิทธิ์สร้างหมวด (staff:content / super_admin — RBAC §2 + API §3.8)
 */

const NEXT_PHASE_NOTE =
  "ยังไม่เชื่อมต่อ API — จะบันทึกผ่าน POST /api/v1/admin/categories ในเฟสถัดไป (Phase 1)";

const INPUT_CLASS =
  "w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900 placeholder:text-ink-400 disabled:cursor-not-allowed disabled:border-mist-200 disabled:bg-mist-100 disabled:text-ink-500";

export function CategoryFormModal({
  parentOptions,
  canCreate,
}: {
  parentOptions: ReadonlyArray<AdminCategory>;
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [nameTh, setNameTh] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [parentId, setParentId] = useState("");
  const [sortOrder, setSortOrder] = useState("0");

  if (!canCreate) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[10px] bg-brand-600 px-[18px] py-2.5 font-heading text-base font-semibold text-white shadow-card hover:bg-brand-700 active:translate-y-px"
      >
        เพิ่มหมวด
      </button>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        title="เพิ่มหมวดหลักสูตร"
        description="หมวดซ้อนกันได้ลึก 2 ระดับ (หมวดแม่ → หมวดลูก) — หมวดที่มีหลักสูตรอ้างอิงจะปิดใช้งานแทนการลบ"
        confirmLabel="บันทึกหมวด"
        confirmDisabled={true}
        confirmDisabledReason={NEXT_PHASE_NOTE}
      >
        <div className="grid gap-4">
          <p className="rounded-[10px] bg-warning-50 px-3 py-2 text-sm leading-relaxed text-warning-600">
            {NEXT_PHASE_NOTE}
          </p>
          <div>
            <label
              htmlFor="category-name-th"
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
            >
              ชื่อหมวด (ไทย) <span className="text-danger-600" aria-hidden="true">*</span>
              <span className="sr-only">(จำเป็น)</span>
            </label>
            <input
              id="category-name-th"
              type="text"
              value={nameTh}
              onChange={(event) => setNameTh(event.target.value)}
              className={INPUT_CLASS}
              placeholder="เช่น กฎหมายแรงงาน"
            />
          </div>
          <div>
            <label
              htmlFor="category-name-en"
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
            >
              ชื่อหมวด (อังกฤษ)
            </label>
            <input
              id="category-name-en"
              type="text"
              value={nameEn}
              onChange={(event) => setNameEn(event.target.value)}
              className={INPUT_CLASS}
              placeholder="เช่น Labour Law"
            />
          </div>
          <div>
            <label
              htmlFor="category-parent"
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
            >
              หมวดแม่
            </label>
            <select
              id="category-parent"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">— ไม่มี (เป็นหมวดหลัก) —</option>
              {parentOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.nameTh}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="category-sort-order"
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
            >
              ลำดับการแสดงผล
            </label>
            <input
              id="category-sort-order"
              type="number"
              min={0}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      </ConfirmModal>
    </>
  );
}
