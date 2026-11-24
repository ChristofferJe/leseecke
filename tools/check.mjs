// Checks the books for format errors, missing translations and missing glosses.
//
//   node tools/check.mjs                 check every book
//   node tools/check.mjs grimm-a2        check one book
//   node tools/check.mjs grimm-a2 --missing   also print glossary stub lines for missing words
//   node tools/check.mjs grimm-a2 --unused    also list glossary entries no chapter uses

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseChapter, parseGlossary, annotateChapter } from '../js/format.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const only = args.find((a) => !a.startsWith('--'));

// Rough upper limits for the average number of words per sentence line.
const MAX_AVG_WORDS = { A1: 8, A2: 11, B1: 15, B2: 20, C1: 26 };

const books = JSON.parse(readFileSync(join(root, 'books', 'index.json'), 'utf8'));
let problems = 0;

const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };

for (const book of books) {
  if (only && book.id !== only) continue;
  const dir = join(root, 'books', book.id);
  console.log(`\n${book.title} — ${book.id} (${book.level})`);

  const glossPath = join(dir, 'glossary.txt');
  const { glossary, errors: gErrors } = existsSync(glossPath)
    ? parseGlossary(readFileSync(glossPath, 'utf8'))
    : { glossary: new Map(), errors: [{ line: 0, msg: 'glossary.txt not found' }] };
  gErrors.forEach((e) => fail(`glossary.txt:${e.line} ${e.msg}`));

  const used = new Set();
  const missing = new Map(); // form -> { count, example }
  let words = 0;
  let sentences = 0;

  for (const file of book.chapters) {
    const path = join(dir, file);
    if (!existsSync(path)) { fail(`${file}: file not found`); continue; }
    const { chapter, errors } = parseChapter(readFileSync(path, 'utf8'));
    errors.forEach((e) => fail(`${file}:${e.line} ${e.msg}`));
    if (!chapter.titleEn) fail(`${file}: title has no "= English title" line`);

    const all = chapter.paragraphs.flatMap((p) => p.sentences);
    for (const s of all) if (!s.en) fail(`${file}:${s.line} no "= translation" line for: ${s.de}`);

    for (const m of annotateChapter(chapter, glossary)) {
      const entry = missing.get(m.form) || { count: 0, example: `${file}:${m.sentence.line} ${m.sentence.de}` };
      entry.count++;
      missing.set(m.form, entry);
    }
    for (const s of all) for (const p of s.parts) if (p.glossKey) used.add(p.glossKey);

    const avg = chapter.wordCount / Math.max(1, chapter.sentenceCount);
    const limit = MAX_AVG_WORDS[book.level] ?? 99;
    const long = all
      .map((s) => ({ s, n: s.parts.filter((p) => p.w).length }))
      .filter((x) => x.n > limit * 1.8)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
    console.log(`  ${file}: "${chapter.title}" — ${chapter.wordCount} words, ${chapter.sentenceCount} lines, ${avg.toFixed(1)} words/line`);
    if (avg > limit) console.log(`    ! average line length is above the ${book.level} guideline (${limit})`);
    for (const x of long) console.log(`    ! long line (${x.n} words) ${file}:${x.s.line}`);
    words += chapter.wordCount;
    sentences += chapter.sentenceCount;
  }

  console.log(`  Total: ${words} words, ${sentences} lines, ${glossary.size} glossary entries`);

  if (missing.size) {
    fail(`${missing.size} word forms have no gloss (add them to glossary.txt or annotate inline)`);
    const list = [...missing.entries()];
    if (flags.has('--missing')) {
      console.log('\n// --- stub lines for glossary.txt ---');
      for (const [form, info] of list) console.log(`${form} |  |  |    // ×${info.count}  ${info.example}`);
    } else {
      console.log(`    ${list.slice(0, 30).map(([f]) => f).join(', ')}${list.length > 30 ? ', …' : ''}`);
      console.log('    (run with --missing to print stub lines with example sentences)');
    }
  }

  const unused = [...glossary.keys()].filter((k) => !used.has(k));
  if (unused.length) {
    console.log(`  ${unused.length} glossary entries are not used by any chapter${flags.has('--unused') ? ':' : ' (--unused lists them)'}`);
    if (flags.has('--unused')) console.log(`    ${unused.join(', ')}`);
  }
}

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
process.exit(problems ? 1 : 0);
