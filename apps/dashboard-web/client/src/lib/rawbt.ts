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
  if (typeof navigator === 'undefined') return false;
  if (/Android/i.test(navigator.userAgent)) return true;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  if (uaData?.platform && /Android/i.test(uaData.platform)) return true;
  // Chrome on Android tablets defaults to "Desktop site", which reports a
  // Linux desktop ("X11; Linux x86_64") instead of Android. A Linux browser
  // with a touchscreen is, in practice, that tablet.
  return /Linux/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
}

export function sendToRawBT(bytes: Uint8Array): void {
  if (!isAndroid()) {
    throw new Error(
      'RawBT printing needs the Android tablet. If you are on the tablet, open Chrome\'s ⋮ menu and untick "Desktop site", then try again.'
    );
  }
  window.location.href = rawbtIntentUrl(bytes);
}

/* ---------------------------------------------------------------------------
 * Hands-free printing via the "Server for RawBT" companion app.
 *
 * An intent: URL only opens RawBT from a tap, so it can't print an order the
 * moment it arrives. The Server for RawBT app (Play Store: rawbt.server)
 * listens on ws://127.0.0.1:40213 on the tablet itself and prints whatever
 * ESC/POS bytes it's sent -- no tap, no app switch. Chrome allows a secure
 * page to reach the device's own loopback address (it may ask once to allow
 * access to devices on the local network).
 * ------------------------------------------------------------------------- */
const RAWBT_WS_URL = 'ws://127.0.0.1:40213/';

/** Sends bytes to Server for RawBT. Rejects if the server isn't running. */
export function sendToRawBTServer(bytes: Uint8Array, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(RAWBT_WS_URL);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('Could not reach Server for RawBT'));
      return;
    }
    socket.binaryType = 'arraybuffer';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* ignore */ }
      finish(new Error('Server for RawBT did not answer'));
    }, timeoutMs);
    socket.onerror = () => finish(new Error('Server for RawBT is not running on this tablet'));
    socket.onopen = () => {
      socket.send(bytes);
      // Give the server a moment to take the bytes before closing.
      setTimeout(() => {
        try { socket.close(1000, 'done'); } catch { /* ignore */ }
        finish();
      }, 300);
    };
  });
}

/** True if Server for RawBT is reachable (opens and immediately closes). */
export function rawbtServerAvailable(timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(RAWBT_WS_URL);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } resolve(false); }, timeoutMs);
    socket.onopen = () => { clearTimeout(timer); socket.close(1000, 'probe'); resolve(true); };
    socket.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}
