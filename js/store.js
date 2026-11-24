// Everything the app remembers lives in one localStorage entry on this device.
// Use Words → Backup to move it to another device or browser.

import { newSrs } from './srs.js';

const KEY = 'leseecke:v1';

const DEFAULT_SETTINGS = {
  autoSpeak: true, // pronounce a word when it is tapped
  rate: 0.9, // speech speed
  voice: '', // voiceURI of the chosen German voice ('' = automatic)
  newPerDay: 20, // new flashcards introduced per day
  fontSize: 21, // reader text size in px
  level: '', // the level the reader picked most recently (used as the default for other books)
};

export const state = load();

function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY));
  } catch {
    saved = null;
  }
  return {
    cards: saved?.cards ?? {},
    progress: saved?.progress ?? {},
    choices: saved?.choices ?? {}, // book id -> edition id (the level chosen for that book)
    settings: { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) },
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

export const cardList = () => Object.values(state.cards);
export const isSaved = (lemma) => Object.prototype.hasOwnProperty.call(state.cards, lemma);

export function addCard({ lemma, en, note, form, context, contextEn, bookId, chapter }) {
  if (isSaved(lemma)) return state.cards[lemma];
  const card = {
    id: lemma,
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
  state.cards[lemma] = card;
  save();
  return card;
}

export function removeCard(lemma) {
  delete state.cards[lemma];
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
    const mine = state.cards[card.lemma];
    if (!mine) added++;
    else if ((card.srs.reps || 0) > (mine.srs.reps || 0)) updated++;
    else continue;
    state.cards[card.lemma] = card;
  }
  for (const [bookId, p] of Object.entries(data.progress || {})) {
    if (!state.progress[bookId] || (p.at || 0) > (state.progress[bookId].at || 0)) state.progress[bookId] = p;
  }
  save();
  return { added, updated };
}
