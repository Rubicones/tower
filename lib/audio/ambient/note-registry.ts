/**
 * Cross-layer registry of everything currently sounding, so the
 * HarmonyEngine can validate new notes against the real acoustic state.
 *
 * - Transient notes (pad chords, bells) expire at a given audio-clock time.
 * - Sustained notes (drone voices) are owned by a layer and replaced
 *   wholesale when that layer changes pitch.
 */
export class NoteRegistry {
  private transient: { midi: number; until: number }[] = [];
  private readonly sustained = new Map<string, number[]>();

  /** Register a transient note sounding until `until` (audio-clock secs). */
  add(midi: number, until: number): void {
    this.transient.push({ midi, until });
  }

  /** Replace the sustained notes owned by `ownerId`. */
  setSustained(ownerId: string, notes: readonly number[]): void {
    this.sustained.set(ownerId, [...notes]);
  }

  /** Every note sounding at time `now`. */
  snapshot(now: number): number[] {
    this.prune(now);
    const notes = this.transient.map((entry) => entry.midi);
    for (const owned of this.sustained.values()) notes.push(...owned);
    return notes;
  }

  /** Total voices sounding at `now` (for the global polyphony cap). */
  count(now: number): number {
    this.prune(now);
    let total = this.transient.length;
    for (const owned of this.sustained.values()) total += owned.length;
    return total;
  }

  /** Drop all transient notes (used on stop). */
  clearTransient(): void {
    this.transient = [];
  }

  private prune(now: number): void {
    if (this.transient.length === 0) return;
    this.transient = this.transient.filter((entry) => entry.until > now);
  }
}
