// engine.js — decoding, transport, the track-time mapping, and sample-accurate looping.
// Owns the AudioContext: the single clock that the metronome also schedules on.

const MIN_LOOP = 0.05;       // seconds; shorter loops are stretched to this
const SNAP_WINDOW = 0.005;   // seconds searched either side for a zero crossing

export class Engine {
  constructor({ snapToZero = true } = {}) {
    this.ctx = new AudioContext();
    this.trackGain = this.ctx.createGain();
    this.clickGain = this.ctx.createGain();
    this.trackGain.connect(this.ctx.destination);
    this.clickGain.connect(this.ctx.destination);

    this.snapToZero = snapToZero;
    this.buffer = null;
    this.source = null;
    this.playing = false;

    // The track-time mapping: at audio-clock time `anchorCtx`, the song was at `anchorPos`.
    this.anchorCtx = 0;
    this.anchorPos = 0;

    this.loop = { enabled: false, start: 0, end: 0 };
    this.listeners = { jump: new Set(), ended: new Set() };
  }

  // 'jump'  = playback started, stopped, moved, or the loop changed (metronome reschedules)
  // 'ended' = the track played to its end on its own
  on(event, fn) { this.listeners[event].add(fn); }
  _emit(event) { this.listeners[event].forEach((fn) => fn()); }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  // True when the loop is on and long enough to use.
  loopActive() {
    const { enabled, start, end } = this.loop;
    return enabled && end - start >= MIN_LOOP - 1e-9;
  }

  // ---------- loading ----------
  // Decode only, no side effects, so the caller can drop a stale result.
  decode(arrayBuffer) {
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  setBuffer(buffer) {
    this._stopSource();
    this.playing = false;
    this.buffer = buffer;
    this.anchorPos = 0;
    this.loop = { enabled: false, start: 0, end: buffer.duration };
    this._emit('jump');
  }

  // ---------- transport ----------
  position() {
    if (!this.playing) return this.anchorPos;
    let p = this.anchorPos + (this.ctx.currentTime - this.anchorCtx);
    if (this.loopActive() && p >= this.loop.end) {
      const { start, end } = this.loop;
      p = start + ((p - start) % (end - start));
    }
    return Math.min(p, this.duration);
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.ctx.resume();
    let pos = this.anchorPos;
    if (pos >= this.duration) pos = 0;
    if (this.loopActive() && pos >= this.loop.end) pos = this.loop.start;
    this._start(pos);
  }

  pause() {
    if (!this.playing) return;
    const pos = this.position();
    this._stopSource();
    this.playing = false;
    this.anchorPos = pos;
    this._emit('jump');
  }

  // While the loop is on, a seek past its end lands on its start (the playhead stays in or
  // before the loop). Change this rule here if you decide otherwise.
  seek(t) {
    if (!this.buffer) return;
    t = clamp(t, 0, this.duration);
    if (this.loopActive() && t >= this.loop.end) t = this.loop.start;
    if (this.playing) this._start(t);
    else { this.anchorPos = t; this._emit('jump'); }
  }

  // ---------- looping ----------
  // Accepts any subset of { start, end, enabled }; returns the loop actually applied.
  setLoop(next) {
    const pos = this.position();               // read with the OLD loop
    this.loop = this._normalize({ ...this.loop, ...next });
    if (!this.playing) return this.loop;

    if (this.loopActive() && pos >= this.loop.end) {
      this._start(this.loop.start);            // playhead fell outside: jump in
    } else {
      this.anchorPos = pos;                    // re-anchor so position() stays continuous
      this.anchorCtx = this.ctx.currentTime;
      this._applyLoop(this.source);            // retune the running node, no restart
      this._emit('jump');
    }
    return this.loop;
  }

  _normalize({ enabled, start, end }) {
    const d = this.duration;
    let s = clamp(Number(start) || 0, 0, d);
    let e = clamp(Number(end) || 0, 0, d);
    if (e < s) [s, e] = [e, s];
    if (e - s < MIN_LOOP) {
      e = Math.min(d, s + MIN_LOOP);
      s = Math.max(0, e - MIN_LOOP);
    }
    if (this.snapToZero && this.buffer) {
      if (s > 0) s = this.nearestZeroCrossing(s);
      if (e < d) e = this.nearestZeroCrossing(e);
    }
    return { enabled: Boolean(enabled), start: s, end: e };
  }

  // Loop points on a zero crossing avoid an audible click at the seam.
  // Searches channel 0 within SNAP_WINDOW; returns t unchanged if none is found.
  nearestZeroCrossing(t) {
    const data = this.buffer.getChannelData(0);
    const rate = this.buffer.sampleRate;
    const c = Math.round(t * rate);
    const w = Math.round(SNAP_WINDOW * rate);
    const crosses = (k) => k > 0 && k < data.length &&
      ((data[k - 1] <= 0 && data[k] > 0) || (data[k - 1] >= 0 && data[k] < 0));
    for (let d = 0; d <= w; d++) {
      if (crosses(c - d)) return (c - d) / rate;
      if (crosses(c + d)) return (c + d) / rate;
    }
    return t;
  }

  _applyLoop(src) {
    src.loop = this.loopActive();
    src.loopStart = this.loop.start;
    src.loopEnd = this.loop.end;
  }

  // ---------- internals ----------
  _start(pos) {
    this._stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.trackGain);
    this._applyLoop(src);
    src.onended = () => {
      if (this.source !== src) return;        // we stopped it ourselves
      this.source = null;
      this.playing = false;
      this.anchorPos = 0;
      this._emit('jump');
      this._emit('ended');
    };
    src.start(0, pos);
    this.source = src;
    this.anchorPos = pos;
    this.anchorCtx = this.ctx.currentTime;
    this.playing = true;
    this._emit('jump');
  }

  _stopSource() {
    const s = this.source;
    if (!s) return;
    this.source = null;
    s.onended = null;
    try { s.stop(); } catch {}
    s.disconnect();
  }
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}