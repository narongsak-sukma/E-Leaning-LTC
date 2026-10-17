import React, { useState } from 'react';
import { useApp } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { PersonaBanner } from './components/PersonaBanner';
import { CourseCatalog } from './components/CourseCatalog';
import { CourseDetailModal } from './components/CourseDetailModal';
import { Classroom } from './components/Classroom';
import { ExamEngine } from './components/ExamEngine';
import { CreditBank } from './components/CreditBank';
import { CertificatesList } from './components/CertificatesList';
import { CertificateModal } from './components/CertificateModal';
import { VerifyCertificate } from './components/VerifyCertificate';
import { InstructorStudio } from './components/InstructorStudio';
import { AdminPortal } from './components/AdminPortal';
import { MyLearning } from './components/MyLearning';
import { LicenseBindingModal } from './components/LicenseBindingModal';
import { Course, Certificate } from './types';
import { Scale, Heart } from 'lucide-react';

export const AppContent: React.FC = () => {
  const { 
    activeTab, 
    setActiveTab, 
    courses, 
    enrollCourse,
    learningCourseId, 
    setLearningCourseId,
    examCourseId, 
    setExamCourseId,
    viewingCertificate, 
    setViewingCertificate,
  } = useApp();

  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [isLicenseModalOpen, setIsLicenseModalOpen] = useState(false);

  // Handlers
  const handleSelectCourse = (course: Course) => {
    setSelectedCourse(course);
  };

  const handleEnterClassroom = (courseId: string) => {
    setLearningCourseId(courseId);
    setExamCourseId(null);
  };

  const handleStartExam = (courseId: string) => {
    setExamCourseId(courseId);
  };

  const handleExitClassroom = () => {
    setLearningCourseId(null);
  };

  const handleExitExam = () => {
    setExamCourseId(null);
  };

  const handleViewCert = (cert: Certificate) => {
    setViewingCertificate(cert);
  };

  return (
    <div className="min-h-screen bg-slate-100/70 text-slate-900 flex flex-col font-['Sarabun',sans-serif]">
      {/* Top Navigation */}
      <Navbar />

      {/* RBAC Persona Quick Bar */}
      <PersonaBanner onOpenLicenseModal={() => setIsLicenseModalOpen(true)} />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        {/* If Active Exam is running, take priority */}
        {examCourseId ? (
          <ExamEngine
            courseId={examCourseId}
            onExit={handleExitExam}
            onViewCertificate={handleViewCert}
          />
        ) : learningCourseId ? (
          /* Active Classroom */
          <Classroom
            courseId={learningCourseId}
            onBack={handleExitClassroom}
            onStartExam={handleStartExam}
          />
        ) : (
          /* Standard Tabs */
          <>
            {activeTab === 'catalog' && (
              <CourseCatalog
                onSelectCourse={handleSelectCourse}
                onEnterClassroom={handleEnterClassroom}
              />
            )}

            {activeTab === 'my-learning' && (
              <MyLearning
                onEnterClassroom={handleEnterClassroom}
                onStartExam={handleStartExam}
                onExploreCourses={() => setActiveTab('catalog')}
              />
            )}

            {activeTab === 'credit-bank' && (
              <CreditBank onViewCertificate={handleViewCert} />
            )}

            {activeTab === 'certificates' && (
              <CertificatesList onViewCertificate={handleViewCert} />
            )}

            {activeTab === 'verify' && (
              <VerifyCertificate onViewCertificate={handleViewCert} />
            )}

            {activeTab === 'instructor-studio' && (
              <InstructorStudio />
            )}

            {activeTab === 'admin-portal' && (
              <AdminPortal />
            )}
          </>
        )}
      </main>

      {/* Course Detail Modal */}
      <CourseDetailModal
        course={selectedCourse}
        onClose={() => setSelectedCourse(null)}
        onEnroll={(cId) => {
          enrollCourse(cId);
          handleEnterClassroom(cId);
        }}
        onEnterClassroom={handleEnterClassroom}
      />

      {/* Certificate Modal */}
      <CertificateModal
        certificate={viewingCertificate}
        onClose={() => setViewingCertificate(null)}
      />

      {/* License Binding Modal */}
      <LicenseBindingModal
        isOpen={isLicenseModalOpen}
        onClose={() => setIsLicenseModalOpen(false)}
      />

      {/* Institutional Footer */}
      <footer className="bg-slate-900 border-t border-slate-800 text-slate-400 text-xs py-8 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center text-slate-950 font-bold">
                <Scale className="w-5 h-5" />
              </div>
              <div>
                <div className="font-heading font-bold text-white text-sm">
                  สภาทนายความ ในพระบรมราชูปถัมภ์ (Lawyers Council of Thailand)
                </div>
                <div className="text-[11px] text-slate-400">
                  ระบบการเรียนรู้ออนไลน์และ Credit Bank สำหรับการพัฒนาวิชาชีพทางกฎหมายต่อเนื่อง
                </div>
              </div>
            </div>

            <div className="text-center md:text-right text-[11px] space-y-1">
              <div>249 ถนนราชดำเนินกลาง แขวงบวรนิเวศ เขตพระนคร กรุงเทพฯ 10200</div>
              <div>โทรศัพท์ 0-2522-7124 ถึง 27 · อีเมล info@lawyerscouncil.or.th</div>
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-2 text-[10px] text-slate-400">
            <div>
              © 2026 สภาทนายความ ในพระบรมราชูปถัมภ์. สงวนลิขสิทธิ์ทั้งหมด. PDPA & ASVS L2 Certified.
            </div>
            <div className="flex items-center gap-4">
              <span>นโยบายคุ้มครองข้อมูลส่วนบุคคล</span>
              <span>•</span>
              <span>ข้อบังคับมรรยาททนายความ</span>
              <span>•</span>
              <span>คู่มือผู้ใช้งาน</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};
