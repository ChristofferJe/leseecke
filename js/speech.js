// German pronunciation with the browser's built-in text-to-speech (free, works offline
// with most system voices). Quality depends on the voices installed on the device.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
const listeners = new Set();

// The list is read fresh every time: some phones fill it in late, or never fire "voiceschanged".
export const allVoices = () => (synth ? synth.getVoices() : []);
// Phones report German as "de-DE", "de_DE" or "deu-DEU"; some only say so in the voice name.
const isGerman = (v) => /^(de|deu|ger)([-_]|$)/i.test(v.lang || '') || /german|deutsch/i.test(v.name || '');
export const germanVoices = () => allVoices().filter(isGerman);

if (synth) {
  synth.getVoices(); // asks the browser to start loading its voice list
  synth.addEventListener?.('voiceschanged', () => listeners.forEach((fn) => fn()));
}

export const supported = () => !!synth;
export const onVoicesChanged = (fn) => listeners.add(fn);

// Natural/online voices sound much better than the old robotic ones, so prefer them.
function pickVoice(voiceURI) {
  const voices = germanVoices();
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen) return chosen;
  }
  const score = (v) =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 4 : 0) +
    (/google/i.test(v.name) ? 3 : 0) +
    (/de[-_]DE/i.test(v.lang) ? 1 : 0);
  return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}

export function speak(text, { rate = 0.9, voice = '' } = {}) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const v = pickVoice(voice);
  if (v) u.voice = v;
  u.rate = rate;
  synth.speak(u);
}
