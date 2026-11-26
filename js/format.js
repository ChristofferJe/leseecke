// Parser for the book text format. Used by the app (browser) and by tools/check.mjs (Node).
// The format is described in CLAUDE.md. Books can be in German ("de") or French ("fr").
//
// Chapter file:                     Glossary file (one entry per word form):
//   # Title                           ging | gehen | to go | Präteritum
//   = English title                   Mädchen | das Mädchen | girl
//                                     und | | and          (empty lemma = same as form)
//   Sentence line in the book's language
//   = English translation
//   (blank line = new paragraph)
//
// Inline annotations override the glossary for one word: word[lemma|english|note|#group]
// Words sharing a #group (separable verbs, reflexives, idioms) are highlighted together;
// exactly one of them carries lemma|english, the others just [#group].

const WORD = '[\\p{L}\\p{M}\\p{N}]+';
const ANNOTATION = '(\\[[^\\]\\n]*\\])?';
const WORD_RE = new RegExp(`(${WORD}(?:[-'’]${WORD})*)${ANNOTATION}`, 'gu');
// French words may also end in an elision apostrophe, so that "qu’[que|that]il" can be annotated.
const WORD_RE_FR = new RegExp(`(${WORD}(?:[-'’]${WORD})*['’]?)${ANNOTATION}`, 'gu');

// Apostrophes are compared in one form, so "l'" and "l’" find the same glossary entry.
const normApos = (s) => s.replace(/'/g, '’');

// --- French: elisions and pronouns joined by a hyphen become words of their own ---
// "l’homme" → l’ + homme · "jusqu’à" → jusqu’ + à · "dit-il" → dit + il · "a-t-il" → a + il ·
// "donne-le-moi" → donne + le + moi. Words like "aujourd’hui", "quelqu’un", "peut-être",
// "celui-ci" and "sur-le-champ" stay whole.
const FR_ELISION = /^(l|d|j|m|t|s|c|n|qu|jusqu|lorsqu|puisqu|quoiqu)['’]/i;
const FR_CLITIC = /^(je|tu|il|elle|on|nous|vous|ils|elles|moi|toi|lui|leur|le|la|les|y|en|ce|là|ci|[mt]['’](en|y))$/i;
const FR_DEMONSTRATIVE = /^(celui|celle|ceux|celles)$/i;

function splitElision(word) {
  const out = [];
  let m;
  while ((m = word.match(FR_ELISION)) && m[0].length < word.length) {
    out.push(m[0]);
    word = word.slice(m[0].length);
  }
  out.push(word);
  return out;
}

// The pieces of one French token: words ({ text, w: true }) and the hyphens between them.
function splitFrench(token) {
  const segs = token.split('-');
  let cut = segs.length; // segs[cut…] are pronouns joined to the word before them
  while (cut > 1) {
    const s = segs[cut - 1];
    if (/^(là|ci)$/i.test(s) && FR_DEMONSTRATIVE.test(segs[cut - 2])) break; // celui-ci stays whole
    if (FR_CLITIC.test(s) || (/^t$/i.test(s) && cut < segs.length)) cut--; // also the "t" of a-t-il
    else break;
  }
  const out = [];
  const addWord = (w) => splitElision(w).forEach((text) => out.push({ text, w: true }));
  addWord(segs.slice(0, cut).join('-'));
  for (let i = cut; i < segs.length; i++) {
    if (/^t$/i.test(segs[i])) {
      out.push({ text: `-${segs[i]}-` });
      addWord(segs[++i]);
    } else {
      out.push({ text: '-' });
      addWord(segs[i]);
    }
  }
  return out;
}

const lines = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

export function parseChapter(text, lang = 'de') {
  const errors = [];
  const chapter = { title: '', titleEn: '', lang, paragraphs: [], wordCount: 0, sentenceCount: 0 };
  let para = null;
  let pending = null; // the line waiting for its "= translation"

  lines(text).forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;
    if (line.startsWith('//')) return;
    if (!line) { para = null; pending = null; return; }

    if (line.startsWith('# ')) {
      chapter.title = line.slice(2).trim();
      pending = { isTitle: true };
      para = null;
      return;
    }
    if (line.startsWith('=')) {
      const en = line.slice(1).trim();
      if (pending?.isTitle) chapter.titleEn = en;
      else if (pending) pending.en = en;
      else errors.push({ line: lineNo, msg: 'Translation line "=" has no sentence line directly above it' });
      pending = null;
      return;
    }

    const sentence = parseSentence(line, lineNo, errors, lang);
    if (!para) { para = { sentences: [] }; chapter.paragraphs.push(para); }
    para.sentences.push(sentence);
    chapter.sentenceCount++;
    chapter.wordCount += sentence.parts.filter((p) => p.w).length;
    pending = sentence;
  });

  if (!chapter.title) errors.push({ line: 1, msg: 'Missing "# Title" line' });
  return { chapter, errors };
}

function parseSentence(line, lineNo, errors, lang) {
  const fr = lang === 'fr';
  const parts = [];
  let pos = 0;
  for (const m of line.matchAll(fr ? WORD_RE_FR : WORD_RE)) {
    if (m.index > pos) parts.push({ text: line.slice(pos, m.index) });
    const pieces = fr ? splitFrench(m[1]) : [{ text: m[1], w: true }];
    // An annotation belongs to the last word of the token ("l’homme[…]" annotates "homme").
    if (m[2]) Object.assign(pieces.findLast((p) => p.w), parseAnnotation(m[2].slice(1, -1)));
    parts.push(...pieces);
    pos = m.index + m[0].length;
  }
  if (pos < line.length) parts.push({ text: line.slice(pos) });

  // Mark words that start a sentence (first on the line, or after . ! ? : or an opening quote).
  const starter = fr ? /[.!?:«(—]/ : /[.!?:„‚»(]/;
  let start = true;
  for (const p of parts) {
    if (p.w) {
      p.start = start;
      start = false;
    } else if (starter.test(p.text)) {
      start = true;
    }
  }

  const sentence = { text: parts.map((p) => p.text).join(''), en: '', parts, line: lineNo };
  if (/[[\]]/.test(sentence.text)) {
    errors.push({ line: lineNo, msg: 'Stray "[" or "]": an annotation must follow a word directly, e.g. ging[gehen|to go]' });
  }
  linkGroups(sentence, errors);
  return sentence;
}

function parseAnnotation(body) {
  const out = {};
  const fields = [];
  for (const f of body.split('|').map((s) => s.trim())) {
    if (f.startsWith('#')) out.group = f.slice(1);
    else fields.push(f);
  }
  if (fields.length) {
    out.lemma = fields[0];
    out.en = fields[1] || '';
    out.note = fields[2] || '';
  }
  return out;
}

function linkGroups(sentence, errors) {
  const groups = new Map();
  for (const p of sentence.parts) {
    if (!p.w || !p.group) continue;
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  for (const [id, members] of groups) {
    const owners = members.filter((m) => m.lemma !== undefined);
    if (members.length < 2) errors.push({ line: sentence.line, msg: `Group #${id} has only one word` });
    if (owners.length !== 1) {
      errors.push({ line: sentence.line, msg: `Group #${id} needs exactly one word with [lemma|english|#${id}] (found ${owners.length})` });
    }
    const head = joinGroup(sentence.parts, members);
    for (const m of members) {
      m.members = members;
      m.owner = owners[0];
      m.head = head;
    }
  }
}

// "zog … an" for split words, "stehen blieben" for neighbours.
function joinGroup(parts, members) {
  let out = '';
  let prev = -1;
  parts.forEach((p, i) => {
    if (!members.includes(p)) return;
    if (prev >= 0) out += parts.slice(prev + 1, i).some((q) => q.w) ? ' … ' : ' ';
    out += p.text;
    prev = i;
  });
  return out;
}

export function parseGlossary(text) {
  const glossary = new Map();
  const errors = [];
  lines(text).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 3 || !cols[0] || !cols[2]) {
      errors.push({ line: i + 1, msg: `Expected "form | lemma | english | note", got: ${line}` });
      return;
    }
    const key = normApos(cols[0]);
    if (glossary.has(key)) errors.push({ line: i + 1, msg: `Duplicate entry "${cols[0]}"` });
    glossary.set(key, { lemma: cols[1] || cols[0], en: cols[2], note: cols[3] || '' });
  });
  return { glossary, errors };
}

// German formal "you" (Sie, Ihnen, Ihr …) is written with a capital letter. In the middle of a
// sentence the capital form means formal "you"; at the start of a sentence it is usually "she/they/her".
const FORMAL = new Set(['Sie', 'Ihnen', 'Ihr', 'Ihre', 'Ihrer', 'Ihrem', 'Ihren', 'Ihres']);

// Exact form first, then lower-case (for capitalised words at the start of a sentence).
export function lookupKey(glossary, form, sentenceStart = false, lang = 'de') {
  form = normApos(form);
  const lower = form.toLowerCase();
  if (lang === 'de' && sentenceStart && FORMAL.has(form) && glossary.has(lower)) return lower;
  if (glossary.has(form)) return form;
  if (glossary.has(lower)) return lower;
  const lowerFirst = form[0].toLowerCase() + form.slice(1);
  if (glossary.has(lowerFirst)) return lowerFirst;
  return null;
}

// Attaches `gloss` ({lemma, en, note}) to every word. Returns the words that have none.
export function annotateChapter(chapter, glossary) {
  const missing = [];
  for (const para of chapter.paragraphs) {
    for (const s of para.sentences) {
      for (const p of s.parts) {
        if (!p.w) continue;
        const src = p.owner || (p.lemma !== undefined ? p : null);
        if (src) {
          p.gloss = { lemma: src.lemma || src.text, en: src.en, note: src.note || '' };
        } else {
          const key = lookupKey(glossary, p.text, p.start, chapter.lang);
          p.glossKey = key;
          p.gloss = key ? glossary.get(key) : null;
        }
        if (!p.gloss || !p.gloss.en) missing.push({ form: p.text, sentence: s });
      }
    }
  }
  return missing;
}
