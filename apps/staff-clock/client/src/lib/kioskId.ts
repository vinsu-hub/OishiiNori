const STORAGE_KEY = 'staff-clock:kiosk-id';

export function getOrCreateKioskId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
