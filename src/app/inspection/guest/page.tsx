import GuestInspectionForm from "@/modules/guest-inspection/ui/guest-inspection-form";

export default function GuestInspectionPage() {
  return (
    <div className="app-shell">
      <header className="shell-header">
        <a className="wordmark" href="/">سيرياكار</a>
        <a className="guest-home-link" href="/">الرئيسية</a>
      </header>
      <main className="guest-shell-main">
        <GuestInspectionForm />
      </main>
      <footer className="shell-footer">سيرياكار — فحص المركبات</footer>
    </div>
  );
}