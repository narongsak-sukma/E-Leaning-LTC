import React, { createContext, useContext, useState, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { 
  UserProfile, 
  Course, 
  Question, 
  Enrollment, 
  Certificate, 
  CreditLedgerEntry, 
  AuditLogEntry, 
  NotificationItem, 
  RoleType,
  CourseCategory 
} from '../types';
import { 
  INITIAL_PERSONAS, 
  INITIAL_COURSES, 
  INITIAL_QUESTIONS, 
  INITIAL_CERTIFICATES, 
  INITIAL_CREDIT_LEDGER, 
  INITIAL_AUDIT_LOGS, 
  INITIAL_NOTIFICATIONS 
} from '../data/mockData';

interface AppContextType {
  currentUser: UserProfile;
  switchPersona: (personaKey: string) => void;
  courses: Course[];
  questions: Question[];
  enrollments: Enrollment[];
  certificates: Certificate[];
  creditLedger: CreditLedgerEntry[];
  auditLogs: AuditLogEntry[];
  notifications: NotificationItem[];
  activeTab: string;
  setActiveTab: (tab: string) => void;
  selectedCourseId: string | null;
  setSelectedCourseId: (id: string | null) => void;
  learningCourseId: string | null;
  setLearningCourseId: (id: string | null) => void;
  examCourseId: string | null;
  setExamCourseId: (id: string | null) => void;
  viewingCertificate: Certificate | null;
  setViewingCertificate: (cert: Certificate | null) => void;
  
  allUsers: UserProfile[];
  updateUserRoles: (userId: string, roles: RoleType[]) => void;
  addCreditAdjustment: (userId: string, credits: number, category: CourseCategory, title: string, reason: string) => void;
  deleteQuestion: (questionId: string) => void;
  toggleCoursePublish: (courseId: string) => void;
  enrollCourse: (courseId: string) => void;
  completeLesson: (courseId: string, lessonId: string) => void;
  submitExam: (courseId: string, userAnswers: Record<string, string>) => { passed: boolean; scorePercent: number; certificate?: Certificate };
  verifyCertificateCode: (code: string) => Certificate | null;
  addCourse: (courseData: Partial<Course>) => void;
  addQuestion: (qData: Partial<Question>) => void;
  bindLawyerLicense: (licenseNo: string) => void;
  markNotificationsAsRead: () => void;
  addAuditLog: (action: string, targetResource: string, details: string, status?: 'SUCCESS' | 'WARNING' | 'FAILED') => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('ltc_current_persona');
    return saved && INITIAL_PERSONAS[saved] ? INITIAL_PERSONAS[saved] : INITIAL_PERSONAS.lawyer;
  });

  const [allUsers, setAllUsers] = useState<UserProfile[]>(() => {
    const saved = localStorage.getItem('ltc_all_users');
    return saved ? JSON.parse(saved) : Object.values(INITIAL_PERSONAS);
  });

  const [courses, setCourses] = useState<Course[]>(() => {
    const saved = localStorage.getItem('ltc_courses');
    return saved ? JSON.parse(saved) : INITIAL_COURSES;
  });

  const [questions, setQuestions] = useState<Question[]>(() => {
    const saved = localStorage.getItem('ltc_questions');
    return saved ? JSON.parse(saved) : INITIAL_QUESTIONS;
  });

  const [enrollments, setEnrollments] = useState<Enrollment[]>(() => {
    const saved = localStorage.getItem('ltc_enrollments');
    return saved ? JSON.parse(saved) : [
      {
        id: 'enr-1',
        userId: 'usr-lawyer-01',
        courseId: 'course-cle-01',
        enrolledAt: '2026-10-15T09:00:00Z',
        completedLessons: ['les-1-1'],
        status: 'in_progress',
      },
      {
        id: 'enr-2',
        userId: 'usr-lawyer-01',
        courseId: 'course-cle-02',
        enrolledAt: '2025-11-10T14:00:00Z',
        completedLessons: ['les-pdpa-1'],
        examScore: 90,
        examPassed: true,
        status: 'completed',
        completedAt: '2025-11-15T16:00:00Z',
        certificateId: 'cert-001',
      },
    ];
  });

  const [certificates, setCertificates] = useState<Certificate[]>(() => {
    const saved = localStorage.getItem('ltc_certificates');
    return saved ? JSON.parse(saved) : INITIAL_CERTIFICATES;
  });

  const [creditLedger, setCreditLedger] = useState<CreditLedgerEntry[]>(() => {
    const saved = localStorage.getItem('ltc_credit_ledger');
    return saved ? JSON.parse(saved) : INITIAL_CREDIT_LEDGER;
  });

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>(() => {
    const saved = localStorage.getItem('ltc_audit_logs');
    return saved ? JSON.parse(saved) : INITIAL_AUDIT_LOGS;
  });

  const [notifications, setNotifications] = useState<NotificationItem[]>(INITIAL_NOTIFICATIONS);

  const [activeTab, setActiveTab] = useState<string>('catalog');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [learningCourseId, setLearningCourseId] = useState<string | null>(null);
  const [examCourseId, setExamCourseId] = useState<string | null>(null);
  const [viewingCertificate, setViewingCertificate] = useState<Certificate | null>(null);

  // Sync state to local storage
  useEffect(() => {
    localStorage.setItem('ltc_courses', JSON.stringify(courses));
  }, [courses]);

  useEffect(() => {
    localStorage.setItem('ltc_questions', JSON.stringify(questions));
  }, [questions]);

  useEffect(() => {
    localStorage.setItem('ltc_enrollments', JSON.stringify(enrollments));
  }, [enrollments]);

  useEffect(() => {
    localStorage.setItem('ltc_certificates', JSON.stringify(certificates));
  }, [certificates]);

  useEffect(() => {
    localStorage.setItem('ltc_credit_ledger', JSON.stringify(creditLedger));
  }, [creditLedger]);

  useEffect(() => {
    localStorage.setItem('ltc_audit_logs', JSON.stringify(auditLogs));
  }, [auditLogs]);

  const addAuditLog = (
    action: string, 
    targetResource: string, 
    details: string, 
    status: 'SUCCESS' | 'WARNING' | 'FAILED' = 'SUCCESS'
  ) => {
    const now = new Date();
    const formattedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    const newEntry: AuditLogEntry = {
      id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: formattedDate,
      userId: currentUser.id,
      userName: currentUser.name,
      userRole: currentUser.currentRole,
      action,
      targetResource,
      ipAddress: '171.96.12.84',
      status,
      details,
    };

    setAuditLogs(prev => [newEntry, ...prev]);
  };

  const switchPersona = (personaKey: string) => {
    const persona = INITIAL_PERSONAS[personaKey];
    if (persona) {
      setCurrentUser(persona);
      localStorage.setItem('ltc_current_persona', personaKey);
      addAuditLog('AUTH_ROLE_SWITCH', persona.currentRole, `สลับบทบาทผู้ใช้เป็น ${persona.name} (${persona.currentRole})`);
    }
  };

  const enrollCourse = (courseId: string) => {
    const course = courses.find(c => c.id === courseId);
    if (!course) return;

    const existing = enrollments.find(e => e.userId === currentUser.id && e.courseId === courseId);
    if (existing) {
      setLearningCourseId(courseId);
      return;
    }

    const newEnrollment: Enrollment = {
      id: `enr-${Date.now()}`,
      userId: currentUser.id,
      courseId,
      enrolledAt: new Date().toISOString(),
      completedLessons: [],
      status: 'in_progress',
    };

    setEnrollments(prev => [...prev, newEnrollment]);
    setCourses(prev => prev.map(c => c.id === courseId ? { ...c, enrolledStudentsCount: c.enrolledStudentsCount + 1 } : c));
    addAuditLog('COURSE_ENROLL', course.code, `ลงทะเบียนหลักสูตร ${course.title}`);
    setLearningCourseId(courseId);
  };

  const completeLesson = (courseId: string, lessonId: string) => {
    setEnrollments(prev => prev.map(enr => {
      if (enr.userId === currentUser.id && enr.courseId === courseId) {
        const completed = enr.completedLessons.includes(lessonId)
          ? enr.completedLessons
          : [...enr.completedLessons, lessonId];
        return {
          ...enr,
          completedLessons: completed,
        };
      }
      return enr;
    }));

    addAuditLog('LESSON_COMPLETE', lessonId, `เรียนจบบทเรียนในหลักสูตร ${courseId}`);
  };

  const submitExam = (courseId: string, userAnswers: Record<string, string>) => {
    const course = courses.find(c => c.id === courseId);
    if (!course) return { passed: false, scorePercent: 0 };

    const courseQuestions = questions.filter(q => q.courseId === courseId);
    if (courseQuestions.length === 0) return { passed: false, scorePercent: 0 };

    let correctCount = 0;
    courseQuestions.forEach(q => {
      if (userAnswers[q.id] === q.correctOptionId) {
        correctCount++;
      }
    });

    const scorePercent = Math.round((correctCount / courseQuestions.length) * 100);
    const passed = scorePercent >= course.passingScorePercent;

    addAuditLog(
      'EXAM_ATTEMPT_SUBMIT', 
      course.code, 
      `ส่งกระดาษคำตอบ ได้คะแนน ${scorePercent}% (เกณฑ์ผ่าน ${course.passingScorePercent}%) ผล: ${passed ? 'ผ่าน' : 'ไม่ผ่าน'}`,
      passed ? 'SUCCESS' : 'WARNING'
    );

    let newCert: Certificate | undefined;

    if (passed) {
      // Trigger confetti celebration!
      try {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 }
        });
      } catch (e) {
        // ignore in non-browser env
      }

      const certNumber = `LTC-2026-CLE-${Math.floor(1000 + Math.random() * 9000)}`;
      newCert = {
        id: `cert-${Date.now()}`,
        certificateNumber: certNumber,
        courseId: course.id,
        courseTitle: course.title,
        userId: currentUser.id,
        userName: currentUser.name,
        lawyerLicenseNumber: currentUser.lawyerLicenseNumber,
        creditsAwarded: course.credits,
        issueDate: '17 ต.ค. 2569',
        status: 'valid',
        qrVerificationUrl: `https://ais-dev-62bmzff5a5pesty7dayb6n-1014253629858.asia-southeast1.run.app/verify?code=${certNumber}`,
        signatureRegistrar: 'กาญจนา นิติการ (นายทะเบียน)',
      };

      setCertificates(prev => [newCert!, ...prev]);

      // If lawyer, also add to Credit Ledger and increment credits
      if (currentUser.currentRole === 'lawyer' || currentUser.roles.includes('lawyer')) {
        const newLedgerEntry: CreditLedgerEntry = {
          id: `ledg-${Date.now()}`,
          userId: currentUser.id,
          date: '17 ต.ค. 2569',
          courseId: course.id,
          courseTitle: course.title,
          category: course.category,
          credits: course.credits,
          type: 'course_cle',
          certificateNumber: certNumber,
          approvedBy: 'กาญจนา นิติการ (นายทะเบียน)',
          status: 'approved',
        };

        setCreditLedger(prev => [newLedgerEntry, ...prev]);

        setCurrentUser(prev => ({
          ...prev,
          creditsEarned: prev.creditsEarned + course.credits,
        }));

        addAuditLog('CREDIT_LEDGER_APPEND', certNumber, `บันทึกหน่วยกิตสะสม +${course.credits} หน่วย ให้แก่ ${currentUser.name}`);
      }

      // Update enrollment status
      setEnrollments(prev => prev.map(enr => {
        if (enr.userId === currentUser.id && enr.courseId === courseId) {
          return {
            ...enr,
            examScore: scorePercent,
            examPassed: true,
            status: 'completed',
            completedAt: new Date().toISOString(),
            certificateId: newCert!.id,
          };
        }
        return enr;
      }));

      // Add Notification
      setNotifications(prev => [
        {
          id: `notif-${Date.now()}`,
          title: `ยินดีด้วย! สอบผ่านหลักสูตร ${course.code}`,
          message: `คุณสอบผ่านได้คะแนน ${scorePercent}% ได้รับประกาศนียบัตรเลขที่ ${certNumber} และสะสม ${course.credits} หน่วยกิต`,
          timestamp: 'เมื่อสักครู่',
          read: false,
          linkTab: 'certificates',
        },
        ...prev
      ]);
    }

    return { passed, scorePercent, certificate: newCert };
  };

  const verifyCertificateCode = (code: string): Certificate | null => {
    const trimmed = code.trim().toUpperCase();
    return certificates.find(c => c.certificateNumber.toUpperCase() === trimmed) || null;
  };

  const addCourse = (courseData: Partial<Course>) => {
    const newCourse: Course = {
      id: `course-${Date.now()}`,
      code: courseData.code || `CLE-${Math.floor(100 + Math.random() * 900)}`,
      title: courseData.title || 'หลักสูตรใหม่',
      subtitle: courseData.subtitle || '',
      category: courseData.category || 'substantive',
      targetAudience: courseData.targetAudience || 'lawyer',
      credits: courseData.credits || 4,
      durationHours: courseData.durationHours || 4,
      passingScorePercent: courseData.passingScorePercent || 75,
      coverImage: courseData.coverImage || 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&w=800&q=80',
      instructorName: currentUser.name,
      instructorTitle: 'วิทยากร สภาทนายความ',
      instructorAvatar: currentUser.avatar,
      description: courseData.description || '',
      modules: courseData.modules || [],
      status: 'published',
      enrolledStudentsCount: 0,
      rating: 5.0,
      hasExam: true,
      isMandatoryForRenewal: courseData.isMandatoryForRenewal || false,
    };

    setCourses(prev => [newCourse, ...prev]);
    addAuditLog('COURSE_CREATE', newCourse.code, `สร้างหลักสูตรใหม่: ${newCourse.title}`);
  };

  const addQuestion = (qData: Partial<Question>) => {
    const newQ: Question = {
      id: `q-${Date.now()}`,
      courseId: qData.courseId || 'course-cle-01',
      prompt: qData.prompt || '',
      options: qData.options || [],
      correctOptionId: qData.correctOptionId || 'opt-a',
      explanation: qData.explanation || '',
      legalReference: qData.legalReference || '',
    };

    setQuestions(prev => [...prev, newQ]);
    addAuditLog('QUESTION_CREATE', newQ.courseId, `เพิ่มข้อสอบใหม่ในธนาคารข้อสอบหลักสูตร ${newQ.courseId}`);
  };

  const updateUserRoles = (userId: string, newRoles: RoleType[]) => {
    setAllUsers(prev => prev.map(u => {
      if (u.id === userId) {
        return { ...u, roles: newRoles, currentRole: newRoles[0] || 'citizen' };
      }
      return u;
    }));
    if (currentUser.id === userId) {
      setCurrentUser(prev => ({ ...prev, roles: newRoles, currentRole: newRoles[0] || 'citizen' }));
    }
    addAuditLog('USER_ROLE_UPDATE', userId, `ปรับปรุงสิทธิ์บทบาทผู้ใช้เป็น ${newRoles.join(', ')}`);
  };

  const addCreditAdjustment = (userId: string, credits: number, category: CourseCategory, title: string, reason: string) => {
    const entry: CreditLedgerEntry = {
      id: `ledg-adj-${Date.now()}`,
      userId,
      date: '17 ต.ค. 2569',
      courseTitle: title,
      category,
      credits,
      type: 'registrar_adjustment',
      approvedBy: currentUser.name,
      status: 'approved',
    };
    setCreditLedger(prev => [entry, ...prev]);
    if (currentUser.id === userId) {
      setCurrentUser(prev => ({ ...prev, creditsEarned: prev.creditsEarned + credits }));
    }
    addAuditLog('CREDIT_MANUAL_ADJUST', userId, `นายทะเบียนปรับเพิ่ม +${credits} หน่วยกิต (${title}) เหตุผล: ${reason}`);
  };

  const deleteQuestion = (questionId: string) => {
    setQuestions(prev => prev.filter(q => q.id !== questionId));
    addAuditLog('QUESTION_DELETE', questionId, `ลบข้อสอบออกจากคลังข้อสอบ`);
  };

  const toggleCoursePublish = (courseId: string) => {
    setCourses(prev => prev.map(c => {
      if (c.id === courseId) {
        const nextStatus = c.status === 'published' ? 'draft' : 'published';
        addAuditLog('COURSE_STATUS_CHANGE', c.code, `เปลี่ยนสถานะหลักสูตร ${c.title} เป็น ${nextStatus}`);
        return { ...c, status: nextStatus };
      }
      return c;
    }));
  };

  const bindLawyerLicense = (licenseNo: string) => {
    setCurrentUser(prev => ({
      ...prev,
      lawyerLicenseNumber: licenseNo,
      licenseStatus: 'verified',
      licenseExpiryDate: '31 ธ.ค. 2570',
      roles: Array.from(new Set([...prev.roles, 'lawyer' as RoleType])),
      currentRole: 'lawyer',
      creditsRequired: 30,
      currentCycle: 'รอบปี 2568 - 2570',
    }));

    addAuditLog('LICENSE_VERIFIED', licenseNo, `ผูกและยืนยันเลขที่ใบอนุญาตว่าความ ${licenseNo} สำเร็จ`);
  };

  const markNotificationsAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  return (
    <AppContext.Provider
      value={{
        currentUser,
        switchPersona,
        courses,
        questions,
        enrollments,
        certificates,
        creditLedger,
        auditLogs,
        notifications,
        activeTab,
        setActiveTab,
        selectedCourseId,
        setSelectedCourseId,
        learningCourseId,
        setLearningCourseId,
        examCourseId,
        setExamCourseId,
        viewingCertificate,
        setViewingCertificate,
        allUsers,
        updateUserRoles,
        addCreditAdjustment,
        deleteQuestion,
        toggleCoursePublish,
        enrollCourse,
        completeLesson,
        submitExam,
        verifyCertificateCode,
        addCourse,
        addQuestion,
        bindLawyerLicense,
        markNotificationsAsRead,
        addAuditLog,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
