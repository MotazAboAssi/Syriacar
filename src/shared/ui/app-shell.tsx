export default function AppShell() {
  return (
    <div className="app-shell">
      <header className="shell-header">
        <span className="wordmark">سيرياكار</span>
      </header>

      <main className="shell-main">
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">خدمات سيرياكار</p>
          <h1 id="page-title">اطلب فحصًا أو سطحة لمركبتك</h1>
          <p className="intro-copy">
            اختر الخدمة المناسبة وأرسل طلبك إلى مزود متاح دون الحاجة إلى إنشاء حساب.
          </p>
          <a className="health-link" href="/inspection/guest">
            طلب فحص كضيف
            <span aria-hidden="true">←</span>
          </a>
          <a className="health-link" href="/towing/guest">
            طلب سطحة كضيف
            <span aria-hidden="true">←</span>
          </a>
          <a className="health-link" href="/api/health">
            فحص سلامة التطبيق
            <span aria-hidden="true">←</span>
          </a>
        </section>
      </main>

      <footer className="shell-footer">
        سيرياكار — نسخة تأسيسية
      </footer>
    </div>
  );
}