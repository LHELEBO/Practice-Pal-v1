// beat-grid.js — where the beats are, in TRACK time (seconds from the start of the file).
// Everything that needs beat positions asks this file, never does BPM math itself.
// Later, a beat map (a list of real beat times for music that drifts) can replace the
// fixed grid here without changing the metronome or the UI.

const MAX_BEATS = 2000; // safety cap for very wide ranges

// grid = { bpm, offset, beatsPerBar }; offset = time of a beat 1 (the downbeat), in seconds.
export function beatPeriod(grid) {
  return grid.bpm > 0 ? 60 / grid.bpm : 0;
}

// Every beat with a <= time < b, in order: { time, index, downbeat }.
// index counts beats from the offset (0 = the beat at `offset`; negative before it).
export function beatsBetween(grid, a, b) {
  const period = beatPeriod(grid);
  const out = [];
  if (!(period > 0) || !(b > a)) return out;
  const bar = Math.max(1, Math.round(grid.beatsPerBar || 4));

  let n = Math.ceil((a - grid.offset) / period - 1e-9);
  for (let k = 0; k < MAX_BEATS; k++, n++) {
    const time = grid.offset + n * period;
    if (time >= b) break;
    if (time < a) continue;
    out.push({ time, index: n, downbeat: ((n % bar) + bar) % bar === 0 });
  }
  return out;
}