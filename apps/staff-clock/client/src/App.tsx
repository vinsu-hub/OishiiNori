import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Delete,
  KeyRound,
  LogIn,
  LogOut,
  RotateCcw,
  ShieldCheck,
  UserRound,
  WifiOff,
} from 'lucide-react';
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
  | { type: 'DEMO_STATE'; stage: Stage; employee: KioskVerifyResult; log: AttendanceLog | null }
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
    case 'CONTINUE_FROM_CONFIRM':
      if (!state.employee) return state;
      if (state.employee.today_status === 'completed') return { ...state, stage: 'ALREADY_COMPLETED' };
      if (state.employee.today_status === 'working') return { ...state, stage: 'ACTIVE_WORK' };
      return { ...state, stage: 'PUNCH_IN' };
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
    case 'DEMO_STATE':
      return {
        ...state,
        stage: action.stage,
        employee: action.employee,
        log: action.log,
        employeeNumber: 'EMP-30F5',
        pin: '1234',
      };
    case 'RESET':
      return initialState;
  }
}
const phTime = (date: Date | string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date(date));
const shortTime = (date: Date | string | null | undefined) =>
  date
    ? new Intl.DateTimeFormat('en-PH', {
        timeZone: 'Asia/Manila',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(date))
    : '—';
const phDate = (date: Date) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
const hoursLabel = (hours: number | null | undefined) =>
  hours == null ? '—' : `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;

function Stepper({ stage }: { stage: Stage }) {
  const step = stage === 'IDLE' ? 1 : stage === 'CONFIRMING' ? 2 : 3;
  return (
    <div className="kiosk-steps" aria-label={`Step ${step} of 3`}>
      {['Verify', 'Review', 'Record time'].map((label, index) => (
        <React.Fragment key={label}>
          {index > 0 && <span className={step > index ? 'step-line done' : 'step-line'} />}
          <span className={step >= index + 1 ? 'step active' : 'step'}>
            <b>{index + 1}</b>
            <i>{label}</i>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
function NumericKeypad({
  pin,
  onChange,
  disabled,
}: {
  pin: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const push = (key: string) =>
    onChange(key === 'back' ? pin.slice(0, -1) : key === 'clear' ? '' : `${pin}${key}`.slice(0, 8));
  return (
    <section className="keypad" aria-label="PIN keypad">
      <div className="pin-dots" aria-label={`${pin.length} of 4 PIN digits entered`} aria-live="polite">
        {[0, 1, 2, 3].map((n) => (
          <span key={n} className={pin.length > n ? 'filled' : ''} />
        ))}
      </div>
      <div className="key-grid">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button key={n} type="button" disabled={disabled} onClick={() => push(String(n))}>
            {n}
          </button>
        ))}
        <button type="button" className="key-clear" disabled={disabled} onClick={() => push('clear')}>
          Clear
        </button>
        <button type="button" disabled={disabled} onClick={() => push('0')}>
          0
        </button>
        <button
          type="button"
          className="key-icon"
          disabled={disabled}
          onClick={() => push('back')}
          aria-label="Delete last PIN digit"
        >
          <Delete size={22} />
        </button>
      </div>
    </section>
  );
}
function Success({ title, detail, message }: { title: string; detail: string; message: string }) {
  return (
    <section className="kiosk-panel success-panel">
      <span className="success-mark">
        <CheckCircle2 />
      </span>
      <p className="eyebrow">TIME RECORDED</p>
      <h1>{title}</h1>
      <strong>{detail}</strong>
      <p className="panel-copy">{message}</p>
    </section>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [now, setNow] = React.useState(new Date());
  const kioskId = useRef(getOrCreateKioskId());
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);
  const bumpIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (state.stage !== 'IDLE') idleTimer.current = setTimeout(reset, 30_000);
  }, [state.stage, reset]);
  useEffect(() => {
    initOfflineQueue();
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
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
  useEffect(() => {
    if (state.stage !== 'PUNCH_SUCCESS' && state.stage !== 'END_SUCCESS') return;
    const timer = setTimeout(reset, 2_500);
    return () => clearTimeout(timer);
  }, [state.stage, reset]);
  useEffect(() => {
    if (state.stage !== 'ALREADY_COMPLETED') return;
    const timer = setTimeout(reset, 4_000);
    return () => clearTimeout(timer);
  }, [state.stage, reset]);
  // Development-only screenshot states; this condition is false in a production Vite build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const demo = new URLSearchParams(window.location.search).get('demo');
    if (!demo) return;
    const employee = {
      id: 'demo-employee',
      full_name: 'Mika Santos',
      position: 'Service Crew',
      today_status:
        demo === 'completed' ? 'completed' : demo === 'working' || demo === 'end' ? 'working' : 'not_started',
      log: null,
    } as KioskVerifyResult;
    const log = {
      id: 'demo-log',
      employee_id: employee.id,
      kiosk_id: 'demo',
      clock_in: new Date(Date.now() - 4_920_000).toISOString(),
      clock_out: null,
      date: new Date().toISOString().slice(0, 10),
      hours_worked: demo === 'out-success' ? 1.37 : null,
      status: demo === 'out-success' ? 'completed' : 'working',
      auto_closed: false,
    } as AttendanceLog;
    const stage: Stage =
      demo === 'ready'
        ? 'PUNCH_IN'
        : demo === 'working'
          ? 'ACTIVE_WORK'
          : demo === 'end'
            ? 'END_CONFIRM'
            : demo === 'in-success'
              ? 'PUNCH_SUCCESS'
              : demo === 'out-success'
                ? 'END_SUCCESS'
                : demo === 'completed'
                  ? 'ALREADY_COMPLETED'
                  : 'IDLE';
    if (demo === 'error')
      dispatch({
        type: 'VERIFY_ERROR',
        error: 'We couldn’t verify that Employee ID and PIN. Please check them and try again.',
      });
    else
      dispatch({
        type: 'DEMO_STATE',
        stage,
        employee,
        log: stage === 'PUNCH_IN' || stage === 'ALREADY_COMPLETED' ? null : log,
      });
  }, []);
  const toast = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => window.toast?.(message, type),
    [],
  );
  const handleVerify = async () => {
    const employeeNumber = state.employeeNumber.trim();
    if (!employeeNumber || state.pin.length < 4) {
      dispatch({ type: 'VERIFY_ERROR', error: 'Enter your employee number and 4-digit PIN to continue.' });
      return;
    }
    dispatch({ type: 'VERIFY_START' });
    try {
      const employee = await kioskVerify(employeeNumber, state.pin, kioskId.current);
      dispatch({ type: 'VERIFIED', employee, log: employee.log });
    } catch (err) {
      dispatch({ type: 'VERIFY_ERROR', error: err instanceof Error ? err.message : 'Verification failed' });
    }
  };
  const handlePunchIn = async () => {
    if (!state.employee) return;
    dispatch({ type: 'BUSY' });
    try {
      dispatch({ type: 'PUNCHED_IN', log: await kioskClockIn(state.employee.id, kioskId.current) });
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
      dispatch({ type: 'CLOCKED_OUT', log: await kioskClockOut(state.log.id) });
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
  const elapsed = state.log?.clock_in ? Math.max(0, now.getTime() - new Date(state.log.clock_in).getTime()) : 0;
  const elapsedLabel = `${String(Math.floor(elapsed / 3_600_000)).padStart(2, '0')}:${String(Math.floor(elapsed / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(elapsed / 1_000) % 60).padStart(2, '0')}`;
  const greeting =
    Number(
      new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', hourCycle: 'h23' }).format(now),
    ) < 12
      ? 'Good morning'
      : 'Good afternoon';
  const employeeName = (state.employee?.full_name ?? '').split(' ')[0];
  return (
    <div className="kiosk-shell">
      <header className="kiosk-header">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}logo.jpg`} alt="Oishii Nori" />
          <span>
            <b>Oishii Nori</b>
            <small>Staff Clock</small>
          </span>
        </div>
        <div className="hero-clock" aria-live="polite">
          <time>{phTime(now)}</time>
          <span>{phDate(now)} · Philippines</span>
        </div>
      </header>
      <main className="kiosk-main">
        <section className="kiosk-intro">
          <p>EMPLOYEE ATTENDANCE</p>
          <Stepper stage={state.stage} />
        </section>
        {state.stage === 'IDLE' && (
          <section className="kiosk-panel verify-panel">
            <div className="panel-heading">
              <span className="icon-disc">
                <ShieldCheck />
              </span>
              <div>
                <h1>Clock in or out</h1>
                <p>Enter your details to begin your shift.</p>
              </div>
            </div>
            <div className="verify-grid">
              <div className="id-field">
                <Input
                  label="Employee ID"
                  value={state.employeeNumber}
                  onChange={(e) => dispatch({ type: 'SET_EMPLOYEE_NUMBER', value: e.target.value.toUpperCase() })}
                  placeholder="EMP-30F5"
                  autoCapitalize="characters"
                  autoFocus
                  className="kiosk-input font-corp-mono"
                  onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                />
                <p className="field-help">Your Employee ID is on your staff record.</p>
              </div>
              <div>
                <label className="pin-label">
                  <KeyRound size={17} /> 4-digit PIN
                </label>
                <input
                  className="sr-only"
                  aria-label="4-digit PIN"
                  value={state.pin}
                  inputMode="none"
                  onChange={(e) => dispatch({ type: 'SET_PIN', value: e.target.value.replace(/\D/g, '').slice(0, 8) })}
                  onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                />
                <NumericKeypad
                  pin={state.pin}
                  onChange={(value) => dispatch({ type: 'SET_PIN', value })}
                  disabled={state.busy}
                />
              </div>
            </div>
            {state.error && (
              <p className="inline-alert" role="alert">
                <WifiOff size={18} />
                {state.error}
              </p>
            )}
            <Button
              variant="primary"
              size="xl"
              className="primary-action"
              onClick={handleVerify}
              disabled={state.busy || !state.employeeNumber || state.pin.length < 4}
            >
              {state.busy ? (
                'Checking your details…'
              ) : (
                <>
                  Continue <LogIn size={22} />
                </>
              )}
            </Button>
          </section>
        )}
        {state.stage === 'CONFIRMING' && state.employee && (
          <section className="kiosk-panel decision-panel">
            <span className="icon-disc">
              <UserRound />
            </span>
            <p className="eyebrow">IDENTITY VERIFIED</p>
            <h1>Welcome, {employeeName}.</h1>
            <p className="panel-copy">Please make sure this is your profile before continuing.</p>
            <dl className="identity-list">
              <div>
                <dt>Employee ID</dt>
                <dd>{state.employeeNumber}</dd>
              </div>
              <div>
                <dt>Position</dt>
                <dd>{state.employee.position || 'Employee'}</dd>
              </div>
            </dl>
            <div className="button-row">
              <Button variant="ghost" size="xl" onClick={reset}>
                Not me
              </Button>
              <Button variant="primary" size="xl" onClick={() => dispatch({ type: 'CONTINUE_FROM_CONFIRM' })}>
                Yes, continue <Check size={21} />
              </Button>
            </div>
          </section>
        )}
        {state.stage === 'PUNCH_IN' && state.employee && (
          <section className="kiosk-panel decision-panel">
            <p className="eyebrow">READY TO START</p>
            <h1>
              {greeting}, {employeeName}.
            </h1>
            <p className="panel-copy">
              You’re clocking in as <b>{state.employee.position || 'Employee'}</b>.
            </p>
            <div className="time-callout">
              <span>YOUR TIME IN</span>
              <strong>{shortTime(now)}</strong>
              <small>{phDate(now)}</small>
            </div>
            {state.error && (
              <p className="inline-alert" role="alert">
                {state.error}
              </p>
            )}
            <Button
              variant="primary"
              size="xl"
              className="primary-action"
              onClick={handlePunchIn}
              disabled={state.busy}
            >
              {state.busy ? (
                'Punching in…'
              ) : (
                <>
                  Punch in now <LogIn size={22} />
                </>
              )}
            </Button>
            <button className="text-action" onClick={reset}>
              Cancel
            </button>
          </section>
        )}
        {state.stage === 'PUNCH_SUCCESS' && state.log && (
          <Success
            title="You’re clocked in!"
            detail={`Time in: ${shortTime(state.log.clock_in)}`}
            message="Have a smooth shift. This screen will reset shortly."
          />
        )}
        {state.stage === 'ACTIVE_WORK' && state.employee && state.log && (
          <section className="kiosk-panel work-panel">
            <p className="eyebrow">
              <span className="live-dot" />
              WORKING NOW
            </p>
            <h1>Have a good shift, {employeeName}.</h1>
            <div className="elapsed">
              <span>TIME AT WORK</span>
              <strong>{elapsedLabel}</strong>
              <small>Started at {shortTime(state.log.clock_in)}</small>
            </div>
            <div className="work-details">
              <span>
                <b>Time in</b>
                {shortTime(state.log.clock_in)}
              </span>
              <span>
                <b>Today</b>
                {phDate(now)}
              </span>
            </div>
            {state.error && (
              <p className="inline-alert" role="alert">
                {state.error}
              </p>
            )}
            <Button
              variant="outline"
              size="xl"
              className="end-action"
              onClick={() => dispatch({ type: 'REQUEST_END_WORK' })}
            >
              End today’s work <LogOut size={22} />
            </Button>
          </section>
        )}
        {state.stage === 'END_CONFIRM' && state.employee && state.log && (
          <section className="kiosk-panel decision-panel end-panel">
            <p className="eyebrow">END SHIFT</p>
            <h1>Ready to clock out?</h1>
            <p className="panel-copy">Please review today’s time before confirming.</p>
            <div className="end-summary">
              <span>
                <b>Time in</b>
                {shortTime(state.log.clock_in)}
              </span>
              <span>
                <b>Time out</b>
                {shortTime(now)}
              </span>
              <strong>
                {elapsedLabel}
                <small>worked so far</small>
              </strong>
            </div>
            <div className="button-row">
              <Button variant="ghost" size="xl" onClick={() => dispatch({ type: 'CANCEL_END_WORK' })}>
                <ArrowLeft size={21} /> Keep working
              </Button>
              <Button variant="primary" size="xl" onClick={handleClockOut} disabled={state.busy}>
                {state.busy ? (
                  'Ending shift…'
                ) : (
                  <>
                    Confirm <Check size={21} />
                  </>
                )}
              </Button>
            </div>
          </section>
        )}
        {state.stage === 'END_SUCCESS' && state.log && (
          <Success
            title="Today’s work is complete."
            detail={`Total time: ${hoursLabel(state.log.hours_worked)}`}
            message="Thank you for your work. Take care on the way home."
          />
        )}
        {state.stage === 'ALREADY_COMPLETED' && state.employee && (
          <section className="kiosk-panel decision-panel">
            <span className="icon-disc muted">
              <Clock3 />
            </span>
            <p className="eyebrow">ALL SET FOR TODAY</p>
            <h1>You’ve already clocked out.</h1>
            <p className="panel-copy">Thanks, {employeeName}. We’ll return to the start screen shortly.</p>
            <Button variant="ghost" size="lg" onClick={reset}>
              <RotateCcw size={18} /> Start over
            </Button>
          </section>
        )}
      </main>
      <footer className="kiosk-footer">
        <span>Shared staff kiosk</span>
        <span>For assistance, please ask a manager.</span>
      </footer>
    </div>
  );
}
