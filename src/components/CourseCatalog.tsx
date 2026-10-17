import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Course, CourseCategory, TargetAudience } from '../types';
import { 
  Search, 
  BookOpen, 
  Award, 
  Clock, 
  CheckCircle, 
  Users, 
  Sparkles, 
  ArrowRight, 
  AlertTriangle,
  Scale,
  GraduationCap
} from 'lucide-react';

interface CourseCatalogProps {
  onSelectCourse: (course: Course) => void;
  onEnterClassroom: (courseId: string) => void;
}

export const CourseCatalog: React.FC<CourseCatalogProps> = ({ 
  onSelectCourse, 
  onEnterClassroom 
}) => {
  const { courses, enrollments, currentUser, enrollCourse, setActiveTab } = useApp();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAudience, setSelectedAudience] = useState<TargetAudience>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'popular' | 'credits' | 'rating'>('popular');

  const categories: { key: string; label: string }[] = [
    { key: 'all', label: 'ทุกหมวดวิชา' },
    { key: 'ethics', label: '⚖️ จริยธรรมและมรรยาท (บังคับ)' },
    { key: 'substantive', label: '📜 กฎหมายสารบัญญัติ' },
    { key: 'procedural', label: '🏛️ การว่าความและวิธีพิจารณา' },
    { key: 'emerging_tech', label: '💻 เทคโนโลยี & PDPA' },
    { key: 'public_law', label: '🎓 กฎหมายเพื่อประชาชน' },
  ];

  const filteredCourses = courses.filter(course => {
    // Audience filter
    if (selectedAudience !== 'all' && course.targetAudience !== 'all' && course.targetAudience !== selectedAudience) {
      return false;
    }

    // Category filter
    if (selectedCategory !== 'all' && course.category !== selectedCategory) {
      return false;
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = course.title.toLowerCase().includes(q);
      const matchSubtitle = course.subtitle.toLowerCase().includes(q);
      const matchCode = course.code.toLowerCase().includes(q);
      const matchInstructor = course.instructorName.toLowerCase().includes(q);
      if (!matchTitle && !matchSubtitle && !matchCode && !matchInstructor) {
        return false;
      }
    }

    return true;
  }).sort((a, b) => {
    if (sortBy === 'credits') return b.credits - a.credits;
    if (sortBy === 'rating') return b.rating - a.rating;
    return b.enrolledStudentsCount - a.enrolledStudentsCount;
  });

  const getEnrollmentForCourse = (courseId: string) => {
    return enrollments.find(e => e.userId === currentUser.id && e.courseId === courseId);
  };

  return (
    <div className="space-y-8 pb-12">
      {/* Hero Section */}
      <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 border border-slate-800 text-white p-6 sm:p-10 shadow-xl">
        <div className="absolute top-0 right-0 -mt-10 -mr-10 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 max-w-3xl">
          <div className="inline-flex items-center gap-2 bg-amber-500/20 border border-amber-500/30 text-amber-300 px-3 py-1 rounded-full text-xs font-semibold mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            <span>ระบบพัฒนาวิชาชีพต่อเนื่อง (CLE) สภาทนายความ ในพระบรมราชูปถัมภ์</span>
          </div>
          <h1 className="text-2xl sm:text-4xl font-heading font-bold text-white tracking-tight leading-tight">
            การเรียนรู้ออนไลน์ระดับมาตรฐานสากล <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-400 via-amber-300 to-yellow-200">
              เพื่อความเชี่ยวชาญและต่ออายุใบอนุญาตว่าความ
            </span>
          </h1>
          <p className="mt-3 text-slate-300 text-sm sm:text-base leading-relaxed">
            ศูนย์กลางหลักสูตรพัฒนาความรู้ทางกฎหมายสำหรับทนายความและประชาชนทั่วไป สะสมหน่วยกิตเข้าสู่ระบบ Credit Bank สอบวัดผลออนไลน์ และรับประกาศนียบัตรดิจิทัลพร้อม QR Code ตรวจสอบได้ทันที
          </p>

          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-800/80">
            <div>
              <div className="text-xl sm:text-2xl font-heading font-bold text-amber-400">
                {courses.length}
              </div>
              <div className="text-xs text-slate-400">หลักสูตรคุณภาพ</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-heading font-bold text-white">
                30 น.ก.
              </div>
              <div className="text-xs text-slate-400">เกณฑ์ต่ออายุ 3 ปี</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-heading font-bold text-emerald-400">
                100%
              </div>
              <div className="text-xs text-slate-400">เรียนออนไลน์ทุกที่</div>
            </div>
            <div>
              <div className="text-xl sm:text-2xl font-heading font-bold text-cyan-400">
                สภาทนายฯ
              </div>
              <div className="text-xs text-slate-400">รับรองคุณวุฒิ</div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-4">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="ค้นหาชื่อหลักสูตร, รหัสวิชา, หรือชื่อวิทยากร..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all text-slate-900 placeholder-slate-400"
            />
          </div>

          {/* Audience Tabs */}
          <div className="flex items-center bg-slate-100 p-1 rounded-lg text-xs font-medium self-start md:self-auto">
            <button
              onClick={() => setSelectedAudience('all')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                selectedAudience === 'all'
                  ? 'bg-white text-slate-900 shadow-sm font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ทั้งหมด ({courses.length})
            </button>
            <button
              onClick={() => setSelectedAudience('lawyer')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                selectedAudience === 'lawyer'
                  ? 'bg-white text-amber-700 shadow-sm font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ⚖️ ทนายความ (CLE)
            </button>
            <button
              onClick={() => setSelectedAudience('citizen')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                selectedAudience === 'citizen'
                  ? 'bg-white text-blue-700 shadow-sm font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              🎓 ประชาชนทั่วไป
            </button>
          </div>
        </div>

        {/* Category Filter Chips & Sort Select */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none flex-1">
            {categories.map(cat => (
              <button
                key={cat.key}
                onClick={() => setSelectedCategory(cat.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
                  selectedCategory === cat.key
                    ? 'bg-slate-900 border-slate-900 text-white'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs shrink-0 self-end sm:self-auto">
            <span className="text-slate-400">เรียงตาม:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'popular' | 'credits' | 'rating')}
              className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              <option value="popular">ผู้เรียนมากที่สุด</option>
              <option value="credits">หน่วยกิต CLE สูงสุด</option>
              <option value="rating">คะแนนรีวิวสูงสุด</option>
            </select>
          </div>
        </div>
      </div>

      {/* Courses Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredCourses.map(course => {
          const enrollment = getEnrollmentForCourse(course.id);
          const isCompleted = enrollment?.status === 'completed';
          const isInProgress = enrollment?.status === 'in_progress';

          return (
            <div
              key={course.id}
              className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-all flex flex-col group"
            >
              {/* Course Thumbnail */}
              <div className="relative h-44 overflow-hidden bg-slate-900">
                <img
                  src={course.coverImage}
                  alt={course.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-90"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-black/20" />
                
                {/* Badges on image */}
                <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
                  <span className="bg-slate-900/90 backdrop-blur-sm text-slate-200 text-[11px] font-semibold px-2 py-0.5 rounded border border-white/10">
                    {course.code}
                  </span>
                  {course.isMandatoryForRenewal && (
                    <span className="bg-rose-600 text-white text-[11px] font-bold px-2 py-0.5 rounded shadow">
                      ★ วิชาบังคับต่ออายุ
                    </span>
                  )}
                </div>

                <div className="absolute bottom-3 right-3">
                  <span className="bg-amber-500 text-slate-950 text-xs font-bold px-2.5 py-1 rounded-md shadow-md flex items-center gap-1">
                    <Award className="w-3.5 h-3.5" />
                    <span>+{course.credits} CLE หน่วยกิต</span>
                  </span>
                </div>
              </div>

              {/* Course Content */}
              <div className="p-5 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {course.durationHours} ชั่วโมง
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      {course.enrolledStudentsCount.toLocaleString()} คน
                    </span>
                    <span>•</span>
                    <span className="text-amber-600 font-semibold">
                      ★ {course.rating}
                    </span>
                  </div>

                  <h3 
                    onClick={() => onSelectCourse(course)}
                    className="font-heading font-bold text-base text-slate-900 group-hover:text-amber-600 transition-colors line-clamp-2 cursor-pointer"
                  >
                    {course.title}
                  </h3>

                  <p className="text-xs text-slate-600 mt-2 line-clamp-2 leading-relaxed">
                    {course.subtitle}
                  </p>
                </div>

                {/* Instructor & CTA Footer */}
                <div className="mt-5 pt-4 border-t border-slate-100">
                  <div className="flex items-center gap-2.5 mb-3.5">
                    <img
                      src={course.instructorAvatar}
                      alt={course.instructorName}
                      className="w-7 h-7 rounded-full object-cover border border-slate-200"
                    />
                    <div className="text-xs">
                      <div className="font-medium text-slate-800 line-clamp-1">{course.instructorName}</div>
                      <div className="text-[10px] text-slate-400 line-clamp-1">{course.instructorTitle}</div>
                    </div>
                  </div>

                  {/* Actions */}
                  {isCompleted ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => onEnterClassroom(course.id)}
                        className="flex-1 py-2 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>เรียนจบแล้ว (ทบทวน)</span>
                      </button>
                      <button
                        onClick={() => setActiveTab('certificates')}
                        className="py-2 px-3 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-lg text-xs font-bold transition-colors shadow-sm"
                        title="ดูวุฒิบัตร"
                      >
                        <Award className="w-4 h-4" />
                      </button>
                    </div>
                  ) : isInProgress ? (
                    <button
                      onClick={() => onEnterClassroom(course.id)}
                      className="w-full py-2 px-4 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center justify-center gap-2 shadow-sm transition-colors"
                    >
                      <span>เข้าห้องเรียนต่อ</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => onSelectCourse(course)}
                        className="flex-1 py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition-colors"
                      >
                        ดูรายละเอียด
                      </button>
                      <button
                        onClick={() => enrollCourse(course.id)}
                        className="flex-1 py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm"
                      >
                        <GraduationCap className="w-3.5 h-3.5" />
                        <span>ลงทะเบียนเรียน</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filteredCourses.length === 0 && (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
          <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-700">ไม่พบหลักสูตรที่ตรงกับเงื่อนไข</h3>
          <p className="text-xs text-slate-500 mt-1">ลองเปลี่ยนคำค้นหา หรือเลือกหมวดหมู่อื่น</p>
        </div>
      )}
    </div>
  );
};
