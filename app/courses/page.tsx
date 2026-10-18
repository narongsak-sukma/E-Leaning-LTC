"use client";

import React, { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search, BookOpen, ChevronRight, Filter } from "lucide-react";
import { PublicHeader, PublicFooter } from "@/components/ltc/PublicShell";

interface CatalogCourse {
  id: string;
  code: string;
  slug: string;
  titleTh: string;
  titleEn: string;
  subtitleTh: string;
  categoryId: string;
  categoryNameTh: string;
  audience: "all" | "lawyer_only";
  credits: number;
  durationMinutes: number;
  instructorName: string;
  enrolledCount: number;
  lessonCount: number;
}

interface CatalogCategory {
  id: string;
  nameTh: string;
  courseCount: number;
}

function CatalogContent() {
  const searchParams = useSearchParams();
  const initialAudience = searchParams.get("audience") || "all";
  const initialQuery = searchParams.get("q") || "";

  const [courses, setCourses] = useState<CatalogCourse[]>([]);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [categoryId, setCategoryId] = useState("all");
  const [audience, setAudience] = useState(initialAudience);
  const [search, setSearch] = useState(initialQuery);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/catalog")
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (Array.isArray(data.courses)) setCourses(data.courses);
        if (Array.isArray(data.categories)) setCategories(data.categories);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = courses.filter((c) => {
    if (categoryId !== "all" && c.categoryId !== categoryId) return false;
    if (audience === "lawyer_only" && c.audience !== "lawyer_only") return false;
    if (audience === "general" && c.audience !== "all") return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        c.titleTh.toLowerCase().includes(q) ||
        c.titleEn.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.instructorName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      <PublicHeader />

      <main className="flex-1 max-w-[1320px] w-full mx-auto px-4 sm:px-6 py-10">
        <div className="bg-[#0b1f3a] text-white rounded-2xl p-6 sm:p-8 mb-8 border border-[#c89b3c]/30">
          <div className="text-xs font-semibold text-[#e2b857] uppercase tracking-wider">
            COURSE CATALOG · คลังหลักสูตรสภาทนายความ
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold mt-1">
            ค้นหาและเลือกเรียนหลักสูตรออนไลน์
          </h1>
          <p className="text-sm text-slate-300 mt-1 max-w-2xl">
            หลักสูตรที่ได้รับการอนุมัติและเผยแพร่จากฝ่ายวิชาการและทะเบียนสภาทนายความ
            เชื่อมโยงกับสมุดสะสมหน่วยกิต (CPE Credit Bank) โดยตรง
          </p>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-6 relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="ค้นหาหลักสูตรในแคตตาล็อก"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาชื่อหลักสูตร รหัสวิชา หรือชื่อวิทยากร..."
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white text-slate-900 text-sm focus:outline-none"
              />
            </div>

            <div className="md:col-span-3">
              <select
                aria-label="เลือกหมวดหมู่หลักสูตร"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white text-slate-900 text-sm focus:outline-none"
              >
                <option value="all">ทุกหมวดหมู่กฎหมาย</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.nameTh} ({cat.courseCount})
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-3">
              <select
                aria-label="เลือกกลุ่มผู้เรียน"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-white text-slate-900 text-sm focus:outline-none"
              >
                <option value="all">ทุกกลุ่มผู้เรียน</option>
                <option value="general">ประชาชนทั่วไปและทนายความ</option>
                <option value="lawyer_only">เฉพาะทนายความ (CPE)</option>
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-sm text-slate-500">
            กำลังโหลดข้อมูลหลักสูตร...
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-3">
            <BookOpen className="w-10 h-10 text-slate-400 mx-auto" />
            <div className="text-base font-bold text-slate-800">
              ไม่พบหลักสูตรที่ตรงกับเงื่อนไข
            </div>
            <button
              type="button"
              onClick={() => {
                setCategoryId("all");
                setAudience("all");
                setSearch("");
              }}
              className="px-4 py-2 rounded-lg bg-[#0b1f3a] text-white text-xs font-semibold"
            >
              รีเซ็ตตัวกรอง
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((course) => (
              <article
                key={course.id}
                className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col justify-between hover:border-[#1a4373] transition-colors"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-mono font-bold text-[#0b1f3a]">
                      {course.code}
                    </span>
                    <span>
                      {course.audience === "lawyer_only"
                        ? "เฉพาะทนายความ"
                        : "ประชาชนทั่วไป / ทนายความ"}
                    </span>
                  </div>

                  <h2 className="text-lg font-bold text-[#0b1f3a] leading-snug">
                    {course.titleTh}
                  </h2>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{course.categoryNameTh}</span>
                    <span>·</span>
                    <span className="font-semibold text-[#7a5b14] font-mono tabular-nums">
                      {course.credits} หน่วยกิต CPE
                    </span>
                    <span>·</span>
                    <span className="tabular-nums">
                      {course.lessonCount} บทเรียน
                    </span>
                  </div>

                  <p className="text-sm text-slate-600 line-clamp-2">
                    {course.subtitleTh}
                  </p>
                </div>

                <div className="pt-5 mt-5 border-t border-slate-100 space-y-3">
                  <div className="text-xs text-slate-500 flex items-center justify-between">
                    <span>วิทยากร: {course.instructorName}</span>
                    <span className="font-mono tabular-nums">
                      {course.enrolledCount.toLocaleString()} คน
                    </span>
                  </div>

                  <Link
                    href={`/courses/${course.id}`}
                    className="w-full py-2.5 px-4 rounded-xl bg-[#0b1f3a] text-white text-sm font-semibold hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2"
                  >
                    <span>ดูรายละเอียดหลักสูตร</span>
                    <ChevronRight className="w-4 h-4 text-[#e2b857]" />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>

      <PublicFooter />
    </div>
  );
}

export default function CoursesCatalogPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#f7f8fa] text-sm text-slate-500">
          กำลังโหลดคลังหลักสูตร...
        </div>
      }
    >
      <CatalogContent />
    </Suspense>
  );
}
