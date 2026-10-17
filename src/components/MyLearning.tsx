import React from 'react';
import { useApp } from '../context/AppContext';
import { Course } from '../types';
import { 
  BookOpen, 
  Clock, 
  Award, 
  CheckCircle, 
  ArrowRight, 
  Play, 
  GraduationCap 
} from 'lucide-react';

export const MyLearning: React.FC<{
  onEnterClassroom: (courseId: string) => void;
  onStartExam: (courseId: string) => void;
  onExploreCourses: () => void;
}> = ({
  onEnterClassroom,
  onStartExam,
  onExploreCourses,
}) => {
  const { enrollments, courses, currentUser, setActiveTab } = useApp();

  const userEnrollments = enrollments.filter(e => e.userId === currentUser.id);

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full mb-1">
          <GraduationCap className="w-3.5 h-3.5" />
          <span>แดชบอร์ดการเรียนรู้</span>
        </div>
        <h1 className="text-xl sm:text-2xl font-heading font-bold text-slate-900">
          ห้องเรียนของฉัน ({userEnrollments.length} หลักสูตรที่ลงทะเบียน)
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          ติดตามความคืบหน้าการเรียน เข้าชมบทเรียนย้อนหลัง และทำแบบทดสอบวัดผลเพื่อรับหน่วยกิต
        </p>
      </div>

      {userEnrollments.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {userEnrollments.map(enr => {
            const course = courses.find(c => c.id === enr.courseId);
            if (!course) return null;

            const totalLessons = course.modules.reduce((acc, m) => acc + m.lessons.length, 0);
            const completedCount = enr.completedLessons.length;
            const progressPercent = Math.round((completedCount / (totalLessons || 1)) * 100);
            const isCompleted = enr.status === 'completed';

            return (
              <div
                key={enr.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col justify-between hover:shadow-md transition-all"
              >
                {/* Thumbnail banner */}
                <div className="relative h-36 bg-slate-900">
                  <img
                    src={course.coverImage}
                    alt={course.title}
                    className="w-full h-full object-cover opacity-80"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent" />
                  
                  <div className="absolute top-3 left-3">
                    <span className="bg-slate-900/90 text-amber-300 text-[10px] font-bold px-2 py-0.5 rounded border border-amber-500/30">
                      {course.code}
                    </span>
                  </div>

                  <div className="absolute bottom-3 left-4 right-4 text-white">
                    <h3 className="font-heading font-bold text-sm sm:text-base line-clamp-1">
                      {course.title}
                    </h3>
                    <div className="flex items-center gap-3 text-[11px] text-slate-300 mt-1">
                      <span>+{course.credits} CLE หน่วยกิต</span>
                      <span>•</span>
                      <span>{course.durationHours} ชั่วโมง</span>
                    </div>
                  </div>
                </div>

                {/* Body Progress */}
                <div className="p-5 space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5 font-medium">
                      <span className="text-slate-600">
                        เรียนจบแล้ว {completedCount} จาก {totalLessons} บทเรียน
                      </span>
                      <span className="font-bold text-amber-600">{progressPercent}%</span>
                    </div>

                    <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          isCompleted ? 'bg-emerald-500' : 'bg-amber-500'
                        }`}
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>

                  {enr.examPassed && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 flex items-center justify-between text-xs text-emerald-800">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <CheckCircle className="w-4 h-4 text-emerald-600" />
                        <span>สอบผ่านแล้ว ({enr.examScore}%)</span>
                      </div>
                      <button
                        onClick={() => setActiveTab('certificates')}
                        className="text-amber-800 font-bold hover:underline"
                      >
                        ดูวุฒิบัตร →
                      </button>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => onEnterClassroom(course.id)}
                      className="flex-1 py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm"
                    >
                      <Play className="w-3.5 h-3.5 fill-white" />
                      <span>{isCompleted ? 'เข้าทบทวนเนื้อหา' : 'เข้าห้องเรียนต่อ'}</span>
                    </button>

                    {course.hasExam && (
                      <button
                        onClick={() => onStartExam(course.id)}
                        className={`py-2 px-4 rounded-lg text-xs font-bold transition-colors ${
                          enr.examPassed
                            ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                            : 'bg-amber-500 hover:bg-amber-600 text-slate-950 shadow-sm'
                        }`}
                      >
                        {enr.examPassed ? 'สอบใหม่' : 'ทำข้อสอบ'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <h3 className="font-heading font-semibold text-base text-slate-700">
            ท่านยังไม่ได้ลงทะเบียนเรียนในหลักสูตรใด
          </h3>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            เลือกดูหลักสูตรพัฒนาวิชาชีพที่เปิดสอนเพื่อเริ่มเรียนและสะสมหน่วยกิต
          </p>
          <button
            onClick={onExploreCourses}
            className="mt-4 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold shadow-sm"
          >
            เลือกดูหลักสูตรทั้งหมด
          </button>
        </div>
      )}
    </div>
  );
};
