import * as React from 'react';

interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
}

const COLORS: Record<NonNullable<ToastProps['type']>, string> = {
  success: '#3f7d4a',
  error: 'var(--red, #d9361e)',
  info: 'var(--ink, #232321)',
};

export function Toast({ message, type = 'info', onClose }: ToastProps) {
  React.useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      role="alert"
      style={{
        background: COLORS[type],
        color: '#fff7e6',
        padding: '12px 16px',
        borderRadius: 6,
        fontFamily: '"DM Sans", sans-serif',
        fontSize: 12,
        boxShadow: '0 8px 24px rgba(35,35,33,.28)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span>{message}</span>
      <button
        onClick={onClose}
        style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', opacity: 0.8 }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

interface ToasterProps {
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
}

const POSITION_STYLES: Record<NonNullable<ToasterProps['position']>, React.CSSProperties> = {
  'top-right': { top: 24, right: 24 },
  'top-left': { top: 24, left: 24 },
  'bottom-right': { bottom: 24, right: 24 },
  'bottom-left': { bottom: 24, left: 24 },
};

export function Toaster({ position = 'top-right' }: ToasterProps) {
  const [toasts, setToasts] = React.useState<Array<{ id: number; message: string; type: 'success' | 'error' | 'info' }>>([]);

  const addToast = React.useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // Expose addToast globally, same convention as customer-menu's Toaster.
  React.useEffect(() => {
    (window as any).toast = addToast;
    return () => {
      delete (window as any).toast;
    };
  }, [addToast]);

  return (
    <div style={{ position: 'fixed', zIndex: 50, display: 'flex', flexDirection: 'column', gap: 8, ...POSITION_STYLES[position] }}>
      {toasts.map((toast) => (
        <Toast key={toast.id} message={toast.message} type={toast.type} onClose={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))} />
      ))}
    </div>
  );
}
