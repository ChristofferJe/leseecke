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
  download: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
};

// Offline support runs on the deployed https site. On localhost add "?sw=1" to test it.
const useServiceWorker =
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || (location.hostname === 'localhost' && /[?&]sw\b/.test(location.search)));

const app = $('#app');
const sheet = $('#sheet');
const sheetInner = $('#sheet-inner');
const settings = store.state.settings;

// A "work" is a book (e.g. Grimms Märchen). It has one or more "editions", one per level,
// each in its own folder books/<edition id>/. Most of the app works with an edition's
// metadata: the work's fields plus the edition's id, level and chapters.
let works = [];
const editions = new Map(); // edition id -> { ...work, ...edition, work, workId }
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const levelRank = (level) => LEVELS.indexOf(level);

const bookCache = new Map();
let sharedGlossary = null;
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

async function loadLibrary() {
  works = JSON.parse(await fetchText('books/library.json'));
  editions.clear();
  for (const work of works) {
    work.editions.sort((a, b) => levelRank(a.level) - levelRank(b.level));
    for (const ed of work.editions) editions.set(ed.id, { ...work, ...ed, work, workId: work.id });
  }
}

const findWork = (id) => works.find((w) => w.id === id);

// The glossary shared by all books (common words); each edition can add or override entries.
function loadSharedGlossary() {
  sharedGlossary ??= fetchText('books/glossary.txt')
    .then((text) => parseGlossary(text).glossary)
    .catch((err) => {
      sharedGlossary = null;
      throw err;
    });
  return sharedGlossary;
}

async function loadBook(id) {
  if (bookCache.has(id)) return bookCache.get(id);
  const meta = editions.get(id);
  if (!meta) throw new Error(`There is no book called "${id}".`);
  const [shared, glossText, ...texts] = await Promise.all([
    loadSharedGlossary(),
    fetchText(`books/${id}/glossary.txt`),
    ...meta.chapters.map((f) => fetchText(`books/${id}/${f}`)),
  ]);
  const glossary = new Map([...shared, ...parseGlossary(glossText).glossary]);
  const chapters = texts.map((t) => {
    const { chapter } = parseChapter(t);
    annotateChapter(chapter, glossary);
    return chapter;
  });
  const book = { meta, chapters };
  bookCache.set(id, book);
  return book;
}

// ---------- offline downloads (one cache per book; served by sw.js) ----------

// A downloaded book keeps every level on the device. Each level is stored in its own cache
// ("leseecke-book-<edition id>"), which sw.js serves from when the device is offline.
const bookCacheName = (editionId) => `leseecke-book-${editionId}`;
const canDownload = () => useServiceWorker && 'caches' in window;
const editionFiles = (ed) => [`books/${ed.id}/glossary.txt`, ...ed.chapters.map((f) => `books/${ed.id}/${f}`)];
const downloading = new Map(); // work id -> { done, total }
const autoCompleted = new Set(); // works topped up automatically this session

async function downloadStatus(work) {
  if (!canDownload()) return 'unsupported';
  if (downloading.has(work.id)) return 'downloading';
  let have = 0;
  let total = 0;
  for (const ed of work.editions) {
    const files = editionFiles(ed);
    total += files.length;
    if (!(await caches.has(bookCacheName(ed.id)))) continue;
    const cache = await caches.open(bookCacheName(ed.id));
    for (const f of files) if (await cache.match(f)) have++;
  }
  return have === 0 ? 'none' : have === total ? 'downloaded' : 'partial';
}

async function downloadWork(work, { quiet = false } = {}) {
  if (!work || downloading.has(work.id)) return;
  const jobs = work.editions.flatMap((ed) => editionFiles(ed).map((f) => [ed.id, f]));
  const progress = { done: 0, total: jobs.length };
  downloading.set(work.id, progress);
  refreshDownloadUi();
  try {
    // Fetch everything first, then store it all, so a dropped connection never leaves half a book.
    const fetched = [];
    for (const [edId, f] of jobs) {
      const res = await fetch(f, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${f} (${res.status})`);
      fetched.push([edId, f, res]);
      progress.done++;
      refreshDownloadUi();
    }
    for (const [edId, f, res] of fetched) await (await caches.open(bookCacheName(edId))).put(f, res);
    navigator.storage?.persist?.().catch(() => {});
  } catch (err) {
    if (!quiet) alert(`Could not download "${work.title}". Check your internet connection and try again.\n\n${err.message}`);
  } finally {
    downloading.delete(work.id);
    refreshDownloadUi();
  }
}

async function removeDownload(work) {
  if (!work) return;
  const levels = work.editions.length > 1 ? ' (all levels)' : '';
  const ok = confirm(
    `Remove the downloaded copy of "${work.title}"${levels} from this device?\n\nYou can still read it when you are online and download it again at any time. Your saved words and reading position are kept.`,
  );
  if (!ok) return;
  for (const ed of work.editions) await caches.delete(bookCacheName(ed.id));
  autoCompleted.add(work.id);
  refreshDownloadUi();
}

function downloadControl(work, status) {
  const id = esc(work.id);
  const all = work.editions.length > 1 ? ` (${work.editions.map((e) => e.level).join(', ')})` : '';
  switch (status) {
    case 'unsupported':
      return '';
    case 'downloading': {
      const p = downloading.get(work.id);
      return `<span class="dl-state">${ICON.download} Downloading… ${p ? `${p.done}/${p.total}` : ''}</span>`;
    }
    case 'downloaded':
      return `<span class="dl-state ok">${ICON.check} Downloaded${esc(all)}</span>
        <button class="btn small" data-act="remove-download" data-book="${id}" aria-label="Remove the download of ${esc(work.title)}">Remove</button>`;
    case 'partial':
      return `<button class="btn small" data-act="download" data-book="${id}">${ICON.download} Finish download</button>`;
    default:
      return navigator.onLine
        ? `<button class="btn small" data-act="download" data-book="${id}">${ICON.download} Download${esc(all)}</button>`
        : '<span class="dl-state warn">Not downloaded: needs internet</span>';
  }
}

// Fills every download slot on the current page with the book's current status.
// A downloaded book that has gained a level or chapter since is topped up automatically.
let dlRefresh = 0;
async function refreshDownloadUi() {
  const run = ++dlRefresh;
  for (const el of $$('[data-dl]', app)) {
    const work = findWork(el.dataset.dl);
    if (!work) continue;
    const status = await downloadStatus(work);
    if (run !== dlRefresh) return; // a newer refresh has started
    el.dataset.status = status;
    el.innerHTML = downloadControl(work, status);
    if (status === 'partial' && navigator.onLine && !autoCompleted.has(work.id)) {
      autoCompleted.add(work.id);
      downloadWork(work, { quiet: true });
    }
  }
}

const downloadSlot = (work) => `<div class="dl" data-dl="${esc(work.id)}"></div>`;

// ---------- levels ----------

// The level last chosen for this book, or else the one closest to the level the reader last used.
function chosenEdition(work) {
  const saved = store.state.choices[work.id];
  if (saved && work.editions.some((e) => e.id === saved)) return editions.get(saved);
  const want = levelRank(settings.level || 'A2');
  const best = [...work.editions].sort(
    (a, b) => Math.abs(levelRank(a.level) - want) - Math.abs(levelRank(b.level) - want) || levelRank(a.level) - levelRank(b.level),
  )[0];
  return editions.get(best.id);
}

function chooseEdition(meta) {
  store.state.choices[meta.workId] = meta.id;
  settings.level = meta.level;
  store.save();
}

// The most recent reading position in any level of this book.
function latestProgress(work) {
  let best = null;
  for (const ed of work.editions) {
    const p = store.state.progress[ed.id];
    if (p && (!best || (p.at || 0) > (best.at || 0))) best = { ...p, edition: editions.get(ed.id) };
  }
  return best;
}

function levelSwitch(meta, act) {
  if (meta.work.editions.length < 2) return '';
  return `<div class="levels" role="group" aria-label="Level">
    ${meta.work.editions
      .map(
        (e) => `<button class="level-btn${e.id === meta.id ? ' active' : ''}" data-act="${act}" data-edition="${esc(e.id)}"
          aria-pressed="${e.id === meta.id}" title="Read at level ${esc(e.level)}">${esc(e.level)}</button>`,
      )
      .join('')}
  </div>`;
}

function bookLoadError(err) {
  if (!navigator.onLine || err instanceof TypeError) {
    return new Error(
      'You are offline, and this book is not downloaded on this device. Connect to the internet to read it, and tap “Download” on the book to keep it available offline.',
    );
  }
  return err;
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

function cover(work) {
  return `<div class="cover" style="--cover:${esc(work.color || '#2f6f73')}">
    <span class="cover-title">${esc(work.title)}</span>
    <span class="cover-author">${esc(work.author)}</span>
    <span class="cover-levels">${work.editions.map((e) => `<span class="level">${esc(e.level)}</span>`).join('')}</span>
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
      ${works
        .map((w) => {
          const p = latestProgress(w);
          const ed = chosenEdition(w);
          const where = p
            ? `Continue at chapter ${p.chapter + 1} (${p.edition.level})`
            : `${ed.chapters.length} chapters`;
          return `<div class="book-card">
            <a class="book-link" href="#/book/${encodeURIComponent(w.id)}">
              ${cover(w)}
              <span class="book-info">
                <strong>${esc(w.title)}</strong>
                <span class="muted">${esc(w.titleEn || '')}</span>
                <span class="muted small">${esc(where)}</span>
              </span>
            </a>
            ${downloadSlot(w)}
          </div>`;
        })
        .join('')}
    </div>
    ${canDownload() ? '<p class="hint small">Download a book to read it without internet. Only downloaded books take up space on this device.</p>' : ''}
    <p class="hint">Want another book? Open this folder in Claude Code and ask, for example:
      <em>“Add Kafka's Die Verwandlung at A2.”</em> The steps are in <code>CLAUDE.md</code>.</p>`;
  refreshDownloadUi();
}

async function showBook(id) {
  const t = ++renderId;
  // Links from older versions point at an edition ("grimm-a2"): open its book at that level.
  if (!findWork(id) && editions.has(id)) {
    chooseEdition(editions.get(id));
    id = editions.get(id).workId;
  }
  const work = findWork(id);
  if (!work) return showError(new Error(`There is no book called "${id}".`));
  const meta = chosenEdition(work);
  app.innerHTML = loading();
  let book;
  try {
    book = await loadBook(meta.id);
  } catch (e) {
    return showError(bookLoadError(e));
  }
  if (t !== renderId) return;
  const { chapters } = book;
  const edId = encodeURIComponent(meta.id);
  const p = store.state.progress[meta.id];
  const start = p ? p.chapter : 0;
  const multi = work.editions.length > 1;
  app.innerHTML = `
    <a class="link-back" href="#/">${ICON.back} Library</a>
    <section class="book-head">
      ${cover(work)}
      <div>
        <h1>${esc(work.title)}</h1>
        <p class="muted">${esc(work.author)}${work.titleEn && work.titleEn !== work.title ? ` · ${esc(work.titleEn)}` : ''}</p>
        <p>${esc(work.description || '')}</p>
        <div class="level-row">
          <span class="level-label">${multi ? 'Level:' : `Level ${esc(meta.level)}`}</span>
          ${levelSwitch(meta, 'choose-level')}
        </div>
        <div class="book-actions">
          <a class="btn primary" href="#/read/${edId}/${start}">${p ? 'Continue reading' : 'Start reading'} (${esc(meta.level)})</a>
          ${downloadSlot(work)}
        </div>
      </div>
    </section>
    <h2 class="section-title">Chapters <span class="muted small">· ${esc(meta.level)}</span></h2>
    <ol class="toc">
      ${chapters
        .map(
          (c, i) => `<li><a href="#/read/${edId}/${i}">
            <span class="toc-num">${i + 1}</span>
            <span class="toc-title"><span lang="de">${esc(c.title)}</span><span class="muted">${esc(c.titleEn)}</span></span>
            <span class="muted small">${c.wordCount} words</span>
          </a></li>`,
        )
        .join('')}
    </ol>
    <p class="hint small">${esc(meta.source || work.source || '')}</p>`;
  refreshDownloadUi();
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
    return showError(bookLoadError(e));
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

  chooseEdition(book.meta);
  const enc = encodeURIComponent(bookId);
  const workLink = `#/book/${encodeURIComponent(book.meta.workId)}`;
  const last = book.chapters.length - 1;
  const prev = ci > 0 ? `<a class="btn" href="#/read/${enc}/${ci - 1}">← Previous</a>` : '<span></span>';
  const next =
    ci < last
      ? `<a class="btn primary" href="#/read/${enc}/${ci + 1}">Next: ${esc(book.chapters[ci + 1].title)} →</a>`
      : `<a class="btn primary" href="${workLink}">Finished! Back to the book</a>`;

  app.innerHTML = `
    <div class="reader-bar">
      <a class="link-back" href="${workLink}">${ICON.back} ${esc(book.meta.title)}</a>
      ${levelSwitch(book.meta, 'switch-level')}
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
      <div class="hint small" id="voice-help" ${noVoice ? '' : 'hidden'}>
        <p>This browser doesn't list a German voice. Tap <em>Test voice</em> anyway, because some phones still speak German.
          If you hear nothing, or an English accent, install a German voice. Then close the app completely and open it again
          (or restart the phone):</p>
        <ul>
          <li><strong>Android:</strong> Settings → search “Text-to-speech” → Preferred engine: <em>Speech Services by Google</em>
            → ⚙ → Install voice data → Deutsch (Deutschland). Adding German under “Languages” is not enough.</li>
          <li><strong>iPhone:</strong> Settings → Accessibility → Spoken Content → Voices → German.</li>
          <li><strong>Windows:</strong> Settings → Time &amp; language → Speech → Add voices → German, or use Microsoft Edge.</li>
        </ul>
      </div>
      <p class="hint small" id="voice-diag">${esc(voiceDiagnostics())}</p>
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

// Shows what the device reports, which makes voice problems easy to diagnose.
function voiceDiagnostics() {
  if (!speech.supported()) return 'This browser does not support text-to-speech.';
  const all = speech.allVoices();
  if (!all.length) return 'This browser reports no voices at all (yet).';
  const langs = [...new Set(all.map((v) => v.lang))].sort();
  const shown = langs.slice(0, 24).join(', ') + (langs.length > 24 ? ', …' : '');
  return `This browser reports ${all.length} voice${all.length === 1 ? '' : 's'}, ${speech.germanVoices().length} of them German. Languages: ${shown}.`;
}

function updateVoiceUi() {
  if (view !== 'words') return;
  const sel = $('#voice-select');
  if (sel) sel.innerHTML = voiceOptions();
  const help = $('#voice-help');
  if (help) help.hidden = speech.germanVoices().length > 0;
  const diag = $('#voice-diag');
  if (diag) diag.textContent = voiceDiagnostics();
}
speech.onVoicesChanged(updateVoiceUi);

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
      say('Guten Tag! Ich lese gern Märchen auf Deutsch.');
      setTimeout(updateVoiceUi, 1000); // some phones only load their voice list after the first use
      return;
    case 'export':
      return download(`leseecke-backup-${today()}.json`, store.exportData(), 'application/json');
    case 'export-anki':
      return download(`leseecke-anki-${today()}.csv`, ankiCsv(), 'text/csv');
    case 'download':
      return downloadWork(findWork(el.dataset.book));
    case 'remove-download':
      return removeDownload(findWork(el.dataset.book));
    case 'choose-level': {
      const meta = editions.get(el.dataset.edition);
      if (!meta) return;
      chooseEdition(meta);
      return showBook(meta.workId);
    }
    case 'switch-level': {
      // Same chapter at the other level (the levels of a book share their chapter order).
      const meta = editions.get(el.dataset.edition);
      if (!meta || !reader) return;
      chooseEdition(meta);
      location.hash = `#/read/${encodeURIComponent(meta.id)}/${Math.min(reader.ci, meta.chapters.length - 1)}`;
      return;
    }
  }
}

window.addEventListener('online', refreshDownloadUi);
window.addEventListener('offline', refreshDownloadUi);

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
    await loadLibrary();
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
  if (useServiceWorker) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }
}

init();
