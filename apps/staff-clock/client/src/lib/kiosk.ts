import { enqueue, isNetworkError, registerExecutor } from './offlineQueue';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

// Oishii Nori's kiosk.py has no branch concept and no break endpoints
// (locked single-location scope, and break handling was never built into
// hr.py/kiosk.py) -- unlike the SMFC reference this is ported from, so
// today_status here has no 'on_break' state.
export type TodayStatus = 'not_started' | 'working' | 'completed';

export interface KioskVerifyResult {
  id: string;
  full_name: string | null;
  photo_url: string | null;
  position: string | null;
  department: 'kitchen' | 'cafe' | null;
  today_status: TodayStatus;
  attendance_log_id: string | null;
  log: AttendanceLog | null;
}

export interface AttendanceLog {
  id: string;
  employee_id: string;
  kiosk_id: string | null;
  clock_in: string;
  clock_out: string | null;
  date: string;
  hours_worked: number | null;
  status: 'working' | 'completed';
  auto_closed: boolean;
}

export class QueuedOfflineError extends Error {
  constructor(public localId: string) {
    super('Queued — will sync when back online');
    this.name = 'QueuedOfflineError';
  }
}

async function request<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    throw new Error(errBody?.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

registerExecutor('clock-in', (payload) => request('/kiosk/clock-in', payload));
registerExecutor('clock-out', (payload) => request('/kiosk/clock-out', payload));

// Verify is never queued offline — a PIN can't be authenticated without a
// live round trip, so a network failure here just surfaces as a normal error.
export function kioskVerify(employeeNumber: string, pin: string, kioskId: string): Promise<KioskVerifyResult> {
  return request('/kiosk/verify', { employee_number: employeeNumber, pin, kiosk_id: kioskId });
}

export async function kioskClockIn(employeeId: string, kioskId: string): Promise<AttendanceLog> {
  const payload = { employee_id: employeeId, kiosk_id: kioskId };
  try {
    return await request<AttendanceLog>('/kiosk/clock-in', payload);
  } catch (err) {
    if (isNetworkError(err)) {
      const localId = crypto.randomUUID();
      enqueue('clock-in', { ...payload, localId });
      throw new QueuedOfflineError(localId);
    }
    throw err;
  }
}

export async function kioskClockOut(attendanceLogId: string): Promise<AttendanceLog> {
  const payload = { attendance_log_id: attendanceLogId };
  try {
    return await request<AttendanceLog>('/kiosk/clock-out', payload);
  } catch (err) {
    if (isNetworkError(err)) {
      enqueue('clock-out', payload);
      throw new QueuedOfflineError(attendanceLogId);
    }
    throw err;
  }
}
