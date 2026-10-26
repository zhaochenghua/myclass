// Font family names reach the server from two very different sources:
// document XML parts (user-authored names) and fontconfig family strings that
// may list several localized aliases ("Microsoft YaHei,微软雅黑") and vertical
// variants ("@Noto Sans CJK SC"). Compare them after the same normalization or
// an installed font would still be reported as missing.
const WHITESPACE = /\s+/gu;
// Some documents (and a few CJK fonts) encode the weight in the family name:
// "思源黑体 CN Bold" refers to the Bold face of "思源黑体 CN". fontconfig lists
// the family and the style separately, so try the name without one trailing
// weight/style word before declaring the family missing.
const STYLE_SUFFIXES = [
  'regular', 'book', 'roman', 'bold', 'italic', 'oblique', 'light', 'semilight',
  'demilight', 'extralight', 'ultralight', 'medium', 'semibold', 'demibold',
  'black', 'heavy', 'thin', 'condensed', 'expanded', 'narrow'
];

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

// Lookup candidates, including the family name with trailing style words
// removed ("Foo Bold Italic" -> "Foo Bold" -> "Foo").
function familyLookupNames(value) {
  const names = new Set();
  const queue = [normalizeFontFamily(value)];
  while (queue.length) {
    const name = queue.shift();
    if (!name || names.has(name)) continue;
    names.add(name);
    for (const suffix of STYLE_SUFFIXES) {
      if (name.endsWith(` ${suffix}`) && name.length > suffix.length + 1) {
        queue.push(name.slice(0, -(suffix.length + 1)).trim());
      }
    }
  }
  return [...names];
}

function isFamilyInstalled(value, families) {
  if (!families) return false;
  return familyLookupNames(value).some(name => families.has(name));
}

// DrawingML/WordprocessingML store theme references such as "+mn-lt" instead of
// a real family name. They must never show up as a missing font.
function isFontReference(value) {
  const name = cleanFamily(value);
  return Boolean(name) && !name.startsWith('+') && name !== 'none';
}

module.exports = {
  normalizeFontFamily, fontFamilyAliases, familyLookupNames, isFamilyInstalled, isFontReference
};
