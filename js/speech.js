// German pronunciation with the browser's built-in text-to-speech (free, works offline
// with most system voices). Quality depends on the voices installed on the device.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
let voices = [];
const listeners = new Set();

function refresh() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang));
  listeners.forEach((fn) => fn(voices));
}
if (synth) {
  refresh();
  synth.addEventListener?.('voiceschanged', refresh);
}

export const supported = () => !!synth;
export const germanVoices = () => voices;
export const onVoicesChanged = (fn) => listeners.add(fn);

// Natural/online voices sound much better than the old robotic ones, so prefer them.
function pickVoice(voiceURI) {
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
