const NAV_ITEMS = [
  { href: "/courses", label: "หลักสูตรฝึกอบรม" },
  { href: "/login", label: "เข้าสู่ระบบ" },
] as const;

export default function HomePage() {
  return (
    <div className="min-h-dvh bg-mist-50">
      <a href="#main" className="skip-link">
        ข้ามไปยังเนื้อหาหลัก
      </a>
      <div className="bg-brand-900 text-center text-xs text-mist-100 sm:text-sm">
        <div className="mx-auto max-w-5xl px-4 py-2">
          สภาทนายความแห่งประเทศไทย · โทร 0 2351 1128
        </div>
      </div>
      <header className="border-b border-mist-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <p className="font-heading text-base font-semibold text-brand-900 sm:text-lg">
            ระบบฝึกอบรมออนไลน์
          </p>
          <nav aria-label="เมนูหลัก">
            <ul className="flex items-center gap-5 text-sm font-medium text-ink-600">
              {NAV_ITEMS.map((item) => (
                <li key={item.href}>
                  <a className="hover:text-brand-700" href={item.href}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main">
        <section className="bg-brand-800 text-mist-50">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:py-20">
            <p className="mb-3 text-sm font-medium text-gold-300">
              ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
            </p>
            <h1 className="max-w-2xl font-heading text-2xl font-bold leading-snug sm:text-4xl">
              หลักสูตรออนไลน์เพื่อรักษาใบอนุญาตทนายความ
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-mist-100 sm:text-base">
              เรียนรู้ด้วยตนเองตามเวลาที่สะดวก บันทึกหน่วยกิตอัตโนมัติ (Credit Bank)
              และสอบออนไลน์อย่างเป็นทางการ ตั้งแต่ลงทะเบียนจนออกประกาศนียบัตรในระบบเดียว
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                className="rounded-lg bg-gold-500 px-6 py-3 font-heading text-sm font-semibold text-brand-900 shadow-pop hover:bg-gold-300"
                href="/login"
              >
                เข้าสู่ระบบเพื่อเรียน
              </a>
              <a
                className="rounded-lg border border-mist-100 px-6 py-3 font-heading text-sm font-semibold text-mist-50 hover:bg-brand-700"
                href="/courses"
              >
                ดูหลักสูตรฝึกอบรม
              </a>
            </div>
          </div>
        </section>
        <section className="mx-auto max-w-5xl px-4 py-14">
          <h2 className="font-heading text-xl font-bold text-brand-900 sm:text-2xl">
            บริการหลักของระบบ
          </h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-xl border border-mist-200 bg-white p-5 shadow-card">
                <p className="font-heading text-base font-semibold text-brand-900">{f.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="border-t border-gold-200 bg-gold-50">
          <div className="mx-auto max-w-5xl px-4 py-6">
            <p className="text-sm leading-relaxed text-ink-600">
              <strong className="font-semibold text-ink-700">หมายเหตุ:</strong>{" "}
              ระบบอยู่ระหว่างการพัฒนา (Wave B — โครงระบบพื้นฐาน)
              ฟังก์ชันการเรียนและการสอบจะเปิดใช้งานในลำดับถัดไป
              ติดต่อสอบถามได้ที่สำนักงานสภาทนายความแห่งประเทศไทย โทร 0 2351 1128
            </p>
          </div>
        </section>
      </main>
      <footer className="bg-brand-900 text-mist-200">
        <div className="mx-auto max-w-5xl px-4 py-6 text-xs leading-relaxed sm:text-sm">
          <p className="font-heading font-semibold text-mist-50">
            ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย
          </p>
          <p className="mt-1">สอบถามเพิ่มเติม โทร 0 2351 1128 ในวันและเวลาราชการ</p>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    title: "หลักสูตรออนไลน์",
    body: "เรียนบทวิดีโอและเอกสารตามหลักสูตรที่สภาทนายความรับรอง ตรวจสอบความคืบหน้าได้ทุกขั้นตอน",
  },
  {
    title: "การสอบออนไลน์",
    body: "สอบรับประกาศนียบัตรตามรอบที่กำหนด พร้อมกติกาจำนวนครั้งและเวลาสอบที่ชัดเจน",
  },
  {
    title: "ธนาคารหน่วยกิต",
    body: "สะสมหน่วยกิตอบรมการฝึกอบรมเพื่อขอต่ออายุใบอนุญาตทนายความ ตรวจสถานะได้ตลอดเวลา",
  },
] as const;
