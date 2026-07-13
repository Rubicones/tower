import { Note, Scale } from "tonal";
import { randIndex } from "../random";

/**
 * Whitelist of consonant scales the engine is allowed to inhabit.
 * Pentatonics have no semitone at all; lydian and dorian are the
 * smoothest full modes. Everything else is off the table.
 */
export type ScaleName =
  | "major pentatonic"
  | "minor pentatonic"
  | "lydian"
  | "dorian";

export const MAJOR_FLAVORS: readonly ScaleName[] = [
  "major pentatonic",
  "lydian",
];
export const MINOR_FLAVORS: readonly ScaleName[] = [
  "minor pentatonic",
  "dorian",
];

/** A key = tonic pitch class + one whitelisted scale. */
export interface KeyState {
  tonic: string;
  scale: ScaleName;
}

/** Inclusive MIDI range a layer is allowed to play in. */
export interface Register {
  low: number;
  high: number;
}

const MAX_TRIES = 24;
/** Chance of allowing a wider melodic leap instead of stepwise motion. */
const LEAP_PROBABILITY = 0.18;
/** Major seconds are allowed only sparingly, and only one at a time. */
const MAJOR_SECOND_PROBABILITY = 0.2;

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Interval class between two MIDI notes: fold the interval into 0–6
 * semitones so octaves/compound intervals reduce to their base quality.
 * 1 = minor second (never allowed), 6 = tritone (never allowed).
 */
export function intervalClass(a: number, b: number): number {
  const ic = Math.abs(a - b) % 12;
  return ic > 6 ? 12 - ic : ic;
}

/** The set of pitch classes (0–11) in a key. */
export function keyChromas(key: KeyState): Set<number> {
  const chromas = new Set<number>();
  for (const name of Scale.get(`${key.tonic} ${key.scale}`).notes) {
    const chroma = Note.chroma(name);
    if (typeof chroma === "number") chromas.add(chroma);
  }
  return chromas;
}

/** Pitch classes shared by two keys (candidates for pivot tones). */
export function commonChromas(a: KeyState, b: KeyState): number[] {
  const other = keyChromas(b);
  return [...keyChromas(a)].filter((chroma) => other.has(chroma));
}

export function tonicChroma(key: KeyState): number {
  return Note.chroma(key.tonic) ?? 0;
}

/** All MIDI notes of `key` inside `register`, ascending. */
export function scaleNotesInRegister(
  key: KeyState,
  register: Register,
): number[] {
  const chromas = keyChromas(key);
  const notes: number[] = [];
  for (let midi = register.low; midi <= register.high; midi++) {
    if (chromas.has(((midi % 12) + 12) % 12)) notes.push(midi);
  }
  return notes;
}

/** Lowest MIDI note >= `low` with the given pitch class. */
export function midiForChroma(chroma: number, low: number): number {
  return low + ((chroma - (low % 12) + 12) % 12);
}

/**
 * Holds the current key and hands out notes that are guaranteed consonant
 * against everything currently sounding, across all layers.
 *
 * During a modulation each layer can temporarily sit in its own key
 * (the drift is staggered), so per-layer overrides shadow the global key.
 * The interval-class filter always checks against *actual sounding notes*,
 * which is what keeps the overlap of two keys clash-free.
 */
export class HarmonyEngine {
  private globalKey: KeyState;
  private readonly layerKeys = new Map<string, KeyState>();
  private readonly lastNotes = new Map<string, number>();

  constructor(initial: KeyState) {
    this.globalKey = initial;
  }

  get key(): KeyState {
    return this.globalKey;
  }

  keyFor(layerId: string): KeyState {
    return this.layerKeys.get(layerId) ?? this.globalKey;
  }

  /** Stagger support: move a single layer to the new key. */
  setLayerKey(layerId: string, key: KeyState): void {
    this.layerKeys.set(layerId, key);
  }

  /** Finish a modulation: everyone on the new key, overrides cleared. */
  setKey(key: KeyState): void {
    this.globalKey = key;
    this.layerKeys.clear();
  }

  /**
   * Pick the next note for `layerId` from its current scale, validated
   * against all `activeNotes` with the interval-class filter:
   * reject minor seconds (ic 1) and tritones (ic 6) outright, allow at
   * most one major second (ic 2) and only sparingly. Prefers small
   * melodic steps from the layer's previous note, with occasional leaps.
   *
   * Returns null only if the register holds no scale tones at all.
   */
  getNextNote(
    layerId: string,
    activeNotes: readonly number[],
    register: Register,
  ): number | null {
    const pool = scaleNotesInRegister(this.keyFor(layerId), register);
    if (pool.length === 0) return null;

    const last = this.lastNotes.get(layerId);
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const candidate = this.pickCandidate(pool, last);
      if (this.isConsonant(candidate, activeNotes)) {
        this.lastNotes.set(layerId, candidate);
        return candidate;
      }
    }

    // Fallback: double an already-sounding pitch class. A unison/octave of
    // a sounding note has the same interval class to every other sounding
    // note, so it can never introduce a new clash.
    const fallback = this.octaveFallback(pool, activeNotes, last);
    if (fallback !== null) this.lastNotes.set(layerId, fallback);
    return fallback;
  }

  /** Weighted pick favouring small steps from the previous note. */
  private pickCandidate(pool: number[], last: number | undefined): number {
    if (last === undefined || Math.random() < LEAP_PROBABILITY) {
      return pool[randIndex(pool.length)];
    }
    let total = 0;
    const weights = pool.map((note) => {
      const distance = Math.abs(note - last);
      // Repeating the same note is dull; near steps score highest.
      const weight = distance === 0 ? 0.3 : 1 / Math.pow(distance, 1.35);
      total += weight;
      return weight;
    });
    let roll = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  private isConsonant(
    candidate: number,
    activeNotes: readonly number[],
  ): boolean {
    let majorSeconds = 0;
    for (const note of activeNotes) {
      const ic = intervalClass(candidate, note);
      if (ic === 1 || ic === 6) return false;
      if (ic === 2) majorSeconds++;
    }
    if (majorSeconds > 0) {
      return majorSeconds === 1 && Math.random() < MAJOR_SECOND_PROBABILITY;
    }
    return true;
  }

  private octaveFallback(
    pool: number[],
    activeNotes: readonly number[],
    last: number | undefined,
  ): number | null {
    if (activeNotes.length === 0) return pool[randIndex(pool.length)];
    const activeChromas = new Set(
      activeNotes.map((note) => ((note % 12) + 12) % 12),
    );
    const doubles = pool.filter((note) =>
      activeChromas.has(((note % 12) + 12) % 12),
    );
    if (doubles.length === 0) return null;
    if (last === undefined) return doubles[randIndex(doubles.length)];
    let best = doubles[0];
    for (const note of doubles) {
      if (Math.abs(note - last) < Math.abs(best - last)) best = note;
    }
    return best;
  }
}
