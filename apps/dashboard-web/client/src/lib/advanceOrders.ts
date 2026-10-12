/** POS advance times are entered in Philippine local time, even on a device
 * whose system timezone is different. The Philippines does not observe DST. */
export function phLocalToIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a date and time');
  const iso = `${value}:00+08:00`;
  if (Number.isNaN(Date.parse(iso))) throw new Error('Choose a valid date and time');
  return iso;
}

export function phInputTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function formatAdvanceTime(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(iso));
}

export function advanceWindow(now = new Date()): { from: string; before: string } {
  return {
    from: new Date(now.getTime() - 7 * 86400000).toISOString(),
    before: new Date(now.getTime() + 8 * 86400000).toISOString(),
  };
}
