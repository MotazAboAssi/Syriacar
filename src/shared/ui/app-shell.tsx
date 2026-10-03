export default function AppShell() {
  return (
    <div className="app-shell">
      <header className="shell-header">
        <span className="wordmark">سيرياكار</span>
      </header>

      <main className="shell-main">
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">الأساس التقني</p>
          <h1 id="page-title">الأساس التقني لسيرياكار جاهز</h1>
          <p className="intro-copy">
            تم إعداد البنية التقنية للمشروع. الخدمات والميزات لم تُفعّل بعد.
          </p>
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