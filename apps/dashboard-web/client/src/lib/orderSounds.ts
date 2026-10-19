// Synthesized notification tones via the Web Audio API -- deliberately not
// SMFC's approach (bundled .wav asset files under client/public/sounds/),
// to avoid adding binary assets/licensing concerns for two short beeps.

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    return ctx;
  } catch {
    return null;
  }
}

function playBeep(frequency: number, startAt: number, durationMs = 150, volume = 0.15, type: OscillatorType = 'sine') {
  const audioCtx = getContext();
  if (!audioCtx) return;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audioCtx.currentTime + startAt);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + startAt + durationMs / 1000);
  oscillator.connect(gain);
  gain.connect(audioCtx.destination);
  oscillator.start(audioCtx.currentTime + startAt);
  oscillator.stop(audioCtx.currentTime + startAt + durationMs / 1000);
}

// New order on Kitchen Display: two quick low beeps.
export function playNewOrderBeep() {
  try {
    playBeep(440, 0);
    playBeep(440, 0.2);
  } catch {
    // Audio failures (no user gesture yet, unsupported browser, etc.) are
    // silently swallowed -- a missed chime isn't worth surfacing an error.
  }
}

// Order ready on Order Queue: one higher beep, distinguishable by ear.
export function playOrderReadyBeep() {
  try {
    playBeep(880, 0, 200);
  } catch {
    // See playNewOrderBeep.
  }
}

// Ticket crossed the 15-min overdue threshold on Kitchen Display: a lower,
// more urgent triple beep so it reads distinctly from the new-order chime.
export function playOverdueBeep() {
  try {
    playBeep(320, 0, 180);
    playBeep(320, 0.22, 180);
    playBeep(320, 0.44, 180);
  } catch {
    // See playNewOrderBeep.
  }
}

// New QR table order waiting for the cashier: a rising two-note chime, so it
// reads differently from the kitchen's new-order beep at the same counter.
export function playTableOrderBeep() {
  try {
    playBeep(660, 0, 160);
    playBeep(990, 0.18, 220);
  } catch {
    // See playNewOrderBeep.
  }
}

// Rider: a delivery is ready for pickup. A loud square-wave "beep-beep"
// (like a motorbike horn) three times -- meant to be heard from a pocket.
export function playRiderReadyAlert() {
  try {
    for (const offset of [0, 0.75, 1.5]) {
      playBeep(740, offset, 180, 0.35, 'square');
      playBeep(740, offset + 0.25, 260, 0.35, 'square');
    }
  } catch {
    // Browsers may require a user gesture before allowing audio.
  }
}

/** Phones keep audio locked until the user taps; call this from a tap. */
export function unlockAudio() {
  try {
    const audioCtx = getContext();
    void audioCtx?.resume();
  } catch {
    // Nothing to unlock.
  }
}

// Online Orders page's speaker toggle; per-device, so each till chooses.
const ONLINE_MUTE_KEY = 'online-order-sound-muted';

export function isOnlineOrderSoundMuted(): boolean {
  try {
    return localStorage.getItem(ONLINE_MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setOnlineOrderSoundMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(ONLINE_MUTE_KEY, '1');
    else localStorage.removeItem(ONLINE_MUTE_KEY);
  } catch {
    // Storage blocked: the toggle just won't survive a reload.
  }
}

// Website pickup or delivery order: a louder "ding-dong" doorbell, rung
// twice, so it can't be mistaken for the kitchen, table or ready beeps.
export function playOnlineOrderBeep(force = false) {
  if (!force && isOnlineOrderSoundMuted()) return;
  try {
    for (const offset of [0, 1.1]) {
      playBeep(988, offset, 450, 0.3, 'triangle');
      playBeep(784, offset + 0.42, 650, 0.3, 'triangle');
    }
  } catch {
    // Browsers may require a user gesture before allowing audio.
  }
}
