// Spaced repetition scheduler based on FSRS-5 (the algorithm used by modern Anki),
// with default parameters and short learning steps for new and forgotten words.
//
// A card's `srs` object: { state: 'new'|'learning'|'review'|'relearning', s, d, due, last, reps, lapses }
//   s = stability in days (how long until recall probability drops to 90%)
//   d = difficulty, 1 (easy) … 10 (hard)

const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const RETENTION = 0.9;

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const GRADES = [1, 2, 3, 4]; // Again, Hard, Good, Easy
export const GRADE_NAMES = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

const clampD = (d) => Math.min(10, Math.max(1, d));
const initS = (g) => Math.max(W[g - 1], 0.1);
const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
const retrievability = (days, s) => Math.pow(1 + (FACTOR * days) / s, DECAY);

function nextD(d, g) {
  const dp = d - W[6] * (g - 3) * ((10 - d) / 9);
  return clampD(W[7] * initD(4) + (1 - W[7]) * dp);
}
function recallS(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}
function forgetS(d, s, r) {
  return Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]));
}
const shortTermS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

const intervalDays = (s) => {
  const days = (s / FACTOR) * (Math.pow(RETENTION, 1 / DECAY) - 1);
  return Math.min(36500, Math.max(1, Math.round(days)));
};

export const newSrs = () => ({ state: 'new', s: 0, d: 0, due: 0, last: 0, reps: 0, lapses: 0 });
export const isLearning = (srs) => srs.state === 'learning' || srs.state === 'relearning';

// Returns the next state for every grade, so the buttons can show their intervals.
export function preview(srs, now = Date.now()) {
  const out = {};
  const base = { ...srs, reps: (srs.reps || 0) + 1, last: now };

  if (srs.state === 'new') {
    for (const g of GRADES) out[g] = { ...base, s: initS(g), d: initD(g) };
    out[1] = { ...out[1], state: 'learning', due: now + 1 * MINUTE };
    out[2] = { ...out[2], state: 'learning', due: now + 6 * MINUTE };
    out[3] = { ...out[3], state: 'learning', due: now + 10 * MINUTE };
    out[4] = { ...out[4], state: 'review', due: now + intervalDays(out[4].s) * DAY };
    return out;
  }

  const elapsedDays = Math.max(0, (now - srs.last) / DAY);
  const sameDay = elapsedDays < 1;
  const r = retrievability(elapsedDays, srs.s);

  if (isLearning(srs)) {
    for (const g of GRADES) {
      const s = sameDay ? shortTermS(srs.s, g) : g === 1 ? forgetS(srs.d, srs.s, r) : recallS(srs.d, srs.s, r, g);
      out[g] = { ...base, s, d: nextD(srs.d, g) };
    }
    out[1] = { ...out[1], state: srs.state, due: now + 1 * MINUTE };
    out[2] = { ...out[2], state: srs.state, due: now + 6 * MINUTE };
    const good = intervalDays(out[3].s);
    const easy = Math.max(intervalDays(out[4].s), good + 1);
    out[3] = { ...out[3], state: 'review', due: now + good * DAY };
    out[4] = { ...out[4], state: 'review', due: now + easy * DAY };
    return out;
  }

  // Review card
  out[1] = {
    ...base,
    s: forgetS(srs.d, srs.s, r),
    d: nextD(srs.d, 1),
    state: 'relearning',
    lapses: (srs.lapses || 0) + 1,
    due: now + 10 * MINUTE,
  };
  const s2 = recallS(srs.d, srs.s, r, 2);
  const s3 = recallS(srs.d, srs.s, r, 3);
  const s4 = recallS(srs.d, srs.s, r, 4);
  let hard = intervalDays(s2);
  let good = intervalDays(s3);
  let easy = intervalDays(s4);
  hard = Math.min(hard, good);
  good = Math.max(good, hard + 1);
  easy = Math.max(easy, good + 1);
  out[2] = { ...base, s: s2, d: nextD(srs.d, 2), state: 'review', due: now + hard * DAY };
  out[3] = { ...base, s: s3, d: nextD(srs.d, 3), state: 'review', due: now + good * DAY };
  out[4] = { ...base, s: s4, d: nextD(srs.d, 4), state: 'review', due: now + easy * DAY };
  return out;
}

export function formatInterval(ms) {
  const min = ms / MINUTE;
  if (min < 1) return '<1 min';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${(d / 365).toFixed(1)} y`;
}
