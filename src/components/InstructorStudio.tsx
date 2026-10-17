import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { CourseCategory, TargetAudience, Question } from '../types';
import { 
  FileText, 
  Plus, 
  HelpCircle, 
  BookOpen, 
  CheckCircle2, 
  Layers, 
  Award,
  Sparkles,
  Trash2
} from 'lucide-react';

export const InstructorStudio: React.FC = () => {
  const { courses, questions, addCourse, addQuestion, deleteQuestion, currentUser } = useApp();
  const [activeTab, setActiveTab] = useState<'create-course' | 'question-bank'>('create-course');

  // New Course Form State
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('CLE-NEW-101');
  const [subtitle, setSubtitle] = useState('');
  const [category, setCategory] = useState<CourseCategory>('ethics');
  const [targetAudience, setTargetAudience] = useState<TargetAudience>('lawyer');
  const [credits, setCredits] = useState(6);
  const [durationHours, setDurationHours] = useState(6);
  const [description, setDescription] = useState('');
  const [mandatoryRenewal, setMandatoryRenewal] = useState(false);
  const [lessonTitle, setLessonTitle] = useState('');
  const [courseCreatedMsg, setCourseCreatedMsg] = useState(false);

  // New Question Form State
  const [selectedCourseId, setSelectedCourseId] = useState(courses[0]?.id || '');
  const [prompt, setPrompt] = useState('');
  const [optA, setOptA] = useState('');
  const [optB, setOptB] = useState('');
  const [optC, setOptC] = useState('');
  const [optD, setOptD] = useState('');
  const [correctOpt, setCorrectOpt] = useState('opt-a');
  const [explanation, setExplanation] = useState('');
  const [legalReference, setLegalReference] = useState('');
  const [questionCreatedMsg, setQuestionCreatedMsg] = useState(false);

  const handleCreateCourse = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    addCourse({
      code,
      title,
      subtitle,
      category,
      targetAudience,
      credits: Number(credits),
      durationHours: Number(durationHours),
      description,
      isMandatoryForRenewal: mandatoryRenewal,
      modules: [
        {
          id: `mod-${Date.now()}`,
          title: 'หมวดที่ 1: บรรยายสรุปและหลักการพื้นฐาน',
          lessons: [
            {
              id: `les-${Date.now()}`,
              title: lessonTitle.trim() || 'บทนำและภาพรวมของกฎหมาย',
              durationMinutes: 45,
              videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
              summary: 'ศึกษาหลักการสำคัญ ตัวบท และแนวทางการปฏิบัติงานในวิชาชีพ',
            },
          ],
        },
      ],
    });

    setCourseCreatedMsg(true);
    setTimeout(() => setCourseCreatedMsg(false), 4000);
    setTitle('');
    setSubtitle('');
    setDescription('');
    setLessonTitle('');
  };

  const handleCreateQuestion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !optA.trim() || !optB.trim()) return;

    addQuestion({
      courseId: selectedCourseId,
      prompt,
      options: [
        { id: 'opt-a', text: optA },
        { id: 'opt-b', text: optB },
        { id: 'opt-c', text: optC || 'ไม่มีข้อใดถูก' },
        { id: 'opt-d', text: optD || 'ถูกทุกข้อที่กล่าวมา' },
      ],
      correctOptionId: correctOpt,
      explanation,
      legalReference,
    });

    setQuestionCreatedMsg(true);
    setTimeout(() => setQuestionCreatedMsg(false), 4000);
    setPrompt('');
    setOptA('');
    setOptB('');
    setOptC('');
    setOptD('');
    setExplanation('');
    setLegalReference('');
  };

  return (
    <div className="space-y-6 pb-16">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-purple-700 bg-purple-50 px-2.5 py-0.5 rounded-full mb-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span>ระบบวิทยากรและผู้จัดทำหลักสูตร (Instructor Studio)</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-heading font-bold text-slate-900">
            สร้างหลักสูตรและจัดการธนาคารข้อสอบ (Question Bank)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            วิทยากร: <strong>{currentUser.name}</strong> · กำหนดเกณฑ์วัดผลและออกข้อสอบตามมาตรฐานสภาทนายความ
          </p>
        </div>

        <div className="flex bg-slate-100 p-1 rounded-lg text-xs font-medium">
          <button
            onClick={() => setActiveTab('create-course')}
            className={`px-3.5 py-1.5 rounded-md transition-all ${
              activeTab === 'create-course'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            สร้างหลักสูตรใหม่
          </button>
          <button
            onClick={() => setActiveTab('question-bank')}
            className={`px-3.5 py-1.5 rounded-md transition-all ${
              activeTab === 'question-bank'
                ? 'bg-white text-purple-700 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            เพิ่มข้อสอบในธนาคาร ({questions.length})
          </button>
        </div>
      </div>

      {activeTab === 'create-course' ? (
        /* Create Course Form */
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm">
          {courseCreatedMsg && (
            <div className="mb-6 p-4 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>สร้างหลักสูตรและเผยแพร่เข้าสู่แค็ตตาล็อกเรียบร้อยแล้ว</span>
            </div>
          )}

          <form onSubmit={handleCreateCourse} className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  รหัสวิชา (Course Code)
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  required
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ชื่อหลักสูตร (ภาษาไทย)
                </label>
                <input
                  type="text"
                  placeholder="เช่น กลยุทธ์การว่าความในคดีทรัพย์สินทางปัญญา"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                คำอธิบายย่อ (Subtitle)
              </label>
              <input
                type="text"
                placeholder="สรุปจุดเด่นของหลักสูตรใน 1 ประโยค"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  หมวดหมู่วิชา
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as CourseCategory)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="ethics">จริยธรรมและมรรยาท (บังคับ)</option>
                  <option value="substantive">กฎหมายสารบัญญัติ</option>
                  <option value="procedural">การว่าความและวิธีสบัญญัติ</option>
                  <option value="emerging_tech">เทคโนโลยีกฎหมาย & PDPA</option>
                  <option value="public_law">กฎหมายสำหรับประชาชน</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  กลุ่มเป้าหมาย
                </label>
                <select
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value as TargetAudience)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="lawyer">ทนายความ (CLE)</option>
                  <option value="citizen">ประชาชนทั่วไป</option>
                  <option value="all">ทุกคน</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  หน่วยกิต CLE ที่ได้รับ
                </label>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={credits}
                  onChange={(e) => setCredits(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ระยะเวลา (ชั่วโมง)
                </label>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={durationHours}
                  onChange={(e) => setDurationHours(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                รายละเอียดและวัตถุประสงค์หลักสูตร
              </label>
              <textarea
                rows={3}
                placeholder="ระบุวัตถุประสงค์ ผลลัพธ์การเรียนรู้ และกลุ่มเป้าหมายโดยละเอียด..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                ชื่อบทเรียนแรก (Lesson 1.1)
              </label>
              <input
                type="text"
                placeholder="เช่น 1.1 บทนำและหลักการทั่วไป"
                value={lessonTitle}
                onChange={(e) => setLessonTitle(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="chk-mandatory"
                checked={mandatoryRenewal}
                onChange={(e) => setMandatoryRenewal(e.target.checked)}
                className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
              />
              <label htmlFor="chk-mandatory" className="text-xs text-slate-700 font-medium">
                กำหนดเป็นวิชาบังคับสำหรับการต่อใบอนุญาตว่าความ (Mandatory Course)
              </label>
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                type="submit"
                className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors shadow flex items-center gap-2"
              >
                <Plus className="w-4 h-4 text-amber-400" />
                <span>บันทึกและเผยแพร่หลักสูตร</span>
              </button>
            </div>
          </form>
        </div>
      ) : (
        /* Question Bank Form */
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm">
          {questionCreatedMsg && (
            <div className="mb-6 p-4 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>บันทึกข้อสอบเข้าสู่ Question Bank สำเร็จเรียบร้อย</span>
            </div>
          )}

          <form onSubmit={handleCreateQuestion} className="space-y-6">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เลือกหลักสูตรที่ต้องการเพิ่มข้อสอบ
              </label>
              <select
                value={selectedCourseId}
                onChange={(e) => setSelectedCourseId(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {courses.map(c => (
                  <option key={c.id} value={c.id}>
                    [{c.code}] {c.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                โจทย์คำถาม / สถานการณ์จำลองทางกฎหมาย (Prompt)
              </label>
              <textarea
                rows={3}
                placeholder="ระบุข้อเท็จจริงในคดีหรือประเด็นทางกฎหมายที่ต้องการทดสอบ..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div className="space-y-3">
              <label className="block text-xs font-semibold text-slate-700">
                ตัวเลือกคำตอบ 4 ตัวเลือก (ระบุตัวเลือกที่ถูกต้อง)
              </label>

              {[
                { id: 'opt-a', label: 'ก.', val: optA, setVal: setOptA },
                { id: 'opt-b', label: 'ข.', val: optB, setVal: setOptB },
                { id: 'opt-c', label: 'ค.', val: optC, setVal: setOptC },
                { id: 'opt-d', label: 'ง.', val: optD, setVal: setOptD },
              ].map(opt => (
                <div key={opt.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="correct-opt"
                    checked={correctOpt === opt.id}
                    onChange={() => setCorrectOpt(opt.id)}
                    className="text-amber-600 focus:ring-amber-500"
                  />
                  <span className="w-6 text-xs font-bold text-slate-600">{opt.label}</span>
                  <input
                    type="text"
                    placeholder={`ข้อความตัวเลือก ${opt.label}`}
                    value={opt.val}
                    onChange={(e) => opt.setVal(e.target.value)}
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    required={opt.id === 'opt-a' || opt.id === 'opt-b'}
                  />
                </div>
              ))}
              <p className="text-[11px] text-amber-700 font-medium">
                * เลือกปุ่มวงกลมหน้ารายการที่ต้องการให้เป็นคำตอบที่ถูกต้อง
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  คำอธิบายเฉลยและเหตุผลทางนิติศาสตร์
                </label>
                <textarea
                  rows={2}
                  placeholder="อธิบายว่าเหตุใดข้อนี้จึงถูกหรือผิด..."
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ฐานกฎหมายหรือฎีกาอ้างอิง
                </label>
                <textarea
                  rows={2}
                  placeholder="เช่น ข้อบังคับมรรยาททนายความ พ.ศ. 2529 ข้อ 15 หรือ ฎีกาที่ 1234/2560"
                  value={legalReference}
                  onChange={(e) => setLegalReference(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                type="submit"
                className="px-6 py-2.5 bg-purple-700 hover:bg-purple-800 text-white rounded-xl text-xs font-bold transition-colors shadow flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>บันทึกข้อสอบเข้าคลัง</span>
              </button>
            </div>
          </form>

          {/* Existing Questions Browser */}
          <div className="mt-8 pt-8 border-t border-slate-200 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-heading font-bold text-sm text-slate-900">
                รายการข้อสอบในคลังปัจจุบัน ({questions.length} ข้อ)
              </h4>
              <span className="text-[11px] text-slate-400">
                วิทยากรและฝ่ายวัดผลสามารถตรวจสอบและปรับปรุงได้
              </span>
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
              {questions.map((q, idx) => {
                const targetCourse = courses.find(c => c.id === q.courseId);
                return (
                  <div key={q.id} className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded text-[10px] font-bold mr-2">
                          {targetCourse?.code || q.courseId}
                        </span>
                        <span className="font-semibold text-slate-900">
                          {idx + 1}. {q.prompt}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          if (confirm('ยืนยันลบข้อสอบนี้ออกจากธนาคารข้อสอบ?')) {
                            deleteQuestion(q.id);
                          }
                        }}
                        className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                        title="ลบข้อสอบ"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="text-[11px] text-slate-600 bg-white p-2.5 rounded-lg border border-slate-100 space-y-1">
                      <div>
                        <strong className="text-emerald-700">เฉลยตัวเลือกที่ถูกต้อง:</strong>{' '}
                        {q.options.find(o => o.id === q.correctOptionId)?.text || q.correctOptionId}
                      </div>
                      {q.legalReference && (
                        <div className="text-slate-500 font-mono text-[10px]">
                          ฐานอ้างอิง: {q.legalReference}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
