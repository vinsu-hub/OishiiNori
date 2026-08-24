import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center"
      style={{ background: '#f3eddb', fontFamily: '"DM Sans", sans-serif', color: '#232321' }}
    >
      <div className="w-full max-w-lg mx-4 text-center" style={{ padding: '40px 24px' }}>
        <AlertCircle size={56} style={{ color: '#d9361e', margin: '0 auto 20px' }} />
        <h1 style={{ fontFamily: '"Bebas Neue", sans-serif', fontSize: 64, margin: '0 0 8px', color: '#d9361e' }}>404</h1>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 14px' }}>Page not found</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: '#6b6357', marginBottom: 28 }}>
          Sorry, the page you're looking for doesn't exist.
          <br />
          It may have been moved or deleted.
        </p>
        <button
          onClick={() => setLocation("/")}
          className="dark-button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <Home size={14} /> Go home
        </button>
      </div>
    </div>
  );
}
