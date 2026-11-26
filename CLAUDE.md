# Leseecke: notes for Claude

Leseecke is a personal graded reader for German and French. It is a static web app: plain HTML, CSS and
ES modules, no build step, no dependencies, no backend and **no API calls**. Claude writes
the books itself, in Claude Code sessions. Never add code that calls an LLM API. The owner
wants this to cost nothing beyond their existing Claude plan.

- `index.html`, `css/style.css`, `js/app.js`: the user interface (library, reader, review, words)
- `js/format.js`: the parser for the book format, shared by the app and the checker
- `js/languages.js`: the book languages (names, voices, shared glossary path, test sentence)
- `js/srs.js`: the FSRS-5 flashcard scheduler · `js/store.js`: localStorage · `js/speech.js`: browser text-to-speech
- `books/library.json`: the list of books. Each book has a `language` (`"fr"`; a book
  without one is German) and one or more **editions**, one per level; the reader switches
  between levels inside the book. The library shows one language at a time, with a
  Deutsch/Français switch.
- `books/<edition id>/`: an edition's chapter files plus its own `glossary.txt`
- **Shared glossaries**, one per language: `books/glossary.txt` (German, the original file
  name) and `books/glossary-fr.txt` (French). An edition's own glossary is checked first,
  so it can override a shared entry for that edition.
- Flashcards from all languages share one review queue. German cards are stored by lemma,
  other languages as `<code>:<lemma>` (e.g. `fr:hier`), so equal lemmas never collide.
- `books/index.json`: the old single-level list, kept only so that installed copies of
  older app versions keep working during an update. Don't add books to it.
- `tools/check.mjs`: the book validator · `tools/make-icons.mjs`: regenerates the icons
- `sw.js`: offline support, active only over https (on localhost add `?sw=1` to test it).
  App files are cache-first, `books/library.json` is network-first (new books and levels
  show up on the first open), and book files are stored only for books the reader
  downloads. A download covers **all levels** of a book: each edition has its own cache,
  `leseecke-book-<edition id>`, managed by the download buttons in `app.js`. A downloaded
  book that gains a level or chapter is topped up automatically. Bump `CACHE` when app files
  change. Adding a book or level needs no change to `sw.js`; adding a language does (its
  shared glossary goes in `SHELL`).

Run locally with `python -m http.server 8765` (the preview config is `.claude/launch.json`).

## Adding a book or a level (the usual request)

1. **Source.** Use only public-domain originals (Project Gutenberg, Projekt Gutenberg-DE,
   Wikisource). Never copy text from commercial graded readers or apps such as Eppika.
   Check the dates, because the app is public on GitHub Pages: in the EU a work is free 70
   years after the author's death, and in the US only works published before 1930 are
   safe. Camus (died 1960, *L'Étranger* 1942) and Saint-Exupéry are still protected.
   The source can be in any language: retell it in the book's language at the target level.
   Novels become abridged graded readers (about 6–10 chapters of 600–1000 words) unless
   the owner asks for something longer.
2. **Folder.** Create `books/<edition id>/`, where the id is the book id plus the level,
   e.g. `verwandlung-a2`. Give it a `glossary.txt`, even if it only holds a comment line.
3. **Chapters.** Write one file per chapter, `NN-slug.txt`. Write them one at a time and run
   the checker after each. **All levels of a book use the same chapters in the same order**,
   because the level switcher keeps the reader in the same chapter.
4. **Register.** In `books/library.json`, add a new book (`id`, `language` (`"fr"`; leave it
   out for German), `title`, `titleEn`, `author`, `color` (a dark cover colour),
   `description`, `source`, `editions`) or add an edition to an existing one
   (`{ "id": "<edition id>", "level": "B1", "chapters": [file names in order] }`).
   Never create a second book entry for a new level of the same book. Keep the file an
   array: installed copies of the previous app version read it on their first open.
5. **Glossary.** Run `node tools/check.mjs <edition id> --missing` to list every word form
   that has no gloss yet, with an example sentence. Add general words to the shared glossary
   of the book's language (`books/glossary.txt` or `books/glossary-fr.txt`), and meanings
   that only fit this book to the edition's `glossary.txt`. Repeat until the checker prints
   "All good." For a big batch, write the entries to a scratch file and append it: shell
   heredocs break on apostrophes.
6. **Check the result.** Run `node tools/check.mjs` once more. Also read a chapter in the app
   and tap a few words, including separable verbs.

## Chapter format

```
// comment lines start with //
# Rotkäppchen
= Little Red Riding Hood

Es war einmal ein kleines Mädchen.
= Once upon a time there was a little girl.
Alle Leute mochten das Mädchen.
= Everyone liked the girl.

(a blank line starts a new paragraph)
```

- Every sentence line is followed directly by `= English translation`. One line holds one
  sentence, or two very short ones. It is the unit for "Read sentence" and "Translate sentence".
- The English is a natural, faithful translation of the **simplified line**, not of
  the original book.
- Use German quotation marks („…“ and ‚…‘ inside them) in German books, and French ones
  (« … » with no-break spaces) in French books.

### Inline annotations

Write `word[lemma|english|note|#group]` directly after a word, with no space, to override
the glossary for that one occurrence. All fields are optional. A field that starts with `#`
is a group id, and the other fields count in order from lemma.

- **Separable verbs, reflexive verbs, idioms:** link the parts with a group id. Exactly one
  member carries lemma and English; the others carry only `[#id]`. Group ids are local to
  the line, so use different ids for different groups on the same line.
  `Dann zog[anziehen|to put on (clothes)|#z] er die Kleider an[#z].`
  `Der Vater freute[sich freuen|to be happy|#f] sich[#f] sehr.`
  `Eines[eines Tages|one day|fixed expression|#t] Tages[#t] …`
- **Ambiguous small words:** annotate them when the glossary default would mislead, e.g.
  `ihr[sie|(to) her|dative of "sie"]`, `damit[damit|with them|here: "with them" (the stones)]`,
  `Morgen[morgen|tomorrow]` at the start of a sentence.
- When the parts of a separable verb stay together (after `als`, `dass`, `wenn`, `weil` …,
  e.g. `als er aufwachte`), a normal glossary entry is enough.

## Glossary format (`books/glossary.txt` and `books/<edition>/glossary.txt`)

```
form | lemma | english | note
ging | gehen | to go | past: went
Mädchen | das Mädchen | girl | -chen words are always "das"
und | | and
```

- There is one entry per **word form** as it appears in the text. Lookup is exact first,
  then lower case, so a capitalised word at the start of a sentence finds the lower-case
  entry. Only nouns (and noun-like words) keep a capital letter in the key.
- **lemma:** nouns with their article (`die Blume`), verbs in the infinitive, adjectives in
  the base form. Leave it empty when it equals the form.
- **english:** the meaning of the lemma in this book's context (verbs as "to …"). Keep it
  short and give two meanings at most.
- **note:** grammar for this form, in plain words for a learner: "plural", "past: went",
  "command", "after a preposition", "comparative of gut", and also false friends
  ("bekommen = to get, not to become").
- **Formal "you"** (`Sie`, `Ihnen`, `Ihr`, `Ihre` …) has its own capitalised entries in the
  shared glossary. `js/format.js` uses them only in the middle of a sentence. At the start of a
  sentence (first word, or after `. ! ? :` or an opening quote) the lower-case entry is used,
  i.e. "she/they/her". So **annotate formal Sie only when it starts a sentence**:
  `„Sie[Sie|you|formal "you" (always with a capital S)] kennen ihn besser als ich.“`
- In the Austen books, Emma and Mr Knightley say `du` to each other. Everyone else uses `Sie`,
  except within families.

## French books

- **Word splitting** (`js/format.js`): elisions become words of their own (`l’homme` → `l’` +
  `homme`, `qu’il` → `qu’` + `il`, `jusqu’à` → `jusqu’` + `à`), and so do pronouns joined by a
  hyphen (`dit-il` → `dit` + `il`, `donne-le-moi` → `donne` + `le` + `moi`; the `t` of `a-t-il`
  is ignored). Words like `aujourd’hui`, `quelqu’un`, `peut-être`, `celui-ci`, `sur-le-champ`
  stay whole. Glossary keys therefore hold `l’`, `homme`, `il` … (the app speaks `l’` together
  with its word).
- **Apostrophes:** write the typographic `’`. The checker and app treat `'` and `’` alike.
- **Typography:** « … » and `? ! : ;` take a no-break space (U+00A0). Write normal spaces
  and convert them with a small script, as `dernier-jour-*` was.
- **Annotations** attach to the last word of a token: `l’homme[…]` annotates `homme`. To
  annotate the elision itself, put the brackets right after the apostrophe: `l’[le|him]ai`.
  A noun use of `pas` (`un pas[le pas|step]`), `je vis` meaning "I saw", `de garde` etc.
  need an annotation, because the glossary default is the common meaning.
- **Glossary:** nouns starting with a vowel show their gender: `l’heure (f)`, `l’homme (m)`.
  Mark literary tenses in the note ("passé simple: il lut = he read"), and old or slang
  words ("argot", "old-fashioned").
- **Levels:** A1: présent, passé composé of common verbs, `c’était`/`il y avait`/`j’avais`,
  futur proche (`je vais mourir`). A2: adds the imparfait, simple future of common verbs,
  `qui`/`que`/`où`, and only `je voudrais`/`pourrait`/`ce serait` in the conditional. B1:
  all indicative tenses incl. plus-que-parfait, conditional, subjunctive after common
  triggers (`il faut que`, `pour que`), no passé simple. B2: close to the original,
  passé simple allowed. Sentence lengths as in the table below.

## Adding a language

1. Add it to `LANGUAGES` in `js/languages.js` (names, speech code, voice codes, shared
   glossary path `books/glossary-<code>.txt`, test sentence, library example).
2. Create the shared glossary file, add it to `SHELL` in `sw.js`, and bump `CACHE`.
3. Give the books `"language": "<code>"` in `books/library.json`. The library switch
   appears by itself as soon as two languages have books.
4. If the language needs its own word splitting (like French elisions), add it to
   `parseSentence` in `js/format.js`, and test it with a few sample lines before writing.

## Level rules (CEFR)

| Level | Grammar allowed | Sentences | Vocabulary |
|---|---|---|---|
| A1 | Present tense; Perfekt of very common verbs; `war`/`hatte`; main clauses with und/aber/oder; no genitive, passive or Konjunktiv | ≤ 8 words on average | ~700 most common words; repeat key words often |
| A2 | Present, Perfekt; past tense (Präteritum) for narration with common verbs (war, hatte, ging, kam, sah, sagte, konnte, wollte …); clauses with weil/dass/wenn/als/ob; dative and accusative; `wäre`/`könnte`/`möchte` only | ≤ 11 words on average | ~1500 most common words plus story words, all glossed |
| B1 | Free past tense, Plusquamperfekt, relative clauses, present passive, Konjunktiv II, genitive in set phrases | ≤ 15 words on average | Common vocabulary; idioms only with an annotation |
| B2 | Close to the original; simplify only archaic wording and very long sentences | ≤ 20 words on average | Original vocabulary, with rare and archaic words annotated |

General rules for retelling:
- Keep the plot, the characters and the memorable lines. Cut side plots rather than squeezing
  them into hard sentences.
- Prefer repeating a noun over an unclear pronoun at A1 and A2.
- Avoid the genitive at A1 and A2 (`das Haus von der Hexe`, `der Bauch vom Wolf`).
- The checker warns when the average line length is above the level's guideline. Treat that
  as a prompt to split sentences, not as a hard rule.
