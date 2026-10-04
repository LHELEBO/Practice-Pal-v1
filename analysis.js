// Tempo + first-beat estimate. Pure function (no DOM / Web Audio) so it is easy to test,
// move into a Web Worker, or swap for essentia.js behind the same signature:
//   analyzeBeats(samples: Float32Array, sampleRate) -> { bpm, firstBeat, confidence } | null
//
// Method: log-energy novelty -> autocorrelation for the beat period (with a mild prior toward
// ~120 BPM) -> comb-filter phase search for the first beat.
export function analyzeBeats(samples, sampleRate, { maxSeconds = 90, minBpm = 60, maxBpm = 200 } = {}) {
  const hop = 256, win = 512;
  const n = Math.min(samples.length, Math.floor(maxSeconds * sampleRate));
  const frames = Math.floor((n - win) / hop);
  if (frames < 200) return null;
  const fps = sampleRate / hop;

  // Novelty: positive change in log energy.
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const base = f * hop;
    for (let i = 0; i < win; i++) { const x = samples[base + i]; e += x * x; }
    env[f] = Math.log(1 + 1000 * (e / win));
  }
  const nov = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f++) { nov[f] = Math.max(0, env[f] - env[f - 1]); mean += nov[f]; }
  mean /= frames;
  for (let f = 0; f < frames; f++) nov[f] -= mean;

  // Autocorrelation over the plausible beat-period range.
  const lagMin = Math.max(2, Math.floor((fps * 60) / maxBpm));
  const lagMax = Math.min(frames - 1, Math.ceil((fps * 60) / minBpm));
  const acf = new Float32Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += nov[i] * nov[i + lag];
    acf[lag] = s / (frames - lag);
  }
  let bestLag = lagMin, bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const score = acf[lag] * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  // Parabolic interpolation for sub-frame period.
  const a = acf[bestLag - 1], b = acf[bestLag], c = acf[bestLag + 1];
  const denom = a - 2 * b + c;
  const coarse = bestLag + (denom !== 0 ? (0.5 * (a - c)) / denom : 0);

  // Joint refinement of period and phase: slide a comb of onsets across the novelty curve.
  // A period that is slightly off smears the comb over a long track, so search it finely too.
  let period = coarse, bestPhase = 0, bestComb = -Infinity;
  for (let r = -0.015; r <= 0.015; r += 0.0005) {
    const per = coarse * (1 + r);
    for (let p = 0; p < per; p += 0.5) {
      let s = 0;
      for (let k = 0; Math.round(p + k * per) < frames; k++) s += nov[Math.round(p + k * per)];
      if (s > bestComb) { bestComb = s; bestPhase = p; period = per; }
    }
  }
  const bpm = (fps * 60) / period;
  // Frame f's window spans [f*hop, f*hop + win]; the onset sits near the leading edge of the rise.
  const firstBeat = (bestPhase * hop + win * 0.5) / sampleRate;

  return {
    bpm: Math.round(bpm * 10) / 10,
    firstBeat: Math.max(0, firstBeat),
    confidence: acf[bestLag] / (acf[0] || 1),
  };
}