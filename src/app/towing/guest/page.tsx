import GuestTowingFlow from "@/modules/guest-towing/ui/guest-towing-flow";

export default function GuestTowingPage() {
  return (
    <div className="app-shell">
      <header className="shell-header">
        <a className="wordmark" href="/">سيرياكار</a>
        <a className="guest-home-link" href="/">الرئيسية</a>
      </header>
      <main className="guest-shell-main">
        <GuestTowingFlow />
      </main>
      <footer className="shell-footer">سيرياكار — خدمات المركبات</footer>
    </div>
  );
}