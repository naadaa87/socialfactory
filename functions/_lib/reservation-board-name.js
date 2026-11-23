export function displayName(value) {
  let name = String(value || '').normalize('NFC').trim();
  if (/[,，]/u.test(name)) {
    if (name.length > 200) return '예약 고객';
    const names = name.split(/[,，]/u).map(part => part.trim());
    // A booking may name several organizations. Validate each name with the
    // existing rules, then mask only the first one (including short names).
    if (names.some(part => displayName(part) === '예약 고객'))
      return '예약 고객';
    name = names[0];
  }
  // Calendar names can already have hidden suffixes. Preserve the supplied mask:
  // applying a middle mask as well would hide both the middle and final character.
  // Unsupported titles, phone-only values, URLs and internal notes use a neutral label.
  const plain = /^[\p{L}\p{N} ]{1,40}$/u.test(name);
  const alreadyMasked = /^[\p{L}\p{N}]{1,4}[*○●]{1,4}$/u.test(name);
  if ((plain || alreadyMasked) && /\p{L}/u.test(name)) {
    const chars = [...name.replace(/ /g, '').replace(/[*●]/g, '○')];
    if (alreadyMasked && chars.length < 5) return chars.join('');
    if (chars.length === 1) return '○';
    if (chars.length === 2) return chars[0] + '○';
    if (chars.length === 3) return chars[0] + '○' + chars[2];
    if (chars.length === 4) return chars[0] + '○○' + chars[3];
    // Five or more characters use the first three plus two masks, at most five total.
    return chars.slice(0, 3).join('') + '○○';
  }
  return '예약 고객';
}

export function validBoardName(value) {
  return typeof value === 'string' && (value === '예약 고객' ||
    [...value].length <= 5 && /^[\p{L}\p{N}○]+$/u.test(value) && value.includes('○'));
}

// This is the authenticated reservation's name field, not an arbitrary calendar title.
export function reservationBoardName(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const name = value.normalize('NFC').trim().replace(/\s*[（(][^（）()]*[）)]$/u, '').trim();
  const masked = displayName(name);
  return masked === '예약 고객' ? null : masked;
}
