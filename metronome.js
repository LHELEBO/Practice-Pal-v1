// metronome.js — lookahead click scheduler on the engine's audio clock.
// A timer wakes every INTERVAL ms (imprecise, and that is fine) and schedules every click in the
// next LOOKAHEAD seconds at an exact audio-clock time (precise). Beats come from beat-grid.js in
// track time and are mapped to clock time through the engine's position, including loop wraps.

import { beatsBetween } from './beat-grid.js';

const LOOKAHEAD = 0.12; // seconds of clicks scheduled ahead
const INTERVAL = 25;    // ms between scheduler wake-ups

export class Metronome {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.grid = { bpm: 120, offset: 0, beatsPerBar: 4 };
    this.last = -Infinity;      // clock time of the last scheduled click (prevents doubles)
    this.pending = new Map();   // oscillator -> clock time, for clicks not yet played
    this.onSchedule = null;     // optional debug hook: ({ when, time, downbeat }) => {}

    engine.on('jump', () => this.reschedule());
    setInterval(() => this.tick(), INTERVAL);
  }

  // Any subset of { enabled, bpm, offset, beatsPerBar }.
  set({ enabled, ...grid }) {
    if (enabled !== undefined) this.enabled = enabled;
    this.grid = { ...this.grid, ...grid };
    this.reschedule();
  }

  // Cancel clicks that have not started yet, and schedule again from now.
  reschedule() {
    const now = this.engine.ctx.currentTime;
    for (const [osc, when] of this.pending) {
      if (when > now) { try { osc.stop(); } catch {} this.pending.delete(osc); }
    }
    this.last = now;
    this.tick();
  }

  tick() {
    const e = this.engine;
    if (!this.enabled || !e.playing) return;
    const looping = e.loopActive();
    const { start, end } = e.loop;

    let pos = e.position();               // track time now
    let clockAt = e.ctx.currentTime;      // clock time now
    let remaining = LOOKAHEAD;

    // Walk the lookahead window in track time; it may cross the loop end and continue
    // from the loop start, so split it into segments.
    for (let i = 0; i < 16 && remaining > 1e-6; i++) {
      const segEnd = looping && pos < end ? Math.min(pos + remaining, end) : pos + remaining;
      this._scheduleSegment(pos, segEnd, clockAt - pos);
      const used = segEnd - pos;
      remaining -= used;
      clockAt += used;
      if (looping && segEnd >= end) pos = start; else break;
    }
  }

  // Beats with track time in [a, b); clock time = track time + delta.
  _scheduleSegment(a, b, delta) {
    for (const beat of beatsBetween(this.grid, a, b)) {
      const when = beat.time + delta;
      if (when <= this.last + 1e-4) continue;
      this.last = when;
      this._click(when, beat.downbeat);
      if (this.onSchedule) this.onSchedule({ when, time: beat.time, downbeat: beat.downbeat });
    }
  }

  _click(when, accent) {
    const ctx = this.engine.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(env).connect(this.engine.clickGain);
    osc.start(when);
    osc.stop(when + 0.06);
    this.pending.set(osc, when);
    osc.onended = () => this.pending.delete(osc);
  }
}