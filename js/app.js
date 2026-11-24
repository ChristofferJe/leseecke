import { parseChapter, parseGlossary, annotateChapter } from './format.js';
import { preview, formatInterval, isLearning, GRADES, GRADE_NAMES, MINUTE } from './srs.js';
import * as store from './store.js';
import * as speech from './speech.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;
const ICON = {
  speaker: svg(
    '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ),
  star: svg('<path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'),
  starFilled: svg('<path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  back: svg('<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  trash: svg('<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
};

const app = $('#app');
const sheet = $('#sheet');
const sheetInner = $('#sheet-inner');
const settings = store.state.settings;

let books = [];
const bookCache = new Map();
let renderId = 0; // guards against an older async render overwriting a newer view
let view = '';
let reader = null; // { book, bookId, ci, tokens, selected, enOpenFor }
let review = null; // { card, revealed, counts }

const say = (text) => speech.speak(text, { rate: settings.rate, voice: settings.voice });

// ---------- data ----------

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.text();
}

async function loadBooks() {
  books = JSON.parse(await fetchText('books/index.json'));
}

async function loadBook(id) {
  if (bookCache.has(id)) return bookCache.get(id);
  const meta = books.find((b) => b.id === id);
  if (!meta) throw new Error(`There is no book called "${id}".`);
  const [glossText, ...texts] = await Promise.all([
    fetchText(`books/${id}/glossary.txt`),
    ...meta.chapters.map((f) => fetchText(`books/${id}/${f}`)),
  ]);
  const { glossary } = parseGlossary(glossText);
  const chapters = texts.map((t) => {
    const { chapter } = parseChapter(t);
    annotateChapter(chapter, glossary);
    return chapter;
  });
  const book = { meta, chapters };
  bookCache.set(id, book);
  return book;
}

// ---------- flashcard queue ----------

function queue(now = Date.now()) {
  const cards = store.cardList();
  const learnAhead = now + 20 * MINUTE;
  const learningDue = [];
  const learningSoon = [];
  const reviewDue = [];
  const fresh = [];
  for (const c of cards) {
    const s = c.srs;
    if (s.state === 'new') fresh.push(c);
    else if (isLearning(s)) {
      if (s.due <= now) learningDue.push(c);
      else if (s.due <= learnAhead) learningSoon.push(c);
    } else if (s.due <= now) reviewDue.push(c);
  }
  const byDue = (a, b) => a.srs.due - b.srs.due;
  const today = new Date(now).toDateString();
  const newToday = cards.filter((c) => c.firstReview && new Date(c.firstReview).toDateString() === today).length;
  const newLeft = Math.max(0, settings.newPerDay - newToday);
  fresh.sort((a, b) => a.created - b.created);
  const newCards = fresh.slice(0, newLeft);
  learningDue.sort(byDue);
  reviewDue.sort(byDue);
  learningSoon.sort(byDue);
  return {
    next: learningDue[0] || reviewDue[0] || newCards[0] || learningSoon[0] || null,
    counts: {
      new: newCards.length,
      learning: learningDue.length + learningSoon.length,
      review: reviewDue.length,
      waitingNew: fresh.length - newCards.length,
    },
  };
}

function updateBadge(counts = queue().counts) {
  const n = counts.new + counts.learning + counts.review;
  const badge = $('#due-badge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}

// ---------- routing ----------

function route() {
  const [, name = '', a, b] = location.hash.replace(/^#/, '').split('/');
  closeSheet();
  reader = null;
  review = null;
  view = { book: 'book', read: 'read', review: 'review', words: 'words' }[name] || 'library';
  document.body.dataset.view = view;
  const tab = view === 'book' || view === 'read' ? 'library' : view;
  $$('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === tab));
  if (view !== 'read') window.scrollTo(0, 0);

  if (view === 'book') return showBook(decodeURIComponent(a || ''));
  if (view === 'read') return showReader(decodeURIComponent(a || ''), Number(b) || 0);
  if (view === 'review') return showReview();
  if (view === 'words') return showWords();
  return showLibrary();
}

const loading = () => '<p class="loading">Loading…</p>';

function showError(err) {
  app.innerHTML = `<div class="panel error"><h2>Something went wrong</h2><p>${esc(err.message || err)}</p>
    <p><a class="btn" href="#/">Back to the library</a></p></div>`;
}

// ---------- library ----------

function cover(b) {
  return `<div class="cover" style="--cover:${esc(b.color || '#2f6f73')}">
    <span class="cover-title">${esc(b.title)}</span>
    <span class="cover-author">${esc(b.author)}</span>
    <span class="level">${esc(b.level)}</span>
  </div>`;
}

function showLibrary() {
  ++renderId;
  const { counts } = queue();
  const due = counts.new + counts.learning + counts.review;
  app.innerHTML = `
    <h1 class="page-title">Library</h1>
    ${due ? `<a class="panel due-teaser" href="#/review"><strong>${due} flashcard${due === 1 ? '' : 's'} ready</strong><span>Review now →</span></a>` : ''}
    <div class="books">
      ${books
        .map((b) => {
          const p = store.state.progress[b.id];
          const where = p ? `Continue at chapter ${p.chapter + 1}` : `${b.chapters.length} chapters`;
          return `<a class="book-card" href="#/book/${encodeURIComponent(b.id)}">
            ${cover(b)}
            <span class="book-info">
              <strong>${esc(b.title)}</strong>
              <span class="muted">${esc(b.titleEn || '')}</span>
              <span class="muted small">${esc(where)}</span>
            </span>
          </a>`;
        })
        .join('')}
    </div>
    <p class="hint">Want another book? Open this folder in Claude Code and ask, for example:
      <em>“Add Kafka's Die Verwandlung at A2.”</em> The steps are in <code>CLAUDE.md</code>.</p>`;
}

async function showBook(id) {
  const t = ++renderId;
  app.innerHTML = loading();
  let book;
  try {
    book = await loadBook(id);
  } catch (e) {
    return showError(e);
  }
  if (t !== renderId) return;
  const { meta, chapters } = book;
  const p = store.state.progress[id];
  const start = p ? p.chapter : 0;
  app.innerHTML = `
    <a class="link-back" href="#/">${ICON.back} Library</a>
    <section class="book-head">
      ${cover(meta)}
      <div>
        <h1>${esc(meta.title)}</h1>
        <p class="muted">${esc(meta.author)} · Level ${esc(meta.level)}</p>
        <p>${esc(meta.description || '')}</p>
        <a class="btn primary" href="#/read/${encodeURIComponent(id)}/${start}">${p ? 'Continue reading' : 'Start reading'}</a>
      </div>
    </section>
    <h2 class="section-title">Chapters</h2>
    <ol class="toc">
      ${chapters
        .map(
          (c, i) => `<li><a href="#/read/${encodeURIComponent(id)}/${i}">
            <span class="toc-num">${i + 1}</span>
            <span class="toc-title"><span lang="de">${esc(c.title)}</span><span class="muted">${esc(c.titleEn)}</span></span>
            <span class="muted small">${c.wordCount} words</span>
          </a></li>`,
        )
        .join('')}
    </ol>
    <p class="hint small">${esc(meta.source || '')}</p>`;
}

// ---------- reader ----------

function sentenceHtml(s, tokens) {
  const inner = s.parts
    .map((p) => {
      if (!p.w) return esc(p.text);
      const i = tokens.length;
      p._i = i;
      tokens.push({ part: p, sentence: s });
      const saved = p.gloss && store.isSaved(p.gloss.lemma) ? ' saved' : '';
      return `<span class="w${saved}" data-i="${i}">${esc(p.text)}</span>`;
    })
    .join('');
  return `<span class="s">${inner}</span>`;
}

async function showReader(bookId, ci) {
  const t = ++renderId;
  app.innerHTML = loading();
  let book;
  try {
    book = await loadBook(bookId);
  } catch (e) {
    return showError(e);
  }
  if (t !== renderId) return;
  const ch = book.chapters[ci];
  if (!ch) {
    location.hash = `#/book/${encodeURIComponent(bookId)}`;
    return;
  }

  const tokens = [];
  const body = ch.paragraphs.map((p) => `<p>${p.sentences.map((s) => sentenceHtml(s, tokens)).join(' ')}</p>`).join('');
  reader = { book, bookId, ci, tokens, selected: -1, enOpenFor: null };

  const enc = encodeURIComponent(bookId);
  const last = book.chapters.length - 1;
  const prev = ci > 0 ? `<a class="btn" href="#/read/${enc}/${ci - 1}">← Previous</a>` : '<span></span>';
  const next =
    ci < last
      ? `<a class="btn primary" href="#/read/${enc}/${ci + 1}">Next: ${esc(book.chapters[ci + 1].title)} →</a>`
      : `<a class="btn primary" href="#/book/${enc}">Finished! Back to the book</a>`;

  app.innerHTML = `
    <div class="reader-bar">
      <a class="link-back" href="#/book/${enc}">${ICON.back} ${esc(book.meta.title)}</a>
      <div class="font-ctl" role="group" aria-label="Text size">
        <button class="icon-btn" data-act="font-down" aria-label="Smaller text">A−</button>
        <button class="icon-btn" data-act="font-up" aria-label="Larger text">A+</button>
      </div>
    </div>
    <article class="reader" style="--reader-size:${settings.fontSize}px">
      <header class="chapter-head">
        <p class="eyebrow">Chapter ${ci + 1} of ${book.chapters.length} · ${esc(book.meta.level)}</p>
        <h1 lang="de">${esc(ch.title)}</h1>
        <p class="muted">${esc(ch.titleEn)}</p>
      </header>
      ${store.cardList().length ? '' : '<p class="tip">Tap any word to see what it means and hear it.</p>'}
      <div class="text" lang="de">${body}</div>
    </article>
    <nav class="chapter-nav">${prev}${next}</nav>`;

  const p = store.state.progress[bookId];
  const sameChapter = p && p.chapter === ci;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, sameChapter && p.scroll ? p.scroll * max : 0);
  });
  store.setProgress(bookId, ci, sameChapter ? p.scroll || 0 : 0);
}

function selectWord(i) {
  const tok = reader?.tokens[i];
  if (!tok) return;
  reader.selected = i;
  $$('.w.sel', app).forEach((el) => el.classList.remove('sel'));
  const idx = tok.part.members ? tok.part.members.map((m) => m._i) : [i];
  idx.forEach((k) => $(`.w[data-i="${k}"]`, app)?.classList.add('sel'));
  if (settings.autoSpeak) say(tok.part.text);
  renderWordSheet();
  openSheet();
  keepVisible($(`.w[data-i="${i}"]`, app));
}

function renderWordSheet() {
  const { part, sentence } = reader.tokens[reader.selected];
  const g = part.gloss;
  const head = part.head || part.text;
  const saved = g && store.isSaved(g.lemma);
  const enOpen = reader.enOpenFor === sentence;
  sheetInner.innerHTML = `
    <div class="sheet-head">
      <button class="word-say" data-act="say" data-text="${esc(part.text)}" aria-label="Pronounce ${esc(part.text)}">
        <span class="form" lang="de">${esc(head)}</span>${ICON.speaker}
      </button>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button>
    </div>
    ${
      g
        ? `<p class="gloss">
             <button class="lemma" data-act="say" data-text="${esc(g.lemma)}" lang="de" title="Pronounce">${esc(g.lemma)}</button>
             <span class="en">${esc(g.en)}</span>
           </p>
           ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
           <button class="btn save ${saved ? 'is-saved' : 'primary'}" data-act="toggle-save" aria-pressed="${saved}">
             ${saved ? `${ICON.starFilled} Saved to flashcards` : `${ICON.star} Save word`}
           </button>`
        : '<p class="note">There is no translation for this word yet.</p>'
    }
    <div class="sentence">
      <div class="sentence-actions">
        <button class="btn small" data-act="say-sentence">${ICON.speaker} Read sentence</button>
        <button class="btn small" data-act="toggle-en" aria-expanded="${enOpen}">${enOpen ? 'Hide translation' : 'Translate sentence'}</button>
      </div>
      <p class="sentence-en" ${enOpen ? '' : 'hidden'}>${esc(sentence.en)}</p>
    </div>`;
}

function toggleSave() {
  const { part, sentence } = reader.tokens[reader.selected];
  const g = part.gloss;
  if (!g) return;
  if (store.isSaved(g.lemma)) {
    const card = store.state.cards[g.lemma];
    if (card.srs.reps > 0 && !confirm(`Remove "${g.lemma}" from your flashcards? Its review history will be lost.`)) return;
    store.removeCard(g.lemma);
  } else {
    const members = part.members || [part];
    const context = [];
    for (const p of sentence.parts) {
      const hi = members.includes(p) ? 1 : 0;
      const lastSeg = context[context.length - 1];
      if (lastSeg && !hi && !lastSeg[1]) lastSeg[0] += p.text;
      else context.push([p.text, hi]);
    }
    store.addCard({
      lemma: g.lemma,
      en: g.en,
      note: g.note,
      form: part.head || part.text,
      context,
      contextEn: sentence.en,
      bookId: reader.bookId,
      chapter: reader.ci,
    });
  }
  reader.tokens.forEach((tok, i) => {
    const on = !!tok.part.gloss && store.isSaved(tok.part.gloss.lemma);
    $(`.w[data-i="${i}"]`, app)?.classList.toggle('saved', on);
  });
  renderWordSheet();
  updateBadge();
}

function openSheet() {
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  syncSheetPadding();
}

function closeSheet() {
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  document.body.style.paddingBottom = '';
  $$('.w.sel', app).forEach((el) => el.classList.remove('sel'));
  if (reader) reader.selected = -1;
}

// Leave room under the text so the sheet never hides the last lines.
function syncSheetPadding() {
  if (sheet.classList.contains('open')) document.body.style.paddingBottom = `${sheet.offsetHeight + 16}px`;
}
new ResizeObserver(syncSheetPadding).observe(sheet);

function keepVisible(el) {
  if (!el) return;
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    const bottomLimit = window.innerHeight - sheet.offsetHeight - 24;
    if (r.bottom > bottomLimit) window.scrollBy({ top: r.bottom - bottomLimit + 32, behavior: 'smooth' });
    else if (r.top < 72) window.scrollBy({ top: r.top - 96, behavior: 'smooth' });
  });
}

function setFontSize(delta) {
  settings.fontSize = Math.min(32, Math.max(15, settings.fontSize + delta));
  store.save();
  $('.reader', app)?.style.setProperty('--reader-size', `${settings.fontSize}px`);
}

let scrollTimer;
window.addEventListener(
  'scroll',
  () => {
    if (view !== 'read' || !reader) return;
    clearTimeout(scrollTimer);
    const { bookId, ci } = reader;
    scrollTimer = setTimeout(() => {
      if (!reader || reader.bookId !== bookId || reader.ci !== ci) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      store.setProgress(bookId, ci, max > 0 ? Math.min(1, window.scrollY / max) : 0);
    }, 400);
  },
  { passive: true },
);

// ---------- review ----------

function showReview() {
  ++renderId;
  const now = Date.now();
  const { next, counts } = queue(now);
  updateBadge(counts);
  const all = store.cardList();

  if (!all.length) {
    app.innerHTML = `
      <h1 class="page-title">Review</h1>
      <div class="panel empty-state">
        <p><strong>No flashcards yet.</strong></p>
        <p>While reading, tap a word and choose <em>Save word</em>. It will show up here with the sentence you found it in.</p>
        <a class="btn primary" href="#/">Go to the library</a>
      </div>`;
    return;
  }

  if (!next) {
    const upcoming = all
      .filter((c) => c.srs.state !== 'new')
      .map((c) => c.srs.due)
      .sort((a, b) => a - b)[0];
    app.innerHTML = `
      <h1 class="page-title">Review</h1>
      <div class="panel empty-state">
        <p class="big-emoji" aria-hidden="true">✓</p>
        <p><strong>All done for now.</strong></p>
        ${upcoming ? `<p class="muted">Next card is due in ${formatInterval(upcoming - now)}.</p>` : ''}
        ${
          counts.waitingNew
            ? `<p class="muted">${counts.waitingNew} new word${counts.waitingNew === 1 ? ' is' : 's are'} waiting. You can raise the daily limit (now ${settings.newPerDay}) under <a href="#/words">Words</a>.</p>`
            : ''
        }
        <a class="btn" href="#/">Keep reading</a>
      </div>`;
    return;
  }

  review = { card: next, revealed: false, counts };
  renderCard();
  if (settings.autoSpeak) say(next.lemma);
}

function renderCard() {
  const { card: c, revealed, counts } = review;
  const now = Date.now();
  const options = revealed ? preview(c.srs, now) : null;
  const ctx = (c.context || []).map(([text, hi]) => (hi ? `<mark>${esc(text)}</mark>` : esc(text))).join('');
  app.innerHTML = `
    <div class="review">
      <div class="review-counts" aria-label="Cards left">
        <span class="count c-new"><b>${counts.new}</b> new</span>
        <span class="count c-learn"><b>${counts.learning}</b> learning</span>
        <span class="count c-due"><b>${counts.review}</b> to review</span>
      </div>
      <section class="flashcard${revealed ? ' revealed' : ''}">
        <button class="card-word" data-act="say" data-text="${esc(c.lemma)}" aria-label="Pronounce ${esc(c.lemma)}">
          <span lang="de">${esc(c.lemma)}</span>${ICON.speaker}
        </button>
        <p class="card-context" lang="de">${ctx}</p>
        ${
          revealed
            ? `<hr><p class="card-en">${esc(c.en)}</p>
               ${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}
               <p class="card-context-en">${esc(c.contextEn)}</p>`
            : ''
        }
      </section>
      <div class="review-actions">
        ${
          revealed
            ? GRADES.map(
                (g) => `<button class="grade g${g}" data-act="grade" data-g="${g}">
                  <span>${GRADE_NAMES[g]}</span><small>${formatInterval(options[g].due - now)}</small>
                </button>`,
              ).join('')
            : '<button class="btn primary big" data-act="reveal">Show answer</button>'
        }
      </div>
      <p class="hint small center">Did you remember the meaning? Be honest: “Again” brings it back in a minute.
        <span class="kbd-only">Keys: Space = show answer, 1–4 = grade.</span></p>
    </div>`;
}

function reveal() {
  if (!review || review.revealed) return;
  review.revealed = true;
  renderCard();
}

function grade(g) {
  if (!review?.revealed) return;
  const c = review.card;
  const now = Date.now();
  if (c.srs.state === 'new') c.firstReview = now;
  c.srs = preview(c.srs, now)[g];
  store.save();
  showReview();
}

// ---------- words & settings ----------

function dueText(c) {
  if (c.srs.state === 'new') return 'new';
  const ms = c.srs.due - Date.now();
  return ms <= 0 ? 'due now' : `next review in ${formatInterval(ms)}`;
}

function voiceOptions() {
  const voices = speech.germanVoices();
  if (!voices.length) return '<option value="">No German voice found</option>';
  return [
    `<option value="">Automatic (best available)</option>`,
    ...voices.map(
      (v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.voice ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`,
    ),
  ].join('');
}

function showWords() {
  ++renderId;
  const cards = store.cardList().sort((a, b) => b.created - a.created);
  const noVoice = !speech.supported() || !speech.germanVoices().length;
  app.innerHTML = `
    <h1 class="page-title">Saved words <span class="muted">(${cards.length})</span></h1>
    ${cards.length ? '<input type="search" class="filter" placeholder="Filter words…" aria-label="Filter words" data-role="filter">' : ''}
    <ul class="word-list">
      ${
        cards
          .map(
            (c) => `<li data-search="${esc(`${c.lemma} ${c.en}`.toLowerCase())}">
              <button class="icon-btn" data-act="say" data-text="${esc(c.lemma)}" aria-label="Pronounce ${esc(c.lemma)}">${ICON.speaker}</button>
              <div class="word-main">
                <span><span class="lemma" lang="de">${esc(c.lemma)}</span> <span class="en">${esc(c.en)}</span></span>
                <span class="muted small">${esc(dueText(c))}</span>
              </div>
              <button class="icon-btn danger" data-act="delete" data-lemma="${esc(c.lemma)}" aria-label="Delete ${esc(c.lemma)}">${ICON.trash}</button>
            </li>`,
          )
          .join('') || '<li class="empty">No saved words yet. While reading, tap a word and choose “Save word”.</li>'
      }
    </ul>

    <section class="panel settings">
      <h2>Pronunciation</h2>
      <label class="field">Voice
        <select data-role="voice" id="voice-select">${voiceOptions()}</select>
      </label>
      <p class="hint small" id="voice-help" ${noVoice ? '' : 'hidden'}>
        This browser has no German voice. On Windows: Settings → Time &amp; language → Speech → Add voices → German.
        Microsoft Edge and Chrome on Android usually include good German voices.
      </p>
      <label class="field">Speed <span class="muted" id="rate-value">${settings.rate.toFixed(2)}×</span>
        <input type="range" min="0.5" max="1.2" step="0.05" value="${settings.rate}" data-role="rate">
      </label>
      <label class="check"><input type="checkbox" data-role="autospeak" ${settings.autoSpeak ? 'checked' : ''}>
        Pronounce words automatically when I tap them</label>
      <button class="btn" data-act="test-voice">${ICON.speaker} Test voice</button>
    </section>

    <section class="panel settings">
      <h2>Flashcards</h2>
      <label class="field">New words per day
        <input type="number" min="1" max="500" value="${settings.newPerDay}" data-role="newPerDay">
      </label>
    </section>

    <section class="panel settings">
      <h2>Backup</h2>
      <p class="hint small">Your words are stored in this browser only. Export a backup to keep them safe or to move them to another device.</p>
      <div class="button-row">
        <button class="btn" data-act="export">Export backup</button>
        <label class="btn">Import backup<input type="file" accept=".json,application/json" data-role="import" hidden></label>
        <button class="btn" data-act="export-anki" ${cards.length ? '' : 'disabled'}>Export for Anki (CSV)</button>
      </div>
    </section>`;
}

speech.onVoicesChanged(() => {
  if (view !== 'words') return;
  const sel = $('#voice-select');
  if (sel) sel.innerHTML = voiceOptions();
  const help = $('#voice-help');
  if (help) help.hidden = speech.germanVoices().length > 0;
});

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const today = () => new Date().toISOString().slice(0, 10);

function ankiCsv() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = ['#separator:Comma', '#html:true', '#columns:German,English,Sentence,Sentence (English),Note'];
  for (const c of store.cardList()) {
    const sentence = (c.context || []).map(([t, hi]) => (hi ? `<b>${esc(t)}</b>` : esc(t))).join('');
    lines.push([c.lemma, c.en, sentence, c.contextEn, c.note].map(q).join(','));
  }
  return lines.join('\n');
}

// ---------- events ----------

function handleAction(act, el) {
  switch (act) {
    case 'say':
      return say(el.dataset.text);
    case 'close':
      return closeSheet();
    case 'toggle-save':
      return toggleSave();
    case 'say-sentence':
      return say(reader?.tokens[reader.selected]?.sentence.de);
    case 'toggle-en': {
      const s = reader?.tokens[reader.selected]?.sentence;
      reader.enOpenFor = reader.enOpenFor === s ? null : s;
      return renderWordSheet();
    }
    case 'font-down':
      return setFontSize(-2);
    case 'font-up':
      return setFontSize(2);
    case 'reveal':
      return reveal();
    case 'grade':
      return grade(Number(el.dataset.g));
    case 'delete': {
      const lemma = el.dataset.lemma;
      if (!confirm(`Delete "${lemma}" from your flashcards?`)) return;
      store.removeCard(lemma);
      updateBadge();
      return showWords();
    }
    case 'test-voice':
      return say('Guten Tag! Ich lese gern Märchen auf Deutsch.');
    case 'export':
      return download(`leseecke-backup-${today()}.json`, store.exportData(), 'application/json');
    case 'export-anki':
      return download(`leseecke-anki-${today()}.csv`, ankiCsv(), 'text/csv');
  }
}

app.addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  if (actEl) return handleAction(actEl.dataset.act, actEl);
  if (view !== 'read') return;
  const w = e.target.closest('.w');
  if (w) selectWord(Number(w.dataset.i));
  else if (!e.target.closest('a, button, input, select, label')) closeSheet();
});

sheet.addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  if (actEl) handleAction(actEl.dataset.act, actEl);
});

app.addEventListener('input', (e) => {
  const role = e.target.dataset.role;
  if (role === 'filter') {
    const q = e.target.value.trim().toLowerCase();
    $$('.word-list li[data-search]', app).forEach((li) => (li.hidden = !!q && !li.dataset.search.includes(q)));
  } else if (role === 'rate') {
    settings.rate = Number(e.target.value);
    $('#rate-value').textContent = `${settings.rate.toFixed(2)}×`;
    store.save();
  }
});

app.addEventListener('change', async (e) => {
  const role = e.target.dataset.role;
  if (role === 'voice') {
    settings.voice = e.target.value;
    store.save();
    say('Hallo! So klinge ich.');
  } else if (role === 'autospeak') {
    settings.autoSpeak = e.target.checked;
    store.save();
  } else if (role === 'newPerDay') {
    settings.newPerDay = Math.min(500, Math.max(1, Number(e.target.value) || 20));
    store.save();
    updateBadge();
  } else if (role === 'import') {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { added, updated } = store.importData(await file.text());
      alert(`Backup imported: ${added} new word${added === 1 ? '' : 's'}, ${updated} updated.`);
    } catch (err) {
      alert(`Could not import this file: ${err.message}`);
    }
    updateBadge();
    showWords();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'Escape') return closeSheet();
  if (view !== 'review' || !review) return;
  if (!review.revealed && (e.key === ' ' || e.key === 'Enter')) {
    if (e.target.closest('button, a')) return; // let the focused control handle it
    e.preventDefault();
    reveal();
  } else if (review.revealed && ['1', '2', '3', '4'].includes(e.key)) {
    grade(Number(e.key));
  }
});

window.addEventListener('hashchange', route);

// ---------- start ----------

async function init() {
  try {
    await loadBooks();
  } catch (e) {
    const fileHint =
      location.protocol === 'file:'
        ? '<p>This page was opened as a file. It needs a small web server: open a terminal in this folder and run <code>python -m http.server 8765</code>, then go to <a href="http://localhost:8765">http://localhost:8765</a>.</p>'
        : '';
    app.innerHTML = `<div class="panel error"><h2>Could not load the books</h2><p>${esc(e.message)}</p>${fileHint}</div>`;
    return;
  }
  route();
  updateBadge();
  // Offline support only over https (a deployed copy); during local development it just gets in the way.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }
}

init();
