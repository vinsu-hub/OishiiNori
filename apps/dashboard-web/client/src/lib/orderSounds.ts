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

function playBeep(frequency: number, startAt: number, durationMs = 150) {
  const audioCtx = getContext();
  if (!audioCtx) return;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime + startAt);
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
