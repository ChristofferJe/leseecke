// Checks the books for format errors, missing translations and missing glosses.
//
//   node tools/check.mjs                   check every book
//   node tools/check.mjs grimm             check every level of one book
//   node tools/check.mjs grimm-b1          check one level (edition)
//   node tools/check.mjs grimm-b1 --missing   also print glossary stub lines for missing words
//   node tools/check.mjs --unused          also list glossary entries that no chapter uses
//
// Words are looked up in the edition's own glossary first, then in books/glossary.txt.

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

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log(`  ✗ ${msg}`);
};
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const works = JSON.parse(read('books', 'library.json'));
const shared = parseGlossary(read('books', 'glossary.txt'));
if (shared.errors.length) {
  console.log('\nbooks/glossary.txt (shared)');
  shared.errors.forEach((e) => fail(`glossary.txt:${e.line} ${e.msg}`));
}
const usedShared = new Set();
const editionIds = new Set();

for (const work of works) {
  for (const key of ['id', 'title', 'author', 'color', 'editions']) if (!work[key]) fail(`library.json: book "${work.id}" has no "${key}"`);
  for (const ed of work.editions || []) {
    if (editionIds.has(ed.id)) fail(`library.json: edition id "${ed.id}" is used twice`);
    editionIds.add(ed.id);
    if (only && only !== work.id && only !== ed.id) continue;
    checkEdition(work, ed);
  }
}

function checkEdition(work, ed) {
  const dir = join(root, 'books', ed.id);
  console.log(`\n${work.title} — ${ed.id} (${ed.level})`);

  const own = existsSync(join(dir, 'glossary.txt'))
    ? parseGlossary(readFileSync(join(dir, 'glossary.txt'), 'utf8'))
    : { glossary: new Map(), errors: [{ line: 0, msg: 'glossary.txt not found (create it, even if it only has a comment)' }] };
  own.errors.forEach((e) => fail(`${ed.id}/glossary.txt:${e.line} ${e.msg}`));
  const glossary = new Map([...shared.glossary, ...own.glossary]);

  const usedOwn = new Set();
  const missing = new Map(); // form -> { count, example }
  let words = 0;
  let lines = 0;

  for (const file of ed.chapters) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      fail(`${file}: file not found`);
      continue;
    }
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
    for (const s of all) {
      for (const p of s.parts) {
        if (!p.glossKey) continue;
        if (own.glossary.has(p.glossKey)) usedOwn.add(p.glossKey);
        else usedShared.add(p.glossKey);
      }
    }

    const avg = chapter.wordCount / Math.max(1, chapter.sentenceCount);
    const limit = MAX_AVG_WORDS[ed.level] ?? 99;
    const long = all
      .map((s) => ({ s, n: s.parts.filter((p) => p.w).length }))
      .filter((x) => x.n > limit * 1.8)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
    console.log(`  ${file}: "${chapter.title}" — ${chapter.wordCount} words, ${chapter.sentenceCount} lines, ${avg.toFixed(1)} words/line`);
    if (avg > limit) console.log(`    ! average line length is above the ${ed.level} guideline (${limit})`);
    for (const x of long) console.log(`    ! long line (${x.n} words) ${file}:${x.s.line}`);
    words += chapter.wordCount;
    lines += chapter.sentenceCount;
  }

  console.log(`  Total: ${words} words, ${lines} lines; ${own.glossary.size} own glossary entries`);

  if (missing.size) {
    fail(`${missing.size} word forms have no gloss (add them to a glossary or annotate them inline)`);
    const list = [...missing.entries()];
    if (flags.has('--missing')) {
      console.log(`\n// --- stub lines (${ed.id}) ---`);
      for (const [form, info] of list) console.log(`${form} |  |  |    // ×${info.count}  ${info.example}`);
    } else {
      console.log(`    ${list.slice(0, 30).map(([f]) => f).join(', ')}${list.length > 30 ? ', …' : ''}`);
      console.log('    (run with --missing to print stub lines with example sentences)');
    }
  }
  const unusedOwn = [...own.glossary.keys()].filter((k) => !usedOwn.has(k));
  if (unusedOwn.length && flags.has('--unused')) console.log(`  unused own entries: ${unusedOwn.join(', ')}`);
}

if (!only) {
  const unused = [...shared.glossary.keys()].filter((k) => !usedShared.has(k));
  console.log(`\nShared glossary: ${shared.glossary.size} entries, ${unused.length} not used by any book${flags.has('--unused') ? `: ${unused.join(', ')}` : ''}`);
}

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
process.exit(problems ? 1 : 0);
