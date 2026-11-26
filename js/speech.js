// Pronunciation with the browser's built-in text-to-speech (free, works offline with most
// system voices). Quality depends on the voices installed on the device.

import { language } from './languages.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
const listeners = new Set();

// The list is read fresh every time: some phones fill it in late, or never fire "voiceschanged".
export const allVoices = () => (synth ? synth.getVoices() : []);

// Phones report a language as "de-DE", "de_DE" or "deu-DEU"; some only say so in the voice name.
function speaks(v, lang) {
  const { voiceCodes, voiceNames } = language(lang);
  const code = (v.lang || '').toLowerCase().split(/[-_]/)[0];
  return voiceCodes.includes(code) || !!voiceNames?.test(v.name || '');
}
export const voicesFor = (lang) => allVoices().filter((v) => speaks(v, lang));

if (synth) {
  synth.getVoices(); // asks the browser to start loading its voice list
  synth.addEventListener?.('voiceschanged', () => listeners.forEach((fn) => fn()));
}

export const supported = () => !!synth;
export const onVoicesChanged = (fn) => listeners.add(fn);

// Natural/online voices sound much better than the old robotic ones, so prefer them.
function pickVoice(lang, voiceURI) {
  const voices = voicesFor(lang);
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen) return chosen;
  }
  const main = language(lang).speech.toLowerCase().replace('_', '-');
  const score = (v) =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 4 : 0) +
    (/google/i.test(v.name) ? 3 : 0) +
    ((v.lang || '').toLowerCase().replace('_', '-') === main ? 1 : 0);
  return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}

export function speak(text, { lang = 'de', rate = 0.9, voice = '' } = {}) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = language(lang).speech;
  const v = pickVoice(lang, voice);
  if (v) u.voice = v;
  u.rate = rate;
  synth.speak(u);
}
