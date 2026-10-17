import React from 'react';
import { Course } from '../types';
import { useApp } from '../context/AppContext';
import { 
  X, 
  Clock, 
  Award, 
  BookOpen, 
  CheckCircle, 
  Users, 
  ShieldAlert, 
  FileText, 
  CheckCircle2,
  GraduationCap
} from 'lucide-react';

interface CourseDetailModalProps {
  course: Course | null;
  onClose: () => void;
  onEnroll: (courseId: string) => void;
  onEnterClassroom: (courseId: string) => void;
}

export const CourseDetailModal: React.FC<CourseDetailModalProps> = ({
  course,
  onClose,
  onEnroll,
  onEnterClassroom,
}) => {
  const { enrollments, currentUser } = useApp();

  if (!course) return null;

  const enrollment = enrollments.find(e => e.userId === currentUser.id && e.courseId === course.id);
  const isEnrolled = !!enrollment;

  const totalLessons = course.modules.reduce((acc, m) => acc + m.lessons.length, 0);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative bg-white rounded-2xl max-w-3xl w-full overflow-hidden shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-200">
        {/* Header Bar */}
        <div className="relative h-48 bg-slate-900">
          <img
            src={course.coverImage}
            alt={course.title}
            className="w-full h-full object-cover opacity-60"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent" />
          
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-slate-900/80 hover:bg-slate-900 text-white flex items-center justify-center transition-colors shadow-md"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="absolute bottom-4 left-6 right-6 text-white">
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-amber-500 text-slate-950 text-xs font-bold px-2 py-0.5 rounded">
                {course.code}
              </span>
              <span className="bg-slate-800/80 text-amber-300 text-xs font-semibold px-2 py-0.5 rounded border border-amber-500/30">
                +{course.credits} CLE หน่วยกิต
              </span>
              {course.isMandatoryForRenewal && (
                <span className="bg-rose-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                  ★ บังคับต่ออายุใบอนุญาต
                </span>
              )}
            </div>
            <h2 className="text-xl sm:text-2xl font-heading font-bold leading-snug">
              {course.title}
            </h2>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6 max-h-[65vh] overflow-y-auto">
          {/* Subtitle & Key Stats */}
          <div>
            <p className="text-sm text-slate-600 leading-relaxed">
              {course.subtitle}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-600" />
                <div>
                  <div className="text-slate-400">ระยะเวลา</div>
                  <div className="font-semibold text-slate-800">{course.durationHours} ชั่วโมง</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-amber-600" />
                <div>
                  <div className="text-slate-400">หน่วยกิต CLE</div>
                  <div className="font-semibold text-slate-800">{course.credits} หน่วยกิต</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <div>
                  <div className="text-slate-400">เกณฑ์สอบผ่าน</div>
                  <div className="font-semibold text-slate-800">≥ {course.passingScorePercent}%</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-blue-600" />
                <div>
                  <div className="text-slate-400">บทเรียน</div>
                  <div className="font-semibold text-slate-800">{totalLessons} บทเรียน</div>
                </div>
              </div>
            </div>
          </div>

          {/* Description */}
          <div>
            <h3 className="text-sm font-heading font-bold text-slate-900 mb-2">
              วัตถุประสงค์และคำอธิบายหลักสูตร
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
              {course.description}
            </p>
          </div>

          {/* Course Syllabus */}
          <div>
            <h3 className="text-sm font-heading font-bold text-slate-900 mb-3">
              โครงสร้างเนื้อหาหลักสูตร (Syllabus)
            </h3>
            <div className="space-y-3">
              {course.modules.map((module, idx) => (
                <div key={module.id} className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-slate-100/80 px-4 py-2.5 text-xs font-semibold text-slate-800 flex items-center justify-between">
                    <span>{module.title}</span>
                    <span className="text-slate-500 font-normal">{module.lessons.length} บทเรียน</span>
                  </div>
                  <div className="divide-y divide-slate-100 bg-white">
                    {module.lessons.map(lesson => (
                      <div key={lesson.id} className="p-3.5 flex items-start gap-3 hover:bg-slate-50 transition-colors">
                        <FileText className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                        <div className="flex-1 text-xs">
                          <div className="font-medium text-slate-800">{lesson.title}</div>
                          <div className="text-slate-500 mt-0.5">{lesson.summary}</div>
                        </div>
                        <span className="text-[11px] text-slate-400 whitespace-nowrap">
                          {lesson.durationMinutes} นาที
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Instructor Bio */}
          <div className="bg-amber-50/60 border border-amber-200/60 rounded-xl p-4 flex items-center gap-4">
            <img
              src={course.instructorAvatar}
              alt={course.instructorName}
              className="w-12 h-12 rounded-full object-cover border-2 border-amber-400"
            />
            <div>
              <div className="text-xs font-semibold text-slate-900">{course.instructorName}</div>
              <div className="text-xs text-amber-900/80">{course.instructorTitle}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">ผู้ทรงคุณวุฒิที่ได้รับแต่งตั้งจากสภาทนายความแห่งประเทศไทย</div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-200 transition-colors"
          >
            ปิด
          </button>

          {isEnrolled ? (
            <button
              onClick={() => {
                onClose();
                onEnterClassroom(course.id);
              }}
              className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-2 shadow-sm transition-colors"
            >
              <span>เข้าห้องเรียนทันที</span>
              <CheckCircle className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => {
                onEnroll(course.id);
                onClose();
              }}
              className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs flex items-center gap-2 shadow-md transition-colors"
            >
              <GraduationCap className="w-4 h-4" />
              <span>ลงทะเบียนเรียนฟรี (สะสม +{course.credits} CLE)</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
