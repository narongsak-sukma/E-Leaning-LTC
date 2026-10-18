"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Search,
  Award,
  BookOpen,
  ShieldCheck,
  Users,
  Clock,
  ChevronRight,
  CheckCircle2,
  Scale,
  Lock,
  GraduationCap,
  FileCheck2,
} from "lucide-react";
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
  instructorRole: string;
  rating: number;
  enrolledCount: number;
  moduleCount: number;
  lessonCount: number;
  coverStyle: "navy" | "gold" | "teal" | "burgundy" | "slate" | "emerald";
}

interface CatalogCategory {
  id: string;
  slug: string;
  nameTh: string;
  nameEn: string;
  descriptionTh: string;
  courseCount: number;
}

const COVER_GRADIENTS: Record<string, string> = {
  navy: "from-[#0b1f3a] via-[#132f54] to-[#1a4373]",
  gold: "from-[#4a3508] via-[#7a5b14] to-[#a97c22]",
  teal: "from-[#0f2e3d] via-[#164e63] to-[#155e75]",
  burgundy: "from-[#3b0d1e] via-[#651a35] to-[#831843]",
  slate: "from-[#0f172a] via-[#1e293b] to-[#334155]",
  emerald: "from-[#063626] via-[#065f46] to-[#047857]",
};

export default function HomePage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CatalogCourse[]>([]);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [stats, setStats] = useState({
    publishedCourseCount: 6,
    registeredLearnersCount: 38427,
    issuedCertificatesCount: 19684,
    satisfactionPct: 98.4,
  });
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedAudience, setSelectedAudience] = useState<
    "all_courses" | "general" | "lawyer_only"
  >("all_courses");
  const [searchQuery, setSearchQuery] = useState("");
  const [verifyInput, setVerifyInput] = useState("LTC-2026-483920");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/catalog")
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (Array.isArray(data.courses)) setCourses(data.courses);
        if (Array.isArray(data.categories)) setCategories(data.categories);
        if (data.stats) setStats(data.stats);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filteredCourses = courses.filter((c) => {
    if (selectedCategory !== "all" && c.categoryId !== selectedCategory) {
      return false;
    }
    if (selectedAudience === "general" && c.audience !== "all") {
      return false;
    }
    if (selectedAudience === "lawyer_only" && c.audience !== "lawyer_only") {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        c.titleTh.toLowerCase().includes(q) ||
        c.titleEn.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.instructorName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  function handleVerifySubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = verifyInput.trim().toUpperCase();
    if (code) {
      router.push(`/verify/${encodeURIComponent(code)}`);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f7f8fa]">
      <PublicHeader />

      <main className="flex-1">
        {/* Institutional Hero Banner (01-home.html aligned) */}
        <section className="relative bg-gradient-to-br from-[#0b1f3a] via-[#132f54] to-[#1a4373] text-white overflow-hidden border-b border-[#c89b3c]/30">
          <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-14 lg:py-18">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
              <div className="lg:col-span-7 space-y-6">
                <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-[#e2b857]">
                  <Scale className="w-4 h-4" />
                  <span>
                    สถาบันพัฒนาวิชาชีพทนายความ · สภาทนายความ ในพระบรมราชูปถัมภ์
                  </span>
                </div>

                <h1 className="text-3xl sm:text-4xl lg:text-[42px] font-bold tracking-tight leading-[1.22] text-white">
                  ยกระดับมาตรฐานวิชาชีพทนายความ{" "}
                  <span className="text-[#e2b857]">
                    และสร้างสังคมแห่งความรู้กฎหมาย
                  </span>
                </h1>

                <p className="text-base sm:text-lg text-slate-200 leading-relaxed max-w-2xl">
                  ระบบฝึกอบรมออนไลน์ สอบวัดผลปลายหลักสูตร ออกใบประกาศนียบัตรดิจิทัล
                  และสะสมหน่วยกิตการพัฒนาวิชาชีพทนายความต่อเนื่อง (CPE Credit Bank)
                  เชื่อมโยงข้อมูลระหว่างระบบผู้เรียนและระบบนายทะเบียนอย่างปลอดภัย
                </p>

                {/* Live Search Bar */}
                <div className="bg-white p-2 rounded-2xl shadow-xl max-w-2xl flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <div className="relative flex-1 flex items-center">
                    <Search className="w-5 h-5 text-slate-400 ml-3 shrink-0" />
                    <input
                      type="text"
                      aria-label="ค้นหาหลักสูตร"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="ค้นหาชื่อหลักสูตร รหัสวิชา (เช่น LTC-102) หรือชื่อวิทยากร..."
                      className="w-full px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                  <Link
                    href={
                      searchQuery.trim()
                        ? `/courses?q=${encodeURIComponent(searchQuery.trim())}`
                        : "#catalog-section"
                    }
                    className="px-6 py-3 rounded-xl bg-[#0b1f3a] text-white text-sm font-semibold hover:bg-[#132f54] transition-colors text-center whitespace-nowrap"
                  >
                    ค้นหาหลักสูตร
                  </Link>
                </div>

                {/* Quick Filter Keywords */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <span className="text-[#e2b857] font-semibold">คำค้นยอดนิยม:</span>
                  {[
                    "มรรยาททนายความ",
                    "กฎหมายที่ประชาชนควรรู้",
                    "PDPA",
                    "ร่างสัญญาเช่า",
                    "ว่าความคดีแพ่ง",
                  ].map((kw) => (
                    <button
                      key={kw}
                      type="button"
                      onClick={() => setSearchQuery(kw)}
                      className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                    >
                      {kw}
                    </button>
                  ))}
                </div>
              </div>

              {/* Right Column: Dual-Portal Access + Certificate Verification Card */}
              <div className="lg:col-span-5 space-y-4">
                <div className="rounded-2xl bg-white/10 backdrop-blur-md border border-white/15 p-6 space-y-5">
                  <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <div>
                      <div className="text-xs font-semibold text-[#e2b857] uppercase tracking-wider">
                        สถาปัตยกรรม 2 พอร์ทัลแยกส่วน
                      </div>
                      <h2 className="text-lg font-bold text-white mt-0.5">
                        เลือกช่องทางเข้าใช้งานระบบ
                      </h2>
                    </div>
                    <ShieldCheck className="w-7 h-7 text-[#e2b857]" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Link
                      href="/login"
                      className="p-4 rounded-xl bg-white text-[#0b1f3a] hover:bg-amber-50 transition-colors flex flex-col justify-between group"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <GraduationCap className="w-5 h-5 text-[#0b1f3a]" />
                        <ChevronRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-[#7a5b14]">
                          1. FRONTOFFICE PORTAL
                        </div>
                        <div className="text-sm font-bold text-[#0b1f3a] mt-0.5">
                          สำหรับผู้เรียน / ทนายความ
                        </div>
                        <div className="text-xs text-slate-600 mt-1">
                          เข้าเรียน · สอบวัดผล · ดูหน่วยกิต CPE · ดาวน์โหลดใบประกาศ
                        </div>
                      </div>
                    </Link>

                    <Link
                      href="/backoffice/login"
                      className="p-4 rounded-xl bg-[#071529] text-white border border-[#c89b3c]/40 hover:border-[#e2b857] transition-colors flex flex-col justify-between group"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <Lock className="w-5 h-5 text-[#e2b857]" />
                        <ChevronRight className="w-4 h-4 text-[#e2b857] group-hover:translate-x-0.5 transition-transform" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-[#e2b857]">
                          2. BACKOFFICE PORTAL
                        </div>
                        <div className="text-sm font-bold text-white mt-0.5">
                          สำหรับเจ้าหน้าที่ / วิทยากร
                        </div>
                        <div className="text-xs text-slate-300 mt-1">
                          ตรวจใบอนุญาต · อนุมัติหลักสูตร · คลังข้อสอบ · Audit Log
                        </div>
                      </div>
                    </Link>
                  </div>

                  {/* Quick Certificate Verification Box */}
                  <form
                    onSubmit={handleVerifySubmit}
                    className="pt-4 border-t border-white/10 space-y-2"
                  >
                    <label
                      htmlFor="home-verify-code"
                      className="block text-xs font-semibold text-slate-200"
                    >
                      ตรวจสอบความถูกต้องของใบประกาศนียบัตรดิจิทัล (PDPA-Minimal):
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="home-verify-code"
                        type="text"
                        value={verifyInput}
                        onChange={(e) => setVerifyInput(e.target.value)}
                        placeholder="เช่น LTC-2026-483920"
                        className="flex-1 px-3.5 py-2 rounded-xl bg-white/10 border border-white/20 text-sm font-mono text-white placeholder:text-slate-400 focus:outline-none focus:border-[#e2b857]"
                      />
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold hover:bg-[#e2b857] transition-colors whitespace-nowrap cursor-pointer"
                      >
                        ตรวจสอบทันที
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>

            {/* 4 Institutional KPI Strip */}
            <div className="mt-12 pt-8 border-t border-white/15 grid grid-cols-2 lg:grid-cols-4 gap-6">
              <div>
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-[#e2b857]">
                  {stats.publishedCourseCount} หลักสูตร
                </div>
                <div className="text-xs sm:text-sm text-slate-300 mt-1">
                  หลักสูตรมาตรฐานสภาทนายความที่เปิดสอน
                </div>
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-white">
                  {stats.registeredLearnersCount.toLocaleString()} คน
                </div>
                <div className="text-xs sm:text-sm text-slate-300 mt-1">
                  ทนายความและประชาชนผู้ลงทะเบียนเรียน
                </div>
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-white">
                  {stats.issuedCertificatesCount.toLocaleString()} ฉบับ
                </div>
                <div className="text-xs sm:text-sm text-slate-300 mt-1">
                  ประกาศนียบัตรดิจิทัลที่ออกและตรวจสอบได้
                </div>
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-[#e2b857]">
                  {stats.satisfactionPct}%
                </div>
                <div className="text-xs sm:text-sm text-slate-300 mt-1">
                  อัตราความพึงพอใจจากผู้เข้าอบรมทั่วประเทศ
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Categories Strip */}
        <section className="py-12 max-w-[1320px] mx-auto px-4 sm:px-6">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
            <div>
              <div className="text-xs font-semibold text-[#7a5b14] uppercase tracking-wider">
                หมวดหมู่วิชาการและวิชาชีพ
              </div>
              <h2 className="text-2xl font-bold text-[#0b1f3a] mt-1">
                เลือกเรียนตามหมวดหมู่กฎหมาย
              </h2>
            </div>
            <Link
              href="/courses"
              className="text-sm font-semibold text-[#1a4373] hover:text-[#0b1f3a] inline-flex items-center gap-1"
            >
              <span>ดูหลักสูตรทั้งหมดในแคตตาล็อก</span>
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {categories.map((cat) => {
              const isSelected = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() =>
                    setSelectedCategory(isSelected ? "all" : cat.id)
                  }
                  className={`p-5 rounded-xl border text-left transition-all cursor-pointer ${
                    isSelected
                      ? "bg-[#0b1f3a] text-white border-[#0b1f3a] shadow-md"
                      : "bg-white text-slate-900 border-slate-200 hover:border-[#1a4373]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-base">{cat.nameTh}</span>
                    <span
                      className={`text-xs font-mono tabular-nums ${
                        isSelected ? "text-[#e2b857]" : "text-slate-500"
                      }`}
                    >
                      {cat.courseCount} หลักสูตร
                    </span>
                  </div>
                  <p
                    className={`text-xs mt-1.5 line-clamp-2 ${
                      isSelected ? "text-slate-200" : "text-slate-500"
                    }`}
                  >
                    {cat.descriptionTh}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* Course Catalog Showcase */}
        <section
          id="catalog-section"
          className="pb-16 max-w-[1320px] mx-auto px-4 sm:px-6"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-200">
            <div>
              <h2 className="text-2xl font-bold text-[#0b1f3a]">
                หลักสูตรที่เปิดรับลงทะเบียน
              </h2>
              <p className="text-sm text-slate-500 mt-0.5">
                แสดงผล{" "}
                <span className="font-semibold text-slate-800 tabular-nums">
                  {filteredCourses.length}
                </span>{" "}
                หลักสูตรจากฐานข้อมูลกลาง
              </p>
            </div>

            {/* Interactive Audience Filter */}
            <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-200/70 rounded-xl">
              <button
                type="button"
                onClick={() => setSelectedAudience("all_courses")}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  selectedAudience === "all_courses"
                    ? "bg-white text-[#0b1f3a] shadow-sm"
                    : "text-slate-600 hover:text-[#0b1f3a]"
                }`}
              >
                ทุกกลุ่มผู้เรียน ({courses.length})
              </button>
              <button
                type="button"
                onClick={() => setSelectedAudience("general")}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  selectedAudience === "general"
                    ? "bg-white text-[#0b1f3a] shadow-sm"
                    : "text-slate-600 hover:text-[#0b1f3a]"
                }`}
              >
                ประชาชนทั่วไปเรียนได้
              </button>
              <button
                type="button"
                onClick={() => setSelectedAudience("lawyer_only")}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  selectedAudience === "lawyer_only"
                    ? "bg-white text-[#0b1f3a] shadow-sm"
                    : "text-slate-600 hover:text-[#0b1f3a]"
                }`}
              >
                เฉพาะทนายความ (สะสมหน่วยกิต CPE)
              </button>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-80 rounded-2xl bg-white border border-slate-200 p-6 animate-pulse"
                />
              ))}
            </div>
          ) : filteredCourses.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-3">
              <BookOpen className="w-10 h-10 text-slate-400 mx-auto" />
              <div className="text-base font-bold text-slate-800">
                ไม่พบหลักสูตรที่ตรงกับเงื่อนไขการค้นหา
              </div>
              <p className="text-sm text-slate-500">
                ลองล้างตัวกรองหมวดหมู่หรือคำค้นหาเพื่อดูหลักสูตรทั้งหมดที่เปิดสอน
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory("all");
                  setSelectedAudience("all_courses");
                  setSearchQuery("");
                }}
                className="px-4 py-2 rounded-lg bg-[#0b1f3a] text-white text-xs font-semibold"
              >
                แสดงหลักสูตรทั้งหมด
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredCourses.map((course) => {
                const gradient =
                  COVER_GRADIENTS[course.coverStyle] || COVER_GRADIENTS.navy;
                return (
                  <article
                    key={course.id}
                    className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col justify-between hover:border-[#1a4373] transition-colors"
                  >
                    <div>
                      {/* Course Cover Header */}
                      <div
                        className={`bg-gradient-to-br ${gradient} p-6 text-white relative`}
                      >
                        <div className="flex items-center justify-between text-xs text-slate-200 mb-3">
                          <span className="font-mono font-semibold text-[#e2b857]">
                            {course.code}
                          </span>
                          <span>
                            {course.audience === "lawyer_only"
                              ? "เฉพาะทนายความ · สะสมหน่วยกิต"
                              : "เปิดทั่วไป · ประชาชนและทนายความ"}
                          </span>
                        </div>
                        <h3 className="text-lg font-bold text-white leading-snug line-clamp-2">
                          {course.titleTh}
                        </h3>
                        <p className="text-xs text-slate-300 mt-1 line-clamp-1">
                          {course.titleEn}
                        </p>
                      </div>

                      {/* Course Metadata & Description */}
                      <div className="p-6 space-y-4">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-medium text-slate-700">
                            {course.categoryNameTh}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums font-semibold text-[#7a5b14]">
                            {course.credits} หน่วยกิต CPE
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {Math.round(course.durationMinutes / 60)} ชม. (
                            {course.lessonCount} บทเรียน)
                          </span>
                        </div>

                        <p className="text-sm text-slate-600 leading-relaxed line-clamp-2">
                          {course.subtitleTh}
                        </p>

                        <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                          <div className="truncate">
                            วิทยากร:{" "}
                            <span className="font-medium text-slate-800">
                              {course.instructorName}
                            </span>
                          </div>
                          <div className="font-mono tabular-nums shrink-0">
                            ผู้เรียน {course.enrolledCount.toLocaleString()} คน
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="px-6 pb-6">
                      <Link
                        href={`/courses/${course.id}`}
                        className="w-full py-2.5 px-4 rounded-xl bg-[#0b1f3a] text-white text-sm font-semibold hover:bg-[#132f54] transition-colors flex items-center justify-center gap-2"
                      >
                        <span>ดูรายละเอียด / เข้าเรียน</span>
                        <ChevronRight className="w-4 h-4 text-[#e2b857]" />
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* CPE Credit Bank Institutional Explanation Section */}
        <section className="bg-white border-t border-slate-200 py-14">
          <div className="max-w-[1320px] mx-auto px-4 sm:px-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              <div className="lg:col-span-7 space-y-4">
                <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
                  CONTINUING PROFESSIONAL EDUCATION (CPE CREDIT BANK)
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold text-[#0b1f3a]">
                  กระบวนการเรียน สอบวัดผล และสะสมหน่วยกิตทนายความครบวงจร
                </h2>
                <p className="text-sm text-slate-600 leading-relaxed max-w-2xl">
                  ทุกขั้นตอนตั้งแต่การลงทะเบียนเรียน การบันทึกความคืบหน้าบทเรียน การสอบปลายหลักสูตร
                  การออกใบประกาศนียบัตรดิจิทัล และการสะสมหน่วยกิตเข้าบัญชีแยกประเภท
                  (Immutable Credit Ledger) ทำงานผ่านเซิร์ฟเวอร์ API กลางที่มีการควบคุมสิทธิ์ตามมาตรฐานสภาทนายความ
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                  <div className="p-4 rounded-xl bg-[#f7f8fa] border border-slate-200">
                    <div className="text-xs font-mono font-bold text-[#7a5b14]">
                      STEP 01
                    </div>
                    <div className="text-sm font-bold text-[#0b1f3a] mt-1">
                      ศึกษาบทเรียนครบตามเกณฑ์
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      เรียนรู้ผ่านวิดีทัศน์ เอกสารประกอบ และแบบฝึกหัดทบทวนความเข้าใจในแต่ละโมดูล
                    </p>
                  </div>
                  <div className="p-4 rounded-xl bg-[#f7f8fa] border border-slate-200">
                    <div className="text-xs font-mono font-bold text-[#7a5b14]">
                      STEP 02
                    </div>
                    <div className="text-sm font-bold text-[#0b1f3a] mt-1">
                      สอบวัดผลปลายหลักสูตร
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      ระบบสุ่มข้อสอบจากคลังข้อสอบและตรวจให้คะแนนที่ฝั่งเซิร์ฟเวอร์ทันที (เกณฑ์ผ่าน 70–75%)
                    </p>
                  </div>
                  <div className="p-4 rounded-xl bg-[#f7f8fa] border border-slate-200">
                    <div className="text-xs font-mono font-bold text-[#7a5b14]">
                      STEP 03
                    </div>
                    <div className="text-sm font-bold text-[#0b1f3a] mt-1">
                      รับใบประกาศ & หน่วยกิต CPE
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      ออกรหัสใบประกาศ LTC-2026-XXXXXX และบันทึกหน่วยกิตเข้า Credit Bank อัตโนมัติ
                    </p>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-5">
                <div className="p-6 rounded-2xl bg-[#0b1f3a] text-white border border-[#c89b3c]/40 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#e2b857]">
                      ตัวอย่างสถานะสมุดสะสมหน่วยกิต (รอบปี พ.ศ. 2569)
                    </span>
                    <span className="text-xs font-mono text-emerald-400">
                      ● เกณฑ์ปกติ (12 หน่วยกิต/ปี)
                    </span>
                  </div>
                  <div className="p-4 rounded-xl bg-white/10 space-y-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-slate-200">
                        ธนกร วัฒนกุล (ทล. 25891)
                      </span>
                      <span className="text-xl font-bold font-mono tabular-nums text-[#e2b857]">
                        8.0 / 12.0 หน่วยกิต
                      </span>
                    </div>
                    <div className="w-full h-2.5 rounded-full bg-white/15 overflow-hidden">
                      <div
                        className="h-full bg-[#e2b857] rounded-full"
                        style={{ width: "67%" }}
                      />
                    </div>
                    <div className="text-xs text-slate-300 flex items-center justify-between pt-1">
                      <span>สะสมแล้ว 67% ของเกณฑ์ประจำปี</span>
                      <span>ขาดอีก 4.0 หน่วยกิต</span>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
                    <Link
                      href="/login"
                      className="flex-1 py-2.5 px-4 rounded-xl bg-[#c89b3c] text-[#0b1f3a] text-xs font-bold text-center hover:bg-[#e2b857] transition-colors"
                    >
                      เข้าดูหน่วยกิตของคุณ (Frontoffice)
                    </Link>
                    <Link
                      href="/backoffice/login"
                      className="flex-1 py-2.5 px-4 rounded-xl bg-white/10 text-white text-xs font-semibold text-center hover:bg-white/20 transition-colors"
                    >
                      ระบบนายทะเบียน (Backoffice)
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
