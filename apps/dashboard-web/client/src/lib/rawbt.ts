/** Hands raw ESC/POS bytes to the RawBT Android app, which owns the
 * Bluetooth connection to the printer. A browser can't open a Bluetooth
 * Classic (SPP) socket itself, so this is the only way an Android tablet's
 * Chrome can print to the XP-58H without a print dialog.
 *
 * Chrome only launches an intent: URL from a user gesture, so call this
 * synchronously inside a click handler -- never after an await. */

const RAWBT_PACKAGE = 'ru.a402d.rawbtprinter';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function rawbtIntentUrl(bytes: Uint8Array): string {
  return `intent:base64,${toBase64(bytes)}#Intent;scheme=rawbt;package=${RAWBT_PACKAGE};end;`;
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

export function sendToRawBT(bytes: Uint8Array): void {
  if (!isAndroid()) throw new Error('RawBT printing only works on an Android tablet with the RawBT app installed.');
  window.location.href = rawbtIntentUrl(bytes);
}
