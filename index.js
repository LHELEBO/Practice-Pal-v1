// index.js — the `audio` object: the contract the UI codes against.
// Holds the state, fires 'change', and passes calls through to the engine, metronome,
// peaks and analysis. The UI imports this file and nothing else.

import { Engine } from './engine.js';
import { Metronome } from './metronome.js';
import { buildPeaks, getPeaks } from './peaks.js';
import { beatsBetween } from './beat-grid.js';

const ANALYSIS_SECONDS = 90; // only the first 90 s are analyzed

const engine = new Engine();
const metronome = new Metronome(engine);
const listeners = new Set();

let summary = null;      // waveform peaks for the loaded file
let loadId = 0;          // increases per load, so late results from an older file are ignored
let taps = [];
let worker = null;
let touchedLoadId = 0;   // the load during which the user last changed the metronome

const state = {
  loaded: false,
  loading: false,
  analyzing: false,
  name: '',
  duration: 0,
  playing: false,
  error: null,
  loop: { enabled: false, start: 0, end: 0 },
  metronome: { enabled: false, bpm: 120, offset: 0, beatsPerBar: 4, suggested: false },
  volume: { track: 1, click: 0.6 },
};

engine.clickGain.gain.value = state.volume.click;
engine.on('ended', () => { state.playing = false; emit(); });

function emit() {
  listeners.forEach((fn) => fn(state));
}

export const audio = {
  state,

  on(event, fn) {
    if (event !== 'change') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ---------- loading ----------
  // Accepts a File/Blob, an ArrayBuffer, or (inside Electron) a file path.
  async loadFile(file) {
    const id = ++loadId;
    const name = typeof file === 'string' ? file.split(/[\\/]/).pop() : file.name || 'audio';
    engine.pause();
    Object.assign(state, { loading: true, error: null, playing: false, name });
    emit();

    let buffer;
    try {
      buffer = await engine.decode(await toArrayBuffer(file));
    } catch {
      if (id !== loadId) return;
      Object.assign(state, { loading: false, loaded: false, duration: 0, error: `Could not read ${name}` });
      emit();
      return;
    }
    if (id !== loadId) return; // a newer file was dropped while this one decoded

    engine.setBuffer(buffer);
    summary = buildPeaks(buffer);
    Object.assign(state, {
      loading: false, loaded: true, duration: buffer.duration,
      loop: { ...engine.loop },
      analyzing: true,
    });
    state.metronome.suggested = false;
    emit();

    analyze(buffer, id);
  },

  // ---------- transport ----------
  play()   { engine.play();  state.playing = engine.playing; emit(); },
  pause()  { engine.pause(); state.playing = engine.playing; emit(); },
  seek(t)  { engine.seek(t); state.playing = engine.playing; emit(); },
  position() { return engine.position(); },

  // ---------- drawing helpers ----------
  getPeaks(t0, t1, n) { return getPeaks(summary, t0, t1, n); },
  beatsBetween(a, b)  { return beatsBetween(state.metronome, a, b); },

  // ---------- loop ----------
  setLoop(partial) {
    if (!state.loaded) return;
    state.loop = { ...engine.setLoop(partial) };
    emit();
  },

  // ---------- metronome ----------
  setMetronome(partial) {
    applyMetronome(partial);
    state.metronome.suggested = false; // the user changed something
    touchedLoadId = loadId;
    emit();
  },

  scaleTempo(factor) {
    this.setMetronome({ bpm: state.metronome.bpm * factor });
  },

  // Tap tempo: average the gaps between recent taps; a pause over 2 s starts over.
  tap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    taps = taps.slice(-8);
    if (taps.length < 2) return;
    const avgGap = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    this.setMetronome({ bpm: 60000 / avgGap });
  },

  // ---------- volume ----------
  setVolume({ track, click }) {
    if (track !== undefined) state.volume.track = clamp(track, 0, 1);
    if (click !== undefined) state.volume.click = clamp(click, 0, 1);
    engine.trackGain.gain.value = state.volume.track;
    engine.clickGain.gain.value = state.volume.click;
    emit();
  },
};

// Validate, store, and hand the settings to the metronome.
function applyMetronome(partial) {
  const m = state.metronome;
  if (partial.enabled !== undefined) m.enabled = Boolean(partial.enabled);
  if (Number.isFinite(partial.bpm)) m.bpm = Math.round(clamp(partial.bpm, 20, 300) * 10) / 10;
  if (Number.isFinite(partial.offset)) m.offset = Math.max(0, partial.offset);
  if (Number.isFinite(partial.beatsPerBar)) m.beatsPerBar = Math.round(clamp(partial.beatsPerBar, 1, 16));
  metronome.set({ enabled: m.enabled, bpm: m.bpm, offset: m.offset, beatsPerBar: m.beatsPerBar });
}

// ---------- analysis ----------
function analyze(buffer, id) {
  const samples = downmix(buffer, ANALYSIS_SECONDS);
  const done = (result) => {
    if (id !== loadId) return;               // file changed since
    state.analyzing = false;
    // Fill in the suggestion only if the user has not already set the tempo for this file.
    if (result && touchedLoadId !== id) {
      applyMetronome({ bpm: result.bpm, offset: result.firstBeat });
      state.metronome.suggested = true;
    }
    emit();
  };

  try {
    worker ??= new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { if (e.data.id === id) done(e.data.result || null); };
    worker.onerror = () => fallback();
    worker.postMessage({ id, samples, sampleRate: buffer.sampleRate }, [samples.buffer]);
  } catch {
    fallback();
  }

  // If workers are unavailable, run on the main thread (briefly blocks the UI).
  async function fallback() {
    const { analyzeBeats } = await import('./analysis.js');
    done(analyzeBeats(downmix(buffer, ANALYSIS_SECONDS), buffer.sampleRate));
  }
}

// Average all channels into one, keeping only the first `seconds`.
function downmix(buffer, seconds) {
  const n = Math.min(buffer.length, Math.floor(seconds * buffer.sampleRate));
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

async function toArrayBuffer(file) {
  if (file instanceof ArrayBuffer) return file;
  if (typeof file === 'string') {
    if (!window.api) throw new Error('Paths can only be opened inside Electron');
    const u8 = await window.api.readFile(file);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }
  return file.arrayBuffer();
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// For the test harness only (not part of the contract).
export const _internals = { engine, metronome };