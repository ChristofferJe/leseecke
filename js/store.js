// Everything the app remembers lives in one localStorage entry on this device.
// Use Words → Backup to move it to another device or browser.

import { newSrs } from './srs.js';

const KEY = 'leseecke:v1';

const DEFAULT_SETTINGS = {
  autoSpeak: true, // pronounce a word when it is tapped
  rate: 0.9, // speech speed
  voices: {}, // language code -> voiceURI of the chosen voice (missing or '' = automatic)
  newPerDay: 20, // new flashcards introduced per day
  fontSize: 21, // reader text size in px
  levels: {}, // language code -> the level picked most recently (the default for other books)
  language: '', // the language the library shows ('' = the first one)
};

export const state = load();

function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY));
  } catch {
    saved = null;
  }
  const settings = { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) };
  // Versions before French had one German voice and one level.
  settings.voices = { ...settings.voices };
  settings.levels = { ...settings.levels };
  if (settings.voice !== undefined) {
    settings.voices.de ??= settings.voice;
    delete settings.voice;
  }
  if (settings.level !== undefined) {
    if (settings.level) settings.levels.de ??= settings.level;
    delete settings.level;
  }
  return {
    cards: saved?.cards ?? {},
    progress: saved?.progress ?? {},
    choices: saved?.choices ?? {}, // book id -> edition id (the level chosen for that book)
    settings,
  };
}

let persistAsked = false;
export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save to localStorage', e);
  }
  // Ask the browser not to evict our data when storage runs low (mainly mobile).
  if (!persistAsked && navigator.storage?.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
}

// Cards are stored by lemma. German cards (the first language) use the bare lemma; other
// languages get a prefix, so French "hier" (yesterday) and German "hier" (here) stay apart.
export const cardKey = (lang, lemma) => (!lang || lang === 'de' ? lemma : `${lang}:${lemma}`);
export const cardLang = (card) => card.lang || 'de';
export const cardList = () => Object.values(state.cards);
export const getCard = (lang, lemma) => state.cards[cardKey(lang, lemma)];
export const isSaved = (lang, lemma) => Object.prototype.hasOwnProperty.call(state.cards, cardKey(lang, lemma));

export function addCard({ lang, lemma, en, note, form, context, contextEn, bookId, chapter }) {
  const key = cardKey(lang, lemma);
  if (state.cards[key]) return state.cards[key];
  const card = {
    id: key,
    lang: lang || 'de',
    lemma,
    en,
    note: note || '',
    form,
    context, // [[text, highlighted?], …] — the sentence the word was saved from
    contextEn,
    bookId,
    chapter,
    created: Date.now(),
    firstReview: 0,
    srs: newSrs(),
  };
  state.cards[key] = card;
  save();
  return card;
}

export function removeCard(key) {
  delete state.cards[key];
  save();
}

export function setProgress(bookId, chapter, scroll) {
  state.progress[bookId] = { chapter, scroll, at: Date.now() };
  save();
}

export function exportData() {
  return JSON.stringify({ app: 'leseecke', version: 1, exported: new Date().toISOString(), ...state }, null, 2);
}

// Merges a backup into the current data. Keeps whichever copy of a card has been reviewed more.
export function importData(json) {
  const data = JSON.parse(json);
  if (!data || typeof data.cards !== 'object') throw new Error('This file is not a Leseecke backup.');
  let added = 0;
  let updated = 0;
  for (const card of Object.values(data.cards)) {
    if (!card?.lemma || !card.srs) continue;
    const key = cardKey(card.lang, card.lemma);
    const mine = state.cards[key];
    if (!mine) added++;
    else if ((card.srs.reps || 0) > (mine.srs.reps || 0)) updated++;
    else continue;
    state.cards[key] = { ...card, id: key };
  }
  for (const [bookId, p] of Object.entries(data.progress || {})) {
    if (!state.progress[bookId] || (p.at || 0) > (state.progress[bookId].at || 0)) state.progress[bookId] = p;
  }
  save();
  return { added, updated };
}
