// peaks.js — waveform summary for fast drawing.
// Pure math on decoded samples: no Web Audio calls, so it is easy to test or move to a worker.

// Summarize the whole file once: the min and max sample of every block of `blockSize` samples,
// taken across all channels. Drawing then reads these blocks instead of millions of samples.
export function buildPeaks(buffer, blockSize = 256) {
  const length = buffer.length;
  const count = Math.ceil(length / blockSize);
  const mins = new Float32Array(count);
  const maxs = new Float32Array(count);

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let b = 0; b < count; b++) {
      let lo = mins[b], hi = maxs[b];
      const end = Math.min(length, (b + 1) * blockSize);
      for (let i = b * blockSize; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mins[b] = lo;
      maxs[b] = hi;
    }
  }
  return { mins, maxs, blockSize, sampleRate: buffer.sampleRate, length };
}

// n pairs of [low, high] between two times (seconds): one pair per pixel column.
// Columns outside the file return [0, 0].
export function getPeaks(summary, t0, t1, n) {
  const out = new Array(n);
  if (!summary || n <= 0 || !(t1 > t0)) return [];
  const { mins, maxs, blockSize, sampleRate, length } = summary;
  const last = mins.length - 1;

  for (let i = 0; i < n; i++) {
    const s0 = Math.floor((t0 + ((t1 - t0) * i) / n) * sampleRate);
    const s1 = Math.floor((t0 + ((t1 - t0) * (i + 1)) / n) * sampleRate);
    if (s1 <= 0 || s0 >= length) { out[i] = [0, 0]; continue; }
    const b0 = Math.max(0, Math.floor(s0 / blockSize));
    const b1 = Math.min(last, Math.max(b0, Math.floor((s1 - 1) / blockSize)));
    let lo = 0, hi = 0;
    for (let b = b0; b <= b1; b++) {
      if (mins[b] < lo) lo = mins[b];
      if (maxs[b] > hi) hi = maxs[b];
    }
    out[i] = [lo, hi];
  }
  return out;
}