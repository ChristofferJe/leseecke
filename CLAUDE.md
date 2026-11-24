# Leseecke: notes for Claude

Leseecke is a personal German graded reader. It is a static web app: plain HTML, CSS and
ES modules, no build step, no dependencies, no backend and **no API calls**. Claude writes
the books itself, in Claude Code sessions. Never add code that calls an LLM API. The owner
wants this to cost nothing beyond their existing Claude plan.

- `index.html`, `css/style.css`, `js/app.js`: the user interface (library, reader, review, words)
- `js/format.js`: the parser for the book format, shared by the app and the checker
- `js/srs.js`: the FSRS-5 flashcard scheduler · `js/store.js`: localStorage · `js/speech.js`: browser text-to-speech
- `books/index.json`: the list of books · `books/<id>/`: chapter files plus `glossary.txt`
- `tools/check.mjs`: the book validator · `tools/make-icons.mjs`: regenerates the icons
- `sw.js`: offline cache, only active over https. Bump `CACHE` when the app shell changes.

Run locally with `python -m http.server 8765` (the preview config is `.claude/launch.json`).

## Adding a book (the usual request)

1. **Source.** Use only public-domain originals (Project Gutenberg, Projekt Gutenberg-DE,
   Wikisource). Never copy text from commercial graded readers or apps such as Eppika.
   The source can be German or another language: retell it in German at the target level.
2. **Folder.** Create `books/<id>/`, with an id in kebab-case that ends in the level,
   e.g. `verwandlung-a2`.
3. **Chapters.** Write one file per chapter, `NN-slug.txt`, about 500–1500 words each.
   Split long chapters. Write them one at a time and run the checker after each.
4. **Glossary.** Run `node tools/check.mjs <id> --missing` to list every word form that has
   no gloss yet, with an example sentence, then add the entries to `books/<id>/glossary.txt`.
   Repeat until the checker prints "All good."
5. **Register.** Add the book to `books/index.json`. Fields: `id`, `title`, `titleEn`,
   `author`, `level`, `color` (a dark cover colour), `description`, `source` and `chapters`
   (file names in reading order).
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

- Every German line is followed directly by `= English translation`. One line holds one
  sentence, or two very short ones. It is the unit for "Read sentence" and "Translate sentence".
- The English is a natural, faithful translation of the **simplified German line**, not of
  the original book.
- Use German quotation marks („…“ and ‚…‘ inside them).

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

## Glossary format (`glossary.txt`)

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
- Don't put a capitalised entry for "Sie" in the glossary, because it would capture "Sie"
  meaning "she" at the start of sentences. Annotate formal "Sie" inline instead.

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
