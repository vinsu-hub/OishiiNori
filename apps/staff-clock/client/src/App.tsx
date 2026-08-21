import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Clock, User, LogIn, CheckCircle, XCircle, Loader2, Shield } from 'lucide-react';
import { getOrCreateKioskId } from '@/lib/kioskId';
import { initOfflineQueue } from '@/lib/offlineQueue';
import {
  AttendanceLog,
  KioskVerifyResult,
  QueuedOfflineError,
  kioskClockIn,
  kioskClockOut,
  kioskVerify,
} from '@/lib/kiosk';

declare global {
  interface Window {
    toast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  }
}

// Oishii Nori's kiosk.py has no break endpoints (unlike the SMFC reference
// this is ported from) -- so this state machine has no ON_BREAK stage.
type Stage =
  | 'IDLE'
  | 'CONFIRMING'
  | 'PUNCH_IN'
  | 'PUNCH_SUCCESS'
  | 'ACTIVE_WORK'
  | 'END_CONFIRM'
  | 'END_SUCCESS'
  | 'ALREADY_COMPLETED';

interface State {
  stage: Stage;
  employeeNumber: string;
  pin: string;
  employee: KioskVerifyResult | null;
  log: AttendanceLog | null;
  busy: boolean;
  error: string | null;
}

type Action =
  | { type: 'SET_EMPLOYEE_NUMBER'; value: string }
  | { type: 'SET_PIN'; value: string }
  | { type: 'VERIFY_START' }
  | { type: 'VERIFY_ERROR'; error: string }
  | { type: 'VERIFIED'; employee: KioskVerifyResult; log: AttendanceLog | null }
  | { type: 'CONTINUE_FROM_CONFIRM' }
  | { type: 'BUSY' }
  | { type: 'ACTION_ERROR'; error: string }
  | { type: 'PUNCHED_IN'; log: AttendanceLog }
  | { type: 'REQUEST_END_WORK' }
  | { type: 'CANCEL_END_WORK' }
  | { type: 'CLOCKED_OUT'; log: AttendanceLog }
  | { type: 'RESET' };

const initialState: State = {
  stage: 'IDLE',
  employeeNumber: '',
  pin: '',
  employee: null,
  log: null,
  busy: false,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_EMPLOYEE_NUMBER':
      return { ...state, employeeNumber: action.value, error: null };
    case 'SET_PIN':
      return { ...state, pin: action.value, error: null };
    case 'VERIFY_START':
      return { ...state, busy: true, error: null };
    case 'VERIFY_ERROR':
      return { ...state, busy: false, error: action.error };
    case 'VERIFIED':
      return { ...state, stage: 'CONFIRMING', busy: false, employee: action.employee, log: action.log, error: null };
    case 'CONTINUE_FROM_CONFIRM': {
      if (!state.employee) return state;
      if (state.employee.today_status === 'completed') return { ...state, stage: 'ALREADY_COMPLETED' };
      if (state.employee.today_status === 'working') return { ...state, stage: 'ACTIVE_WORK' };
      return { ...state, stage: 'PUNCH_IN' };
    }
    case 'BUSY':
      return { ...state, busy: true, error: null };
    case 'ACTION_ERROR':
      return { ...state, busy: false, error: action.error };
    case 'PUNCHED_IN':
      return { ...state, stage: 'PUNCH_SUCCESS', busy: false, log: action.log, error: null };
    case 'REQUEST_END_WORK':
      return { ...state, stage: 'END_CONFIRM' };
    case 'CANCEL_END_WORK':
      return { ...state, stage: 'ACTIVE_WORK' };
    case 'CLOCKED_OUT':
      return { ...state, stage: 'END_SUCCESS', busy: false, log: action.log, error: null };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

function formatTime(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(date: Date) {
  return date.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function hoursLabel(hours: number | null | undefined) {
  if (hours === null || hours === undefined) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

const IDLE_TIMEOUT_MS = 30_000;
const SUCCESS_DISMISS_MS = 2_500;

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [now, setNow] = React.useState(new Date());
  const kioskId = useRef(getOrCreateKioskId());
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    initOfflineQueue();
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const toast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    window.toast?.(message, type);
  }, []);

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

  // Any state past IDLE auto-returns to IDLE after 30s of inactivity — the
  // kiosk is shared, so it must always be ready for the next employee rather
  // than sit on one person's screen.
  const bumpIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (state.stage === 'IDLE') return;
    idleTimer.current = setTimeout(reset, IDLE_TIMEOUT_MS);
  }, [state.stage, reset]);

  useEffect(() => {
    bumpIdleTimer();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [bumpIdleTimer]);

  useEffect(() => {
    const handler = () => bumpIdleTimer();
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, [bumpIdleTimer]);

  // Success screens auto-close after 2-3s regardless of the 30s idle timer.
  useEffect(() => {
    if (state.stage !== 'PUNCH_SUCCESS' && state.stage !== 'END_SUCCESS') return;
    const timer = setTimeout(reset, SUCCESS_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [state.stage, reset]);

  useEffect(() => {
    if (state.stage !== 'ALREADY_COMPLETED') return;
    const timer = setTimeout(reset, SUCCESS_DISMISS_MS + 1500);
    return () => clearTimeout(timer);
  }, [state.stage, reset]);

  const handleVerify = async () => {
    const employeeNumber = state.employeeNumber.trim();
    if (!employeeNumber || state.pin.length < 4) {
      dispatch({ type: 'VERIFY_ERROR', error: 'Enter your employee number and PIN' });
      return;
    }
    dispatch({ type: 'VERIFY_START' });
    try {
      const employee = await kioskVerify(employeeNumber, state.pin, kioskId.current);
      dispatch({ type: 'VERIFIED', employee, log: null });
    } catch (err) {
      dispatch({ type: 'VERIFY_ERROR', error: err instanceof Error ? err.message : 'Verification failed' });
    }
  };

  const handlePunchIn = async () => {
    if (!state.employee) return;
    dispatch({ type: 'BUSY' });
    try {
      const log = await kioskClockIn(state.employee.id, kioskId.current);
      dispatch({ type: 'PUNCHED_IN', log });
    } catch (err) {
      if (err instanceof QueuedOfflineError) {
        toast('Offline — clock-in queued, will sync automatically', 'info');
        dispatch({
          type: 'PUNCHED_IN',
          log: {
            id: err.localId,
            employee_id: state.employee.id,
            kiosk_id: kioskId.current,
            clock_in: new Date().toISOString(),
            clock_out: null,
            date: new Date().toISOString().slice(0, 10),
            hours_worked: null,
            status: 'working',
            auto_closed: false,
          },
        });
        return;
      }
      dispatch({ type: 'ACTION_ERROR', error: err instanceof Error ? err.message : 'Failed to clock in' });
      toast('Failed to clock in', 'error');
    }
  };

  const handleClockOut = async () => {
    if (!state.log) return;
    dispatch({ type: 'BUSY' });
    try {
      const log = await kioskClockOut(state.log.id);
      dispatch({ type: 'CLOCKED_OUT', log });
    } catch (err) {
      if (err instanceof QueuedOfflineError) {
        toast('Offline — clock-out queued, will sync automatically', 'info');
        dispatch({
          type: 'CLOCKED_OUT',
          log: { ...state.log, status: 'completed', clock_out: new Date().toISOString() },
        });
        return;
      }
      dispatch({ type: 'ACTION_ERROR', error: err instanceof Error ? err.message : 'Failed to clock out' });
      toast('Failed to clock out', 'error');
    }
  };

  const elapsed = state.log?.clock_in ? now.getTime() - new Date(state.log.clock_in).getTime() : 0;
  const elapsedH = Math.max(0, Math.floor(elapsed / 3600000)).toString().padStart(2, '0');
  const elapsedM = Math.max(0, Math.floor((elapsed % 3600000) / 60000)).toString().padStart(2, '0');
  const elapsedS = Math.max(0, Math.floor((elapsed % 60000) / 1000)).toString().padStart(2, '0');

  return (
    <div className="min-h-screen bg-[--color-background] flex flex-col">
      <header className="bg-card border-b border-[--color-border] px-6 py-4 shadow-l2-raised">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full overflow-hidden flex items-center justify-center shadow-l2-raised">
              <img src="/logo.jpg" alt="Oishii Nori" className="w-full h-full rounded-full object-cover" />
            </div>
            <div>
              <h1 className="font-corp-display text-lg">Employee Attendance</h1>
              <p className="text-xs text-muted-foreground">Oishii Nori</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-corp-mono font-bold tabular-nums">
              {now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </p>
            <p className="text-xs text-muted-foreground">{formatDate(now)}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full p-6">
        {state.stage === 'IDLE' && (
          <Card className="border-l-4 border-l-primary">
            <CardHeader>
              <CardTitle className="font-corp-display flex items-center gap-2">
                <Shield className="w-6 h-6 text-primary" />
                Employee Attendance
              </CardTitle>
              <p className="text-sm text-muted-foreground font-corp-body mt-1">Verify your Employee ID to begin</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                label="Employee Number"
                type="text"
                value={state.employeeNumber}
                onChange={(e) => dispatch({ type: 'SET_EMPLOYEE_NUMBER', value: e.target.value })}
                placeholder="Example: EMP-1001"
                className="font-corp-mono text-lg"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
              />
              <Input
                label="PIN"
                type="password"
                inputMode="numeric"
                value={state.pin}
                onChange={(e) => dispatch({ type: 'SET_PIN', value: e.target.value.replace(/\D/g, '').slice(0, 8) })}
                placeholder="••••"
                className="font-corp-mono text-lg tracking-[0.4em]"
                maxLength={8}
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
              />
              {state.error && <p className="text-sm text-destructive font-corp-body">{state.error}</p>}
              <Button
                variant="primary"
                size="xl"
                className="w-full"
                onClick={handleVerify}
                disabled={state.busy || !state.employeeNumber || state.pin.length < 4}
              >
                {state.busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
                <span className="font-corp-display text-lg">Continue</span>
              </Button>
            </CardContent>
          </Card>
        )}

        {state.stage === 'CONFIRMING' && state.employee && (
          <Card className="border-l-4 border-l-primary">
            <CardHeader>
              <CardTitle className="font-corp-display">Welcome, {state.employee.full_name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 gap-3 text-sm font-corp-body">
                <div className="flex justify-between border-b border-[--color-border] pb-2">
                  <span className="text-muted-foreground">Employee ID</span>
                  <span className="font-corp-mono">{state.employeeNumber}</span>
                </div>
                <div className="flex justify-between border-b border-[--color-border] pb-2">
                  <span className="text-muted-foreground">Position</span>
                  <span>{state.employee.position || 'Employee'}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Button variant="ghost" size="xl" onClick={reset}>
                  Cancel
                </Button>
                <Button variant="primary" size="xl" onClick={() => dispatch({ type: 'CONTINUE_FROM_CONFIRM' })}>
                  <span className="font-corp-display">Continue</span>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {state.stage === 'PUNCH_IN' && state.employee && (
          <Card className="border-l-4 border-l-primary">
            <CardHeader>
              <CardTitle className="font-corp-display">
                Good {now.getHours() < 12 ? 'Morning' : 'Afternoon'}, {state.employee.full_name}!
              </CardTitle>
              <p className="text-sm text-muted-foreground font-corp-body">Let's get started.</p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="text-center p-6 bg-muted/30 rounded-xl">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Current Time</p>
                <p className="text-3xl font-corp-mono font-bold tabular-nums text-primary">
                  {now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
                </p>
              </div>
              {state.error && <p className="text-sm text-destructive font-corp-body text-center">{state.error}</p>}
              <Button variant="primary" size="xl" className="w-full" onClick={handlePunchIn} disabled={state.busy}>
                {state.busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
                <span className="font-corp-display text-lg">Punch In</span>
              </Button>
            </CardContent>
          </Card>
        )}

        {state.stage === 'PUNCH_SUCCESS' && state.log && (
          <Card className="border-l-4" style={{ borderLeftColor: '#1E7A4C' }}>
            <CardContent className="p-8 text-center space-y-3">
              <CheckCircle className="w-16 h-16 mx-auto text-success" />
              <p className="text-xl font-corp-display font-bold">Punched In Successfully!</p>
              <p className="text-3xl font-corp-mono font-bold text-primary">{formatTime(state.log.clock_in)}</p>
              <p className="text-sm text-muted-foreground font-corp-body">Have a productive day!</p>
            </CardContent>
          </Card>
        )}

        {(state.stage === 'ACTIVE_WORK' || state.stage === 'END_CONFIRM') && state.employee && state.log && (
          <Card className="border-l-4" style={{ borderLeftColor: '#1E7A4C' }}>
            <CardHeader>
              <CardTitle className="font-corp-display flex items-center gap-2">
                <Clock className="w-6 h-6" style={{ color: '#1E7A4C' }} />
                {state.stage === 'END_CONFIRM' ? "End Today's Work?" : `Good day, ${state.employee.full_name}!`}
              </CardTitle>
              <p className="text-sm text-muted-foreground font-corp-body">
                {state.stage === 'END_CONFIRM' ? 'Please confirm to end your work session.' : 'You are currently clocked in.'}
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="p-3 bg-muted/30 rounded-lg">
                  <p className="text-xs text-muted-foreground font-corp-body">Time In</p>
                  <p className="font-corp-mono font-bold">{formatTime(state.log.clock_in)}</p>
                </div>
                <div className="p-3 bg-muted/30 rounded-lg">
                  <p className="text-xs text-muted-foreground font-corp-body">
                    {state.stage === 'END_CONFIRM' ? 'Time Out (now)' : 'Working For'}
                  </p>
                  <p className="font-corp-mono font-bold tabular-nums">
                    {state.stage === 'END_CONFIRM'
                      ? formatTime(now.toISOString())
                      : `${elapsedH}:${elapsedM}:${elapsedS}`}
                  </p>
                </div>
              </div>
              {state.error && <p className="text-sm text-destructive font-corp-body text-center">{state.error}</p>}
              {state.stage === 'ACTIVE_WORK' ? (
                <Button variant="outline" size="xl" className="w-full" onClick={() => dispatch({ type: 'REQUEST_END_WORK' })}>
                  End Today's Work
                </Button>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Button variant="ghost" size="xl" onClick={() => dispatch({ type: 'CANCEL_END_WORK' })}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="xl" onClick={handleClockOut} disabled={state.busy}>
                    {state.busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle className="w-5 h-5" />}
                    Confirm
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {state.stage === 'END_SUCCESS' && state.log && (
          <Card className="border-l-4" style={{ borderLeftColor: '#1E7A4C' }}>
            <CardContent className="p-8 text-center space-y-3">
              <CheckCircle className="w-16 h-16 mx-auto text-success" />
              <p className="text-xl font-corp-display font-bold">Today's Work Completed!</p>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Hours</p>
              <p className="text-3xl font-corp-mono font-bold text-primary">{hoursLabel(state.log.hours_worked)}</p>
              <p className="text-sm text-muted-foreground font-corp-body">Thank you! Have a great day!</p>
            </CardContent>
          </Card>
        )}

        {state.stage === 'ALREADY_COMPLETED' && state.employee && (
          <Card className="border-l-4 border-l-primary">
            <CardContent className="p-8 text-center space-y-3">
              <User className="w-16 h-16 mx-auto text-muted-foreground/40" />
              <p className="text-xl font-corp-display font-bold">You're all done for today, {state.employee.full_name}!</p>
              <p className="text-sm text-muted-foreground font-corp-body">See you on your next shift.</p>
              <Button variant="ghost" size="lg" onClick={reset}>
                <XCircle className="w-4 h-4 mr-2" />
                Done
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
