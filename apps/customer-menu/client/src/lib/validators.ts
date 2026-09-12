// Philippine phone number check, shared by the delivery/pickup checkout
// and the reservation form. Deliberately permissive on landlines --
// exhaustively enumerating every real PH area code is out of scope, this
// just rejects obviously-wrong input (wrong prefix/length) rather than
// pretending to validate real area codes.
//
// Accepted shapes (after stripping everything but digits and a leading +):
//   Mobile local:         09XXXXXXXXX        (11 digits, starts 09)
//   Mobile international: +639XXXXXXXXX      (63 + 9XXXXXXXXX)
//   Landline:              0<area><local>    (0 + 7-9 more digits, 2nd digit != 9)
export function isValidPhilippinePhone(raw: string): boolean {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return false;

  // Normalize +63/63-prefixed input down to the local 0-prefixed form.
  let local = digits;
  if (hasPlus && digits.startsWith('63')) {
    local = `0${digits.slice(2)}`;
  } else if (!hasPlus && digits.startsWith('63') && digits.length === 12) {
    // Bare "63917..." with no +, still clearly an international mobile number.
    local = `0${digits.slice(2)}`;
  }

  if (!local.startsWith('0') || local.length < 2) return false;

  const secondDigit = local[1];
  if (secondDigit === '9') {
    // Mobile: 09 + 9 more digits = 11 total.
    return local.length === 11;
  }
  // Landline: 0 + area code + local number, 8-10 digits after the leading 0.
  return local.length >= 9 && local.length <= 11;
}

export const PH_PHONE_HINT = 'e.g. 0917 123 4567 or +63 917 123 4567';
