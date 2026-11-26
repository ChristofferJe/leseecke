// The languages the books are written in. Each book in books/library.json names its language
// ("language": "fr"); a book without one is German. Shared by the app and tools/check.mjs.
//
// A language that is not listed here still works with sensible defaults (its name comes from
// the browser, its shared glossary is books/glossary-<code>.txt), but listing it gives better
// voice matching and a test sentence.

export const DEFAULT_LANGUAGE = 'de';

export const LANGUAGES = {
  de: {
    name: 'German',
    native: 'Deutsch',
    speech: 'de-DE',
    // German came first, so its shared glossary keeps the original file name.
    glossary: 'books/glossary.txt',
    // Phones report German as "de-DE", "de_DE" or "deu-DEU"; some only say so in the voice name.
    voiceCodes: ['de', 'deu', 'ger'],
    voiceNames: /german|deutsch/i,
    voiceSetting: 'Deutsch (Deutschland)',
    test: 'Guten Tag! Ich lese gern Märchen auf Deutsch.',
    hello: 'Hallo! So klinge ich.',
    example: 'Add Kafka’s Die Verwandlung at A2.',
  },
  fr: {
    name: 'French',
    native: 'Français',
    speech: 'fr-FR',
    glossary: 'books/glossary-fr.txt',
    voiceCodes: ['fr', 'fra', 'fre'],
    voiceNames: /french|fran[cç]ais/i,
    voiceSetting: 'Français (France)',
    test: 'Bonjour ! J’aime lire des histoires en français.',
    hello: 'Bonjour ! Voici ma voix.',
    example: 'Add Maupassant’s Le Horla at A2.',
  },
};

const displayName = (code, inLang) => {
  try {
    return new Intl.DisplayNames([inLang], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

// Everything the app needs to know about one language, with defaults for unlisted ones.
export function language(code = DEFAULT_LANGUAGE) {
  const name = displayName(code, 'en');
  const native = displayName(code, code);
  return {
    code,
    name,
    native: native.charAt(0).toUpperCase() + native.slice(1),
    speech: code,
    glossary: `books/glossary-${code}.txt`,
    voiceCodes: [code],
    voiceNames: null,
    voiceSetting: native,
    test: '',
    hello: '',
    example: `Add a short public-domain story in ${name} at A2.`,
    ...LANGUAGES[code],
  };
}

export const langOf = (work) => work?.language || DEFAULT_LANGUAGE;

// Known languages first, in the order above, then any others alphabetically.
export function sortLanguages(codes) {
  const known = Object.keys(LANGUAGES);
  const rank = (c) => (known.includes(c) ? known.indexOf(c) : known.length);
  return [...codes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
