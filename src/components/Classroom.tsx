import React, { useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { 
  Play, 
  Pause, 
  CheckCircle, 
  CheckCircle2, 
  ArrowLeft, 
  BookOpen, 
  Download, 
  Award, 
  FileText, 
  HelpCircle,
  Volume2,
  Maximize2,
  RotateCcw,
  Sparkles
} from 'lucide-react';

interface ClassroomProps {
  courseId: string;
  onBack: () => void;
  onStartExam: (courseId: string) => void;
}

export const Classroom: React.FC<ClassroomProps> = ({
  courseId,
  onBack,
  onStartExam,
}) => {
  const { courses, enrollments, completeLesson, currentUser, setActiveTab } = useApp();
  const course = courses.find(c => c.id === courseId);
  const enrollment = enrollments.find(e => e.userId === currentUser.id && e.courseId === courseId);

  // Flatten lessons to pick current
  const allLessons = course?.modules.flatMap(m => m.lessons) || [];
  const [currentLessonIndex, setCurrentLessonIndex] = useState(0);
  const currentLesson = allLessons[currentLessonIndex] || allLessons[0];

  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [activeTab, setActiveTabLocal] = useState<'notes' | 'statute' | 'docs' | 'personal'>('notes');
  const [personalNotes, setPersonalNotes] = useState<string>(() => {
    return localStorage.getItem(`notes_${courseId}`) || '';
  });
  const [noteSaved, setNoteSaved] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  const handleSaveNotes = (text: string) => {
    setPersonalNotes(text);
    localStorage.setItem(`notes_${courseId}`, text);
    setNoteSaved(true);
    setTimeout(() => setNoteSaved(false), 2000);
  };

  if (!course || !currentLesson) {
    return (
      <div className="p-8 text-center">
        <p>ไม่พบข้อมูลหลักสูตร</p>
        <button onClick={onBack} className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-lg text-xs">
          กลับสู่หน้ารายการหลักสูตร
        </button>
      </div>
    );
  }

  const completedLessons = enrollment?.completedLessons || [];
  const isCurrentCompleted = completedLessons.includes(currentLesson.id);
  const progressPercent = Math.round((completedLessons.length / (allLessons.length || 1)) * 100);
  const canTakeExam = completedLessons.length > 0; // flexible test taking

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleLessonChange = (index: number) => {
    setCurrentLessonIndex(index);
    setIsPlaying(false);
  };

  const handleMarkComplete = () => {
    completeLesson(course.id, currentLesson.id);
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Top Bar Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>กลับสู่รายการหลักสูตร</span>
        </button>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-xs font-bold text-slate-900">{course.code}: {course.title}</div>
            <div className="text-[11px] text-slate-500">
              ความคืบหน้าการเรียน: {completedLessons.length}/{allLessons.length} บทเรียน ({progressPercent}%)
            </div>
          </div>

          {/* Exam Trigger Button */}
          {course.hasExam && (
            <button
              onClick={() => onStartExam(course.id)}
              className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow-sm ${
                enrollment?.examPassed
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  : 'bg-amber-500 hover:bg-amber-600 text-slate-950 ring-2 ring-amber-400/40'
              }`}
            >
              <Award className="w-4 h-4" />
              <span>{enrollment?.examPassed ? 'สอบผ่านแล้ว (ดูผล/สอบใหม่)' : 'ทำข้อสอบวัดผล (Final Exam)'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Classroom Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Video & Lesson Content */}
        <div className="lg:col-span-2 space-y-4">
          {/* Video Player */}
          <div className="relative rounded-2xl overflow-hidden bg-slate-950 aspect-video shadow-2xl border border-slate-800 flex items-center justify-center group">
            <video
              ref={videoRef}
              src={currentLesson.videoUrl}
              className="w-full h-full object-cover"
              controls
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          </div>

          {/* Quick Player Bar: Speed, Chapter navigation */}
          <div className="flex items-center justify-between bg-slate-900 text-white px-4 py-2.5 rounded-xl text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-[11px]">ความเร็ววิดีโอ:</span>
              {[0.75, 1, 1.25, 1.5, 2].map(speed => (
                <button
                  key={speed}
                  onClick={() => handleSpeedChange(speed)}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                    playbackSpeed === speed
                      ? 'bg-amber-500 text-slate-950 font-bold'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>

            <div className="text-[11px] text-amber-300 flex items-center gap-1 font-mono">
              <span>{currentLesson.durationMinutes} นาที</span>
            </div>
          </div>

          {/* Lesson Title & Completion Action */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <div className="text-xs font-bold text-amber-700 mb-1">
                บทเรียนปัจจุบัน (ความยาว {currentLesson.durationMinutes} นาที)
              </div>
              <h2 className="text-base sm:text-lg font-heading font-bold text-slate-900">
                {currentLesson.title}
              </h2>
            </div>

            <button
              onClick={handleMarkComplete}
              disabled={isCurrentCompleted}
              className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap shadow-sm ${
                isCurrentCompleted
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-300'
                  : 'bg-slate-900 hover:bg-slate-800 text-white'
              }`}
            >
              <CheckCircle2 className={`w-4 h-4 ${isCurrentCompleted ? 'text-emerald-600' : 'text-slate-400'}`} />
              <span>{isCurrentCompleted ? 'เรียนจบแล้ว ✓' : 'ทำเครื่องหมายว่าเรียนจบแล้ว'}</span>
            </button>
          </div>

          {/* Lesson Details Tabs */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex flex-wrap border-b border-slate-200 bg-slate-50 text-xs font-semibold">
              <button
                onClick={() => setActiveTabLocal('notes')}
                className={`flex-1 py-3 px-3 text-center border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === 'notes'
                    ? 'border-amber-500 text-amber-700 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                สาระสำคัญบทเรียน
              </button>
              <button
                onClick={() => setActiveTabLocal('statute')}
                className={`flex-1 py-3 px-3 text-center border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === 'statute'
                    ? 'border-amber-500 text-amber-700 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                ตัวบทและฎีกาสำคัญ
              </button>
              <button
                onClick={() => setActiveTabLocal('docs')}
                className={`flex-1 py-3 px-3 text-center border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === 'docs'
                    ? 'border-amber-500 text-amber-700 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                เอกสารประกอบ
              </button>
              <button
                onClick={() => setActiveTabLocal('personal')}
                className={`flex-1 py-3 px-3 text-center border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === 'personal'
                    ? 'border-amber-500 text-amber-700 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                สมุดโน้ตส่วนตัว ✍️
              </button>
            </div>

            <div className="p-5 text-xs text-slate-700 leading-relaxed">
              {activeTab === 'notes' && (
                <div className="space-y-3">
                  <h4 className="font-heading font-bold text-slate-900 text-sm">
                    สรุปเนื้อหาบทเรียน: {currentLesson.title}
                  </h4>
                  <p>{currentLesson.summary}</p>
                  <div className="bg-amber-50 border-l-4 border-amber-500 p-3 rounded text-amber-900">
                    <span className="font-bold">ข้อควรระวังในการปฏิบัติหน้าที่:</span> ทนายความต้องตระหนักถึงความรับผิดชอบต่อกระบวนการยุติธรรมเป็นลำดับแรก การไม่รักษาความลับหรือการละเลยหน้าที่อาจถูกดำเนินคดีทางมรรยาททนายความและสั่งเพิกถอนใบอนุญาตได้
                  </div>
                </div>
              )}

              {activeTab === 'statute' && (
                <div className="space-y-3 font-mono text-[11px]">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="font-bold text-slate-900 mb-1">
                      ข้อบังคับสภาทนายความ ว่าด้วยมรรยาททนายความ พ.ศ. 2529 หมวด 3
                    </div>
                    <p className="text-slate-600">
                      "ข้อ 15 ทนายความได้รับเงินหรือทรัพย์สินอันเป็นของลูกความไว้ ต้องทำบัญชีและเก็บรักษาไว้ต่างหากจากทรัพย์สินของตน..."
                    </p>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="font-bold text-slate-900 mb-1">
                      คำวินิจฉัยคณะกรรมการมรรยาททนายความ ที่ 142/2565
                    </div>
                    <p className="text-slate-600">
                      "การรับว่าความให้คู่ความฝ่ายตรงข้ามในมูลคดีเดียวกัน แม้จะเป็นการว่าต่างในชั้นบังคับคดี ย่อมถือเป็นปฏิปักษ์และขัดต่อมรรยาททนายความ..."
                    </p>
                  </div>
                </div>
              )}

              {activeTab === 'docs' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-amber-600" />
                      <div>
                        <div className="font-semibold text-slate-800">สไลด์ประกอบการบรรยาย {course.code} (PDF)</div>
                        <div className="text-[10px] text-slate-400">ขนาด 4.8 MB · อัปเดตล่าสุด ตุลาคม 2569</div>
                      </div>
                    </div>
                    <a
                      href="#download"
                      onClick={(e) => { e.preventDefault(); alert('ดาวน์โหลดไฟล์เอกสารประกอบคำบรรยายสำเร็จ'); }}
                      className="px-3 py-1.5 bg-white border border-slate-300 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-1"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>ดาวน์โหลด</span>
                    </a>
                  </div>
                </div>
              )}

              {activeTab === 'personal' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-heading font-bold text-slate-900 text-sm">
                      สมุดบันทึกการเรียนรู้ส่วนตัว (บันทึกอัตโนมัติ)
                    </h4>
                    {noteSaved && (
                      <span className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>บันทึกแล้ว</span>
                      </span>
                    )}
                  </div>
                  <textarea
                    rows={6}
                    value={personalNotes}
                    onChange={(e) => handleSaveNotes(e.target.value)}
                    placeholder="พิมพ์จดบันทึกประเด็นสำคัญ ข้อต่อสู้ หรือข้อสังเกตจากคำบรรยายของอาจารย์ได้ที่นี่ ข้อมูลจะถูกเก็บไว้ในเบราว์เซอร์ของท่าน..."
                    className="w-full p-3 text-xs border border-slate-300 rounded-xl focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 leading-relaxed font-sans"
                  />
                  <div className="text-[11px] text-slate-400">
                    * โน้ตส่วนตัวจะถูกผูกกับหลักสูตรนี้และสามารถกลับมาอ่านทบทวนได้ตลอดเวลา
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Modules Checklist */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <h3 className="font-heading font-bold text-sm text-slate-900 mb-3 flex items-center justify-between">
              <span>สารบัญหลักสูตร</span>
              <span className="text-xs text-amber-600 font-semibold">{progressPercent}% สำเร็จ</span>
            </h3>

            {/* Progress Bar */}
            <div className="w-full bg-slate-100 rounded-full h-2 mb-4 overflow-hidden">
              <div 
                className="bg-amber-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1">
              {course.modules.map(module => (
                <div key={module.id} className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 border-b border-slate-200">
                    {module.title}
                  </div>
                  <div className="divide-y divide-slate-100 bg-white">
                    {module.lessons.map(lesson => {
                      const lessonGlobalIndex = allLessons.findIndex(l => l.id === lesson.id);
                      const isCompleted = completedLessons.includes(lesson.id);
                      const isSelected = lesson.id === currentLesson.id;

                      return (
                        <div
                          key={lesson.id}
                          onClick={() => handleLessonChange(lessonGlobalIndex)}
                          className={`p-3 text-xs flex items-center justify-between cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-amber-50/80 border-l-4 border-amber-500 text-amber-950 font-semibold'
                              : 'hover:bg-slate-50 text-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 flex-1 pr-2">
                            {isCompleted ? (
                              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                            ) : (
                              <div className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                            )}
                            <span className="line-clamp-2 leading-tight">{lesson.title}</span>
                          </div>
                          <span className="text-[10px] text-slate-400 whitespace-nowrap">
                            {lesson.durationMinutes} น.
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Final Exam Box */}
            <div className="mt-4 p-4 rounded-xl bg-gradient-to-br from-amber-50 to-amber-100/60 border border-amber-300">
              <div className="flex items-start gap-3">
                <Award className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <div className="font-heading font-bold text-xs text-amber-950">
                    แบบทดสอบวัดผลปลายหลักสูตร (Final Exam)
                  </div>
                  <p className="text-[11px] text-amber-900/80 mt-1">
                    เกณฑ์สอบผ่าน ≥ {course.passingScorePercent}% เพื่อรับ {course.credits} CLE หน่วยกิตและใบประกาศนียบัตร
                  </p>
                  <button
                    onClick={() => onStartExam(course.id)}
                    className="mt-3 w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors shadow flex items-center justify-center gap-1.5"
                  >
                    <span>เริ่มทำข้อสอบ</span>
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
