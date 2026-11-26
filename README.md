# Leseecke

Your own graded reader for German and French. You read classic stories retold in simple
German or French. Tap any word to see what it means and hear it spoken, save words you want
to learn, and review them later with spaced-repetition flashcards.

It costs nothing to run: no account, no server, no API.

## Start it on your PC

Open a terminal (PowerShell) in this folder and run:

```powershell
python -m http.server 8765
```

Then open <http://localhost:8765> in your browser. Microsoft Edge has the most natural German and French
voices on Windows.

## Use it on your phone

**Quick test on the same Wi-Fi:** while the server above is running, open
`http://<your-PC's-IP>:8765` on your phone. You can find the IP with `ipconfig`, listed as
"IPv4 Address". This works, but it can't be installed or used offline.

**Proper install (free):** put the folder on a free static host that uses https, for example:
- **Netlify Drop**: drag this folder onto https://app.netlify.com/drop
- **GitHub Pages**: push the folder to a GitHub repository and turn on Pages

Then open the https address on your phone and choose *Add to Home screen* (Android: Chrome
menu; iPhone: Safari share button). The app itself then opens without internet. To read a
book offline, tap **Download** on it in the library. Only downloaded books take up space on
the phone, and you can remove a download at any time.

This copy lives at **https://christofferje.github.io/leseecke/** (repository:
https://github.com/ChristofferJe/leseecke). To publish changes, such as a new book, commit
and push to `main`. GitHub Pages updates within a minute or two. A new book appears in the
library the next time the app is opened with a connection, ready to read or download.
Changes to the app itself take effect on the second open.

## How to use it

- **Languages.** The library shows the books of one language at a time. Switch between
  *Deutsch* and *Français* at the top of the library. Opening a book also switches the
  library to its language.
- **Levels.** Some books come in several levels (e.g. A1, A2, B1). Choose one on the
  book's page, or switch while reading with the level buttons at the top: you stay in the
  same chapter. Each book remembers your level, and new books start at your latest level.
- **Library → book → chapter.** Tap a word to see its basic form, meaning and a grammar note.
  The word is spoken aloud. Words that belong together, like separable verbs (*zog … an*), are
  highlighted together.
- **Save word.** It becomes a flashcard with the sentence you found it in. Saved words get a
  dotted underline in the text.
- **Read sentence / Translate sentence** in the word panel, for when the whole sentence is unclear.
- **Review.** You see the German word and its sentence. Try to recall the meaning, show the
  answer, then grade yourself honestly (Again, Hard, Good, Easy). The scheduler (FSRS, the
  algorithm modern Anki uses) decides when you see the word again.
- **Words.** Your saved words, a voice for each language, speed settings, the daily limit for
  new words, and backups. German and French words share one review queue; each card shows
  its language once you have saved words in both.

## Your data

Saved words and reading progress live **in the browser you use**: localhost on your PC and
your deployed copy on your phone count as two separate places. Use **Words → Export backup**
and **Import backup** to move them between places or to keep a copy. **Export for Anki**
writes a CSV file that Anki can import, if you would rather review there.

## Adding more books

Open this folder in Claude Code and ask, for example:

> Add Kafka's *Die Verwandlung* at A2.
> Add *Sherlock Holmes: A Scandal in Bohemia* at B1, retold in German.
> Add Maupassant's *Le Horla* in French at A2 and B1.

Claude follows the rules in `CLAUDE.md`. It uses public-domain originals only, matches the
level, glosses every word, and runs `node tools/check.mjs` until the book passes.
