import { ATC_CONFIG, SOURCES, type SourceSpec } from "./config";
import snapshotJson from "./manifest.snapshot.json";
import { randRange } from "./random";
import type { AtcManifest, TapeEntry } from "./types";

const SNAPSHOT = snapshotJson as AtcManifest;

/* ------------------------------------------------------------------ */
/* archive.org discovery                                               */
/* ------------------------------------------------------------------ */

interface ArchiveFile {
  name?: unknown;
  size?: unknown;
  length?: unknown;
  title?: unknown;
}

interface ArchiveMetadata {
  files?: ArchiveFile[];
  metadata?: { title?: unknown };
}

interface ArchiveSearchResponse {
  response?: { docs?: { identifier?: unknown }[] };
}

/** "4448.83" or "101:52" or "1:41:52" -> seconds. */
function parseLength(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (value.includes(":")) {
    const parts = value.split(":").map(Number);
    if (parts.some(Number.isNaN)) return undefined;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const seconds = Number(value);
  return Number.isNaN(seconds) ? undefined : Math.floor(seconds);
}

function searchUrl(spec: Extract<SourceSpec, { kind: "search" }>): string {
  const params = new URLSearchParams({
    q: spec.query,
    output: "json",
    rows: String(spec.rows),
  });
  params.append("fl[]", "identifier");
  return `https://archive.org/advancedsearch.php?${params.toString()}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json() as Promise<unknown>;
}

async function discoverIdentifiers(): Promise<string[]> {
  const explicit: string[] = [];
  const discovered: string[] = [];
  for (const spec of SOURCES) {
    if (spec.kind === "identifier") {
      explicit.push(spec.identifier);
      continue;
    }
    try {
      const data = (await fetchJson(searchUrl(spec))) as ArchiveSearchResponse;
      for (const doc of data.response?.docs ?? []) {
        if (typeof doc.identifier === "string") discovered.push(doc.identifier);
      }
    } catch {
      // Search failure is non-fatal; explicit identifiers still work.
    }
  }
  // Shuffle discovered items so different sessions sample different tapes.
  for (let i = discovered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [discovered[i], discovered[j]] = [discovered[j], discovered[i]];
  }
  const merged = [...explicit, ...discovered];
  const unique = [...new Set(merged)];
  return unique.slice(0, ATC_CONFIG.manifest.maxIdentifiers);
}

async function fetchEntries(identifier: string): Promise<TapeEntry[]> {
  const data = (await fetchJson(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
  )) as ArchiveMetadata;
  const itemTitle =
    typeof data.metadata?.title === "string"
      ? data.metadata.title
      : identifier;
  const entries: TapeEntry[] = [];
  for (const file of data.files ?? []) {
    if (typeof file.name !== "string" || !file.name.endsWith(".mp3")) continue;
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < ATC_CONFIG.manifest.minFileBytes) {
      continue;
    }
    entries.push({
      identifier,
      file: file.name,
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}`,
      size,
      title:
        typeof file.title === "string" ? file.title : `${itemTitle} — ${file.name}`,
      lengthSeconds: parseLength(file.length),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Manifest cache (localStorage, 7-day TTL, snapshot seed)             */
/* ------------------------------------------------------------------ */

function readStoredManifest(): AtcManifest | null {
  try {
    const raw = localStorage.getItem(ATC_CONFIG.manifest.storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AtcManifest;
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredManifest(manifest: AtcManifest): void {
  try {
    localStorage.setItem(
      ATC_CONFIG.manifest.storageKey,
      JSON.stringify(manifest),
    );
  } catch {
    // Storage full/unavailable — the snapshot still seeds next session.
  }
}

function isFresh(manifest: AtcManifest): boolean {
  const ttlMs = ATC_CONFIG.manifest.ttlDays * 24 * 60 * 60 * 1000;
  return Date.now() - manifest.savedAt < ttlMs;
}

/* ------------------------------------------------------------------ */
/* Playlist                                                            */
/* ------------------------------------------------------------------ */

/**
 * Owns the combined tape manifest and pick-history.
 *
 * `entries()` always returns something usable immediately (fresh cache →
 * stale cache → bundled snapshot); a background refresh replaces it when
 * the cache is stale. Selection biases against the last 10 picked files
 * AND identifiers so consecutive segments come from different missions.
 */
export class Playlist {
  private manifest: AtcManifest;
  private history: TapeEntry[] = [];
  private refreshing = false;

  constructor() {
    this.manifest = readStoredManifest() ?? SNAPSHOT;
  }

  entries(): TapeEntry[] {
    return this.manifest.entries;
  }

  /** Kick off a background refresh if the cached manifest is stale. */
  refreshIfStale(): void {
    if (this.refreshing || isFresh(this.manifest)) return;
    this.refreshing = true;
    void this.refresh().finally(() => {
      this.refreshing = false;
    });
  }

  private async refresh(): Promise<void> {
    try {
      const identifiers = await discoverIdentifiers();
      const results = await Promise.allSettled(identifiers.map(fetchEntries));
      const entries = results
        .filter(
          (r): r is PromiseFulfilledResult<TapeEntry[]> =>
            r.status === "fulfilled",
        )
        .flatMap((r) => r.value);
      if (entries.length === 0) return; // keep whatever we had
      this.manifest = { savedAt: Date.now(), entries };
      writeStoredManifest(this.manifest);
    } catch {
      // All fetches failed — keep last cached manifest / snapshot.
    }
  }

  /**
   * Weighted random pick: never the same file twice in a row; recently
   * played files and identifiers are strongly down-weighted.
   */
  pick(): TapeEntry {
    const pool = this.manifest.entries;
    const last = this.history[this.history.length - 1];
    const recentFiles = new Set(this.history.map((e) => e.url));
    const recentIds = new Set(this.history.map((e) => e.identifier));

    const candidates = pool.filter((e) => !last || e.url !== last.url);
    const usable = candidates.length > 0 ? candidates : pool;

    const weights = usable.map((entry) => {
      let weight = 1;
      if (recentFiles.has(entry.url)) weight *= ATC_CONFIG.history.fileWeight;
      if (recentIds.has(entry.identifier)) {
        weight *= ATC_CONFIG.history.identifierWeight;
      }
      return weight;
    });

    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = Math.random() * total;
    let picked = usable[usable.length - 1];
    for (let i = 0; i < usable.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        picked = usable[i];
        break;
      }
    }

    this.history.push(picked);
    if (this.history.length > ATC_CONFIG.history.size) this.history.shift();
    return picked;
  }

  /**
   * Random start offset within a tape, avoiding the final stretch so
   * there's runway before the tape ends. Duration may come from the
   * manifest or from the element's loaded metadata.
   */
  pickOffset(entry: TapeEntry, knownDuration?: number): number {
    const duration = knownDuration ?? entry.lengthSeconds ?? 0;
    const usable = duration - ATC_CONFIG.tapeTailAvoidSeconds;
    if (usable <= 0) return 0;
    return randRange(0, usable);
  }
}
