/** Minimal ESC/POS byte builder for the 58mm XP-58H, used to hand raw bytes
 * to the RawBT Android app (see rawbt.ts). Text helpers are ports of
 * kitchen-print-bridge/ticket.py's _ascii_safe/_wrap_line so the browser
 * path can't regress the bugs already fixed there (en dashes printing as a
 * mangled byte, long lines overrunning the paper width). */

export const PAPER_WIDTH_CHARS = 32;

// The printer's default codepage (CP437) can't represent these -- map the
// common offenders to plain ASCII before anything else.
const ASCII_REPLACEMENTS: Record<string, string> = {
  '–': '-', // en dash
  '—': '--', // em dash
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '₱': 'P', // peso sign
};

export function asciiSafe(text: string): string {
  let out = text;
  for (const [char, replacement] of Object.entries(ASCII_REPLACEMENTS)) out = out.split(char).join(replacement);
  // NFKD + strip combining marks takes accented letters to their ASCII base;
  // anything still non-ASCII becomes "?" (same as Python's "replace").
  return out
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7f]/g, '?');
}

/** Wraps `text` after `prefix`, indenting continuation lines to the prefix
 * width. Same algorithm as ticket.py's _wrap_line. */
export function wrapLine(prefix: string, text: string, width: number): string[] {
  const full = `${prefix}${text}`;
  if (full.length <= width) return [full];
  const lines: string[] = [];
  const indent = ' '.repeat(prefix.length);
  let current = prefix;
  for (const word of text.split(' ')) {
    const candidate = current !== prefix ? `${current}${word} ` : `${prefix}${word} `;
    if (candidate.length > width && current !== prefix) {
      lines.push(current.trimEnd());
      current = `${indent}${word} `;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines;
}

/** Python's str.center(), including its odd-padding rule, so ticket text
 * matches kitchen-print-bridge's output line for line. */
export function center(text: string, width: number): string {
  const marg = width - text.length;
  if (marg <= 0) return text;
  const left = Math.floor(marg / 2) + (marg & width & 1);
  return ' '.repeat(left) + text + ' '.repeat(marg - left);
}

/** Left text and right text, right text flush to the edge. A long left side
 * wraps at full width; the right text goes on its last line if it fits
 * there, otherwise on a line of its own. */
export function columns(left: string, right: string, width: number): string[] {
  const wrapped = wrapLine('', left, width);
  const last = wrapped[wrapped.length - 1] ?? '';
  if (last.length + 1 + right.length <= width) {
    wrapped[wrapped.length - 1] = last + ' '.repeat(width - last.length - right.length) + right;
    return wrapped;
  }
  return [...wrapped, right.padStart(width)];
}

const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private bytes: number[] = [ESC, 0x40]; // ESC @ -- reset

  align(a: 'left' | 'center' | 'right'): this {
    this.bytes.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
    return this;
  }

  bold(on: boolean): this {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /** Character size: normal, double height, or double width+height. */
  size(s: 'normal' | 'tall' | 'large'): this {
    this.bytes.push(GS, 0x21, s === 'normal' ? 0x00 : s === 'tall' ? 0x01 : 0x11);
    return this;
  }

  text(t: string): this {
    for (const ch of asciiSafe(t)) this.bytes.push(ch.charCodeAt(0));
    return this;
  }

  line(t = ''): this {
    return this.text(`${t}\n`);
  }

  feed(n: number): this {
    for (let i = 0; i < n; i++) this.bytes.push(0x0a);
    return this;
  }

  /** Feeds past the tear bar, then a partial cut (ignored by cutter-less units). */
  cut(): this {
    this.feed(4);
    this.bytes.push(GS, 0x56, 0x01);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
