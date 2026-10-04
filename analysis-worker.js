// analysis-worker.js — runs beat analysis off the main thread so the UI never freezes.
// Receives { id, samples, sampleRate } and replies { id, result } or { id, error }.

import { analyzeBeats } from './analysis.js';

self.onmessage = (event) => {
  const { id, samples, sampleRate } = event.data;
  try {
    self.postMessage({ id, result: analyzeBeats(samples, sampleRate) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};