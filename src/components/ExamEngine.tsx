import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { Question, Certificate } from '../types';
import { 
  Clock, 
  AlertCircle, 
  Flag, 
  CheckCircle, 
  XCircle, 
  ArrowLeft, 
  ArrowRight, 
  Award, 
  RotateCcw, 
  Check, 
  Sparkles,
  ShieldCheck,
  FileCheck
} from 'lucide-react';

interface ExamEngineProps {
  courseId: string;
  onExit: () => void;
  onViewCertificate: (cert: Certificate) => void;
}

export const ExamEngine: React.FC<ExamEngineProps> = ({
  courseId,
  onExit,
  onViewCertificate,
}) => {
  const { courses, questions, submitExam, currentUser, setActiveTab } = useApp();
  const course = courses.find(c => c.id === courseId);
  const courseQuestions = questions.filter(q => q.courseId === courseId);

  // If no questions in mock, provide fallback questions
  const examQuestions: Question[] = courseQuestions.length > 0 ? courseQuestions : [
    {
      id: 'q-gen-01',
      courseId,
      prompt: 'หลักการสำคัญที่สุดในการปฏิบัติหน้าที่ของทนายความในกระบวนการยุติธรรมคือข้อใด?',
      options: [
        { id: 'opt-a', text: 'ความซื่อสัตย์สุจริตต่อศาล ตัวความ และเพื่อนร่วมวิชาชีพ' },
        { id: 'opt-b', text: 'การทำทุกวิถีทางให้ลูกความชนะคดีโดยไม่ต้องคำนึงถึงวิธีการ' },
        { id: 'opt-c', text: 'การสร้างชื่อเสียงและผลประโยชน์ทางการเงินสูงสุด' },
        { id: 'opt-d', text: 'การยอมรับข้อเรียกร้องของคู่ความฝ่ายตรงข้ามเสมอ' },
      ],
      correctOptionId: 'opt-a',
      explanation: 'ทนายความมีสถานะเป็นเจ้าหน้าที่ของศาล (Officer of the court) หน้าที่หลักคือการอำนวยความยุติธรรมด้วยความซื่อสัตย์สุจริต',
      legalReference: 'พ.ร.บ. ทนายความ พ.ศ. 2528 มาตรา 35',
    },
    {
      id: 'q-gen-02',
      courseId,
      prompt: 'การสะสมหน่วยกิต CLE สำหรับการต่ออายุใบอนุญาตว่าความในแต่ละรอบ 3 ปี กำหนดเกณฑ์ขั้นต่ำไว้เท่าใด?',
      options: [
        { id: 'opt-a', text: '10 หน่วยกิต' },
        { id: 'opt-b', text: '20 หน่วยกิต' },
        { id: 'opt-c', text: '30 หน่วยกิต (รวมวิชาจริยธรรมบังคับ)' },
        { id: 'opt-d', text: '50 หน่วยกิต' },
      ],
      correctOptionId: 'opt-c',
      explanation: 'ตามระเบียบสภาทนายความว่าด้วยการพัฒนาวิชาชีพต่อเนื่อง กำหนดให้ทนายความสะสมไม่น้อยกว่า 30 หน่วยกิตในรอบ 3 ปี',
      legalReference: 'ระเบียบสภาทนายความว่าด้วย Credit Bank 2568 ข้อ 5',
    },
  ];

  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  const [timeLeftSeconds, setTimeLeftSeconds] = useState(15 * 60); // 15 mins
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [examResult, setExamResult] = useState<{
    passed: boolean;
    scorePercent: number;
    certificate?: Certificate;
  } | null>(null);

  // Timer countdown
  useEffect(() => {
    if (isSubmitted) return;

    const interval = setInterval(() => {
      setTimeLeftSeconds(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          handleSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isSubmitted]);

  const currentQ = examQuestions[currentIndex];

  const handleSelectOption = (optionId: string) => {
    if (isSubmitted) return;
    setAnswers(prev => ({ ...prev, [currentQ.id]: optionId }));
  };

  const toggleFlag = (qId: string) => {
    setFlagged(prev => ({ ...prev, [qId]: !prev[qId] }));
  };

  const handleSubmit = () => {
    setShowConfirmModal(false);
    const result = submitExam(courseId, answers);
    setExamResult(result);
    setIsSubmitted(true);
  };

  const handleRetry = () => {
    setAnswers({});
    setFlagged({});
    setTimeLeftSeconds(15 * 60);
    setIsSubmitted(false);
    setExamResult(null);
    setCurrentIndex(0);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const answeredCount = Object.keys(answers).length;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-16">
      {/* Top Header Card */}
      <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl p-5 shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-amber-500 text-slate-950 text-xs font-bold px-2 py-0.5 rounded">
              {course?.code || 'CLE'}
            </span>
            <span className="text-xs text-amber-300 font-medium">การสอบวัดผลออนไลน์ (Online Assessment)</span>
            <span className="bg-emerald-500/20 text-emerald-400 text-[10px] px-2 py-0.5 rounded border border-emerald-500/30 flex items-center gap-1 font-mono">
              <ShieldCheck className="w-3 h-3" />
              <span>Proctoring Active</span>
            </span>
          </div>
          <h1 className="text-lg sm:text-xl font-heading font-bold text-white mt-1">
            {course?.title}
          </h1>
          <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-1 font-mono">
            <span>เกณฑ์ผ่าน: ≥ {course?.passingScorePercent || 75}%</span>
            <span>•</span>
            <span className="text-amber-400/80">Idempotency-Key: idemp-asm-{course?.id?.substring(0, 8) || 'cle'}</span>
          </div>
        </div>

        {/* Timer & Exit */}
        <div className="flex items-center gap-3">
          {!isSubmitted && (
            <div className={`px-4 py-2 rounded-xl border flex items-center gap-2 ${
              timeLeftSeconds < 180 
                ? 'bg-rose-500/20 border-rose-500 text-rose-300 animate-pulse font-bold' 
                : 'bg-slate-800 border-slate-700 text-amber-400 font-mono font-bold'
            }`}>
              <Clock className="w-4 h-4" />
              <span className="text-base">{formatTime(timeLeftSeconds)}</span>
            </div>
          )}

          <button
            onClick={onExit}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors"
          >
            {isSubmitted ? 'ออกจากหน้าสอบ' : 'ยกเลิกการสอบ'}
          </button>
        </div>
      </div>

      {/* Main Exam Interface or Results View */}
      {!isSubmitted ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Question Body (2 cols) */}
          <div className="md:col-span-2 space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
              {/* Question Number & Flag */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-4">
                <span className="text-xs font-bold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-md">
                  คำถามข้อที่ {currentIndex + 1} จาก {examQuestions.length}
                </span>

                <button
                  onClick={() => toggleFlag(currentQ.id)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    flagged[currentQ.id]
                      ? 'bg-amber-100 text-amber-800 font-semibold'
                      : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  <Flag className={`w-3.5 h-3.5 ${flagged[currentQ.id] ? 'fill-amber-600 text-amber-600' : ''}`} />
                  <span>{flagged[currentQ.id] ? 'ติดธงไว้ทบทวนแล้ว' : 'ติดธงทบทวน'}</span>
                </button>
              </div>

              {/* Question Text */}
              <div className="text-slate-900 font-medium text-sm sm:text-base leading-relaxed mb-6">
                {currentQ.prompt}
              </div>

              {/* Options */}
              <div className="space-y-3">
                {currentQ.options.map((opt, optIdx) => {
                  const letter = String.fromCharCode(65 + optIdx);
                  const isSelected = answers[currentQ.id] === opt.id;

                  return (
                    <div
                      key={opt.id}
                      onClick={() => handleSelectOption(opt.id)}
                      className={`p-4 rounded-xl border text-xs sm:text-sm cursor-pointer transition-all flex items-start gap-3.5 ${
                        isSelected
                          ? 'border-amber-500 bg-amber-50/80 text-amber-950 font-medium shadow-sm'
                          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 ${
                        isSelected
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-slate-100 text-slate-600 border border-slate-300'
                      }`}>
                        {letter}
                      </div>
                      <div className="flex-1 leading-relaxed pt-0.5">
                        {opt.text}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Pagination Controls */}
              <div className="flex items-center justify-between pt-6 mt-6 border-t border-slate-100">
                <button
                  onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
                  disabled={currentIndex === 0}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>ข้อก่อนหน้า</span>
                </button>

                {currentIndex < examQuestions.length - 1 ? (
                  <button
                    onClick={() => setCurrentIndex(prev => Math.min(examQuestions.length - 1, prev + 1))}
                    className="px-5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                  >
                    <span>ข้อถัดไป</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => setShowConfirmModal(true)}
                    className="px-6 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors shadow-md"
                  >
                    <Check className="w-4 h-4" />
                    <span>ส่งกระดาษคำตอบ</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Navigation Sidebar Palette (1 col) */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h3 className="font-heading font-bold text-sm text-slate-900 mb-3">
                ผังข้อสอบ (Question Palette)
              </h3>

              {/* Status explanation */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600 mb-4 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-amber-500" />
                  <span>ตอบแล้ว ({answeredCount})</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-slate-100 border border-slate-300" />
                  <span>ยังไม่ตอบ ({examQuestions.length - answeredCount})</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-amber-200 border border-amber-400" />
                  <span>ติดธง</span>
                </div>
              </div>

              {/* Grid of numbers */}
              <div className="grid grid-cols-5 gap-2">
                {examQuestions.map((q, idx) => {
                  const isAnswered = !!answers[q.id];
                  const isFlagged = !!flagged[q.id];
                  const isCurrent = idx === currentIndex;

                  return (
                    <button
                      key={q.id}
                      onClick={() => setCurrentIndex(idx)}
                      className={`h-9 rounded-lg font-bold text-xs flex items-center justify-center relative transition-all ${
                        isCurrent
                          ? 'ring-2 ring-slate-950 ring-offset-2'
                          : ''
                      } ${
                        isAnswered
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                      }`}
                    >
                      <span>{idx + 1}</span>
                      {isFlagged && (
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-rose-500 rounded-full" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Submit Button */}
              <button
                onClick={() => setShowConfirmModal(true)}
                className="mt-6 w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors shadow-md flex items-center justify-center gap-2"
              >
                <Check className="w-4 h-4 text-amber-400" />
                <span>ยืนยันส่งกระดาษคำตอบ</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Results View */
        <div className="space-y-6">
          <div className={`p-8 rounded-2xl border text-center shadow-lg ${
            examResult?.passed 
              ? 'bg-gradient-to-br from-emerald-950 via-slate-900 to-slate-900 border-emerald-500/40 text-white' 
              : 'bg-gradient-to-br from-rose-950 via-slate-900 to-slate-900 border-rose-500/40 text-white'
          }`}>
            <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center mb-4 bg-white/10 backdrop-blur-sm border border-white/20">
              {examResult?.passed ? (
                <Award className="w-9 h-9 text-amber-400" />
              ) : (
                <XCircle className="w-9 h-9 text-rose-400" />
              )}
            </div>

            <div className="inline-block px-3 py-1 rounded-full text-xs font-bold mb-2 uppercase tracking-wider bg-white/10 text-slate-200">
              ผลการทดสอบออนไลน์
            </div>

            <h2 className="text-2xl sm:text-3xl font-heading font-bold mb-2">
              {examResult?.passed ? 'ขอแสดงความยินดี! คุณสอบผ่านเกณฑ์' : 'ผลคะแนนยังไม่ผ่านเกณฑ์การประเมิน'}
            </h2>

            <p className="text-sm text-slate-300 max-w-lg mx-auto">
              {examResult?.passed 
                ? `คุณทำคะแนนได้ ${examResult?.scorePercent}% (เกณฑ์ผ่าน ${course?.passingScorePercent}%) ระบบได้ทำการออกใบประกาศนียบัตรดิจิทัลและบันทึก ${course?.credits} CLE หน่วยกิตเข้าสู่ Credit Bank ของคุณแล้ว`
                : `คุณทำคะแนนได้ ${examResult?.scorePercent}% (เกณฑ์ผ่าน ${course?.passingScorePercent}%) ท่านสามารถทบทวนบทเรียนและเริ่มทำข้อสอบใหม่ได้ตลอดเวลา`
              }
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
              {examResult?.passed && examResult.certificate && (
                <button
                  onClick={() => onViewCertificate(examResult.certificate!)}
                  className="px-6 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg transition-transform hover:scale-105"
                >
                  <Award className="w-4 h-4" />
                  <span>ดูใบประกาศนียบัตรที่ได้รับ</span>
                </button>
              )}

              {examResult?.passed && (
                <button
                  onClick={() => setActiveTab('credit-bank')}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-xl text-xs flex items-center gap-2 transition-colors"
                >
                  <FileCheck className="w-4 h-4 text-emerald-400" />
                  <span>ตรวจสอบใน Credit Bank</span>
                </button>
              )}

              {!examResult?.passed && (
                <button
                  onClick={handleRetry}
                  className="px-6 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>ทำข้อสอบใหม่อีกครั้ง</span>
                </button>
              )}

              <button
                onClick={onExit}
                className="px-4 py-2.5 bg-slate-800/80 hover:bg-slate-800 text-slate-300 font-medium rounded-xl text-xs transition-colors"
              >
                กลับสู่หน้าหลักสูตร
              </button>
            </div>
          </div>

          {/* Detailed Question Review with Legal References */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-6">
            <h3 className="font-heading font-bold text-base text-slate-900 border-b border-slate-200 pb-3 flex items-center justify-between">
              <span>เฉลยคำตอบพร้อมคำอธิบายและข้อกฎหมาย</span>
              <span className="text-xs text-slate-500 font-normal">ตามมาตรฐานข้อบังคับสภาทนายความ</span>
            </h3>

            <div className="space-y-6">
              {examQuestions.map((q, idx) => {
                const userChoice = answers[q.id];
                const isCorrect = userChoice === q.correctOptionId;

                return (
                  <div key={q.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50/60 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-semibold text-xs text-slate-900">
                        ข้อที่ {idx + 1}: {q.prompt}
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold shrink-0 flex items-center gap-1 ${
                        isCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {isCorrect ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                        <span>{isCorrect ? 'ถูกต้อง' : 'ไม่ถูกต้อง'}</span>
                      </span>
                    </div>

                    {/* Options list showing what was picked */}
                    <div className="space-y-1.5 pl-2 text-xs">
                      {q.options.map(opt => {
                        const isCorrectOpt = opt.id === q.correctOptionId;
                        const isUserOpt = opt.id === userChoice;

                        return (
                          <div
                            key={opt.id}
                            className={`p-2 rounded-lg flex items-center gap-2 ${
                              isCorrectOpt
                                ? 'bg-emerald-50 text-emerald-900 font-medium border border-emerald-200'
                                : isUserOpt && !isCorrect
                                ? 'bg-rose-50 text-rose-900 border border-rose-200'
                                : 'text-slate-600'
                            }`}
                          >
                            <span className="font-bold">{isCorrectOpt ? '✓ คำตอบที่ถูกต้อง:' : isUserOpt ? '✗ ท่านเลือก:' : '•'}</span>
                            <span>{opt.text}</span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Legal Citation Box */}
                    <div className="bg-amber-50/70 border border-amber-200/80 p-3 rounded-lg text-xs text-amber-950 space-y-1">
                      <div className="font-bold flex items-center gap-1 text-amber-900">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>เหตุผลและหลักกฎหมายอ้างอิง:</span>
                      </div>
                      <p className="text-slate-700">{q.explanation}</p>
                      <div className="text-[11px] font-mono text-amber-800 font-medium pt-1">
                        ฐานทางกฎหมาย: {q.legalReference}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6" />
            </div>

            <h3 className="text-center font-heading font-bold text-base text-slate-900">
              ยืนยันการส่งกระดาษคำตอบ?
            </h3>

            <p className="text-center text-xs text-slate-600 mt-2">
              ท่านตอบคำถามแล้ว {answeredCount} จาก {examQuestions.length} ข้อ <br />
              {examQuestions.length - answeredCount > 0 && (
                <span className="text-rose-600 font-semibold mt-1 inline-block">
                  (ยังมีข้อที่ยังไม่ได้ตอบ {examQuestions.length - answeredCount} ข้อ)
                </span>
              )}
            </p>

            <div className="flex items-center gap-3 mt-6">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold transition-colors"
              >
                กลับไปตรวจทาน
              </button>
              <button
                onClick={handleSubmit}
                className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold transition-colors shadow-sm"
              >
                ยืนยันส่งข้อสอบ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
