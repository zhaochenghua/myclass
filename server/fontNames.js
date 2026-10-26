// Font family names reach the server from two very different sources:
// document XML parts (user-authored names) and fontconfig family strings that
// may list several localized aliases ("Microsoft YaHei,微软雅黑") and vertical
// variants ("@Noto Sans CJK SC"). Compare them after the same normalization or
// an installed font would still be reported as missing.
const WHITESPACE = /\s+/gu;

function cleanFamily(value) {
  return String(value ?? '')
    .replace(/^@+/u, '')
    .normalize('NFKC')
    .replace(WHITESPACE, ' ')
    .trim();
}

function normalizeFontFamily(value) {
  return cleanFamily(value).toLowerCase();
}

// fontconfig joins every family/alias of a face with commas.
function fontFamilyAliases(value) {
  return String(value ?? '')
    .split(',')
    .map(cleanFamily)
    .filter(Boolean);
}

// DrawingML/WordprocessingML store theme references such as "+mn-lt" instead of
// a real family name. They must never show up as a missing font.
function isFontReference(value) {
  const name = cleanFamily(value);
  return Boolean(name) && !name.startsWith('+') && name !== 'none';
}

module.exports = { normalizeFontFamily, fontFamilyAliases, isFontReference };
