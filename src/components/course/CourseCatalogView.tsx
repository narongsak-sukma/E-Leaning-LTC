"use client";

/**
 * ส่วนตัวของหน้าแคตตาล็อก (client) — ช่องค้นหา + กรองหมวด/กลุ่มเป้าหมาย + กริดการ์ด + EmptyState
 * ตัวกรองทำงานกับข้อมูลที่รับมาจาก props (BFF จริงผ่าน src/lib/fixtures/catalog.ts — รูป props ตาม API-SPEC §3.3)
 * เงื่อนไขรวมแบบ AND ตาม CAT-003 AC
 */

import { useMemo, useState } from "react";

import { CourseCard } from "@/components/course/CourseCard";
import { EmptyState } from "@/components/course/EmptyState";
import { SearchIcon } from "@/components/course/icons";
import type { CatalogCategory, CourseListResponse } from "@/lib/fixtures/catalog";

type AudienceFilter = "all" | "public" | "lawyer";

const AUDIENCE_OPTIONS: { value: AudienceFilter; label: string }[] = [
  { value: "all", label: "ทุกกลุ่มเป้าหมาย" },
  { value: "public", label: "สาธารณะ" },
  { value: "lawyer", label: "เฉพาะทนายความ" },
];

export function CourseCatalogView({
  categories,
  list,
}: {
  categories: CatalogCategory[];
  list: CourseListResponse;
}) {
  const [keyword, setKeyword] = useState("");
  const [categorySlug, setCategorySlug] = useState<"all" | string>("all");
  const [audience, setAudience] = useState<AudienceFilter>("all");

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return list.data.filter((course) => {
      const matchesKeyword =
        q.length === 0 ||
        course.titleTh.toLowerCase().includes(q) ||
        (course.titleEn?.toLowerCase().includes(q) ?? false) ||
        (course.summary?.toLowerCase().includes(q) ?? false);
      const matchesCategory = categorySlug === "all" || course.category.slug === categorySlug;
      const matchesAudience =
        audience === "all" ||
        (audience === "public" && course.isPublic) ||
        (audience === "lawyer" && !course.isPublic);
      return matchesKeyword && matchesCategory && matchesAudience;
    });
  }, [audience, categorySlug, keyword, list.data]);

  const hasActiveFilter =
    keyword.trim().length > 0 || categorySlug !== "all" || audience !== "all";

  function clearFilters() {
    setKeyword("");
    setCategorySlug("all");
    setAudience("all");
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* ───────── แถบตัวกรอง ───────── */}
      <aside aria-label="ตัวกรองหลักสูตร" className="lg:sticky lg:top-24 lg:self-start">
        <form
          className="flex flex-col gap-6 rounded-[14px] border border-mist-200 bg-white p-5 shadow-card"
          onSubmit={(event) => event.preventDefault()}
        >
          <div>
            <label
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
              htmlFor="course-search"
            >
              ค้นหาหลักสูตร
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-400">
                <SearchIcon size={18} />
              </span>
              <input
                className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white py-2.5 pe-3.5 ps-10 text-ink-900 placeholder:text-ink-400"
                aria-describedby="course-search-help"
                id="course-search"
                placeholder="เช่น สัญญาเช่า จรรยาบรรณ"
                type="search"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
            <p className="mt-1.5 text-sm text-ink-500" id="course-search-help">
              ค้นจากชื่อหรือคำอธิบายหลักสูตร (ไทย/อังกฤษ)
            </p>
          </div>

          <fieldset>
            <legend className="mb-2 font-heading text-sm font-semibold text-ink-900">หมวดหลักสูตร</legend>
            <div className="flex flex-wrap gap-2 lg:flex-col">
              <button
                aria-pressed={categorySlug === "all"}
                className={chipClass(categorySlug === "all")}
                type="button"
                onClick={() => setCategorySlug("all")}
              >
                ทุกหมวด
              </button>
              {categories.map((category) => (
                <button
                  aria-pressed={categorySlug === category.slug}
                  className={chipClass(categorySlug === category.slug)}
                  key={category.id}
                  type="button"
                  onClick={() => setCategorySlug(category.slug)}
                >
                  {category.nameTh}
                  <span className="tabular-nums text-sm"> ({category.courseCount})</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label
              className="mb-1.5 block font-heading text-sm font-semibold text-ink-900"
              htmlFor="course-audience"
            >
              กลุ่มเป้าหมาย
            </label>
            <select
              className="w-full rounded-[10px] border-[1.5px] border-mist-300 bg-white px-3.5 py-2.5 text-ink-900"
              id="course-audience"
              value={audience}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "all" || value === "public" || value === "lawyer") {
                  setAudience(value);
                }
              }}
            >
              {AUDIENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {hasActiveFilter ? (
            <button
              className="self-start text-sm font-semibold text-brand-600 underline hover:text-brand-700"
              type="button"
              onClick={clearFilters}
            >
              ล้างตัวกรองทั้งหมด
            </button>
          ) : null}
        </form>
      </aside>

      {/* ───────── ผลลัพธ์ ───────── */}
      <section aria-label="รายการหลักสูตร">
        <p aria-live="polite" className="text-sm text-ink-500">
          พบหลักสูตร <span className="tabular-nums font-semibold text-ink-700">{filtered.length}</span> รายการ
        </p>
        {filtered.length > 0 ? (
          <ul className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((course) => (
              <li key={course.id}>
                <CourseCard course={course} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4">
            <EmptyState
              actionLabel="ล้างตัวกรองทั้งหมด"
              description="ลองเปลี่ยนคำค้นหรือเลือกหมวดอื่น แล้วค้นหาอีกครั้ง"
              title="ไม่พบหลักสูตรตามเงื่อนไขที่เลือก"
              onAction={clearFilters}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function chipClass(active: boolean): string {
  return active
    ? "rounded-full bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white"
    : "rounded-full border border-mist-300 bg-white px-3.5 py-1.5 text-sm font-medium text-ink-600 hover:border-brand-500 hover:text-brand-700";
}
