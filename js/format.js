// Parser for the book text format. Used by the app (browser) and by tools/check.mjs (Node).
// The format is described in CLAUDE.md.
//
// Chapter file:                     Glossary file (one entry per word form):
//   # German title                    ging | gehen | to go | Präteritum
//   = English title                   Mädchen | das Mädchen | girl
//                                     und | | and          (empty lemma = same as form)
//   German sentence line
//   = English translation
//   (blank line = new paragraph)
//
// Inline annotations override the glossary for one word: word[lemma|english|note|#group]
// Words sharing a #group (separable verbs, reflexives, idioms) are highlighted together;
// exactly one of them carries lemma|english, the others just [#group].

const WORD_RE = /([\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}\p{N}]+)*)(\[[^\]\n]*\])?/gu;

const lines = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

export function parseChapter(text) {
  const errors = [];
  const chapter = { title: '', titleEn: '', paragraphs: [], wordCount: 0, sentenceCount: 0 };
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
      else errors.push({ line: lineNo, msg: 'Translation line "=" has no German line directly above it' });
      pending = null;
      return;
    }

    const sentence = parseSentence(line, lineNo, errors);
    if (!para) { para = { sentences: [] }; chapter.paragraphs.push(para); }
    para.sentences.push(sentence);
    chapter.sentenceCount++;
    chapter.wordCount += sentence.parts.filter((p) => p.w).length;
    pending = sentence;
  });

  if (!chapter.title) errors.push({ line: 1, msg: 'Missing "# Title" line' });
  return { chapter, errors };
}

function parseSentence(line, lineNo, errors) {
  const parts = [];
  let pos = 0;
  for (const m of line.matchAll(WORD_RE)) {
    if (m.index > pos) parts.push({ text: line.slice(pos, m.index) });
    const part = { text: m[1], w: true };
    if (m[2]) Object.assign(part, parseAnnotation(m[2].slice(1, -1)));
    parts.push(part);
    pos = m.index + m[0].length;
  }
  if (pos < line.length) parts.push({ text: line.slice(pos) });

  const sentence = { de: parts.map((p) => p.text).join(''), en: '', parts, line: lineNo };
  if (/[[\]]/.test(sentence.de)) {
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
    if (glossary.has(cols[0])) errors.push({ line: i + 1, msg: `Duplicate entry "${cols[0]}"` });
    glossary.set(cols[0], { lemma: cols[1] || cols[0], en: cols[2], note: cols[3] || '' });
  });
  return { glossary, errors };
}

// Exact form first, then lower-case (for capitalised words at the start of a sentence).
export function lookupKey(glossary, form) {
  if (glossary.has(form)) return form;
  const lower = form.toLowerCase();
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
          const key = lookupKey(glossary, p.text);
          p.glossKey = key;
          p.gloss = key ? glossary.get(key) : null;
        }
        if (!p.gloss || !p.gloss.en) missing.push({ form: p.text, sentence: s });
      }
    }
  }
  return missing;
}
