import { ATC_CONFIG, SOURCES, type SourceCategory, type SourceSpec } from "./config";
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

/**
 * archive.org's default sort clusters heavily by recency/relevance (in
 * practice: pages and pages of the same "Space-to-Grounds" ISS batch before
 * anything else), so always taking the first `rows` hits would mean every
 * refresh — and every 7-day cache window — samples the same narrow slice of
 * the ~3k-item collection. Landing on a random `start` offset instead means
 * different refreshes surface different missions over time.
 */
function searchUrl(
  spec: Extract<SourceSpec, { kind: "search" }>,
  start: number,
): string {
  const params = new URLSearchParams({
    q: spec.query,
    output: "json",
    rows: String(spec.rows),
    start: String(start),
  });
  params.append("fl[]", "identifier");
  return `https://archive.org/advancedsearch.php?${params.toString()}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json() as Promise<unknown>;
}

/** Cheap `rows=0` probe just to read `numFound` before picking a random page. */
async function searchCount(query: string): Promise<number> {
  const params = new URLSearchParams({ q: query, output: "json", rows: "0" });
  const data = (await fetchJson(
    `https://archive.org/advancedsearch.php?${params.toString()}`,
  )) as { response?: { numFound?: unknown } };
  const numFound = data.response?.numFound;
  return typeof numFound === "number" ? numFound : 0;
}

interface DiscoveredIdentifier {
  identifier: string;
  category: SourceCategory;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Explicit identifiers are always kept in full. The remaining
 * `maxIdentifiers - explicit.length` slots are search-discovered and split
 * between categories by `pool.discoveryAtcShare` — aviation ATC is the point
 * of the app, so it gets the larger share of *candidate identifiers*, not
 * just a thumb on the scale at pick time (`Playlist.pick()`'s
 * `pickAtcWeight`). The two knobs compound rather than substitute for one
 * another: this one shapes what makes it into the manifest at all, that one
 * shapes what gets played once it's there.
 */
async function discoverIdentifiers(): Promise<DiscoveredIdentifier[]> {
  const explicit: DiscoveredIdentifier[] = [];
  const discoveredByCategory: Record<SourceCategory, string[]> = {
    nasa: [],
    atc: [],
  };
  for (const spec of SOURCES) {
    if (spec.kind === "identifier") {
      explicit.push({ identifier: spec.identifier, category: spec.category });
      continue;
    }
    try {
      const numFound = await searchCount(spec.query);
      const maxStart = Math.max(0, numFound - spec.rows);
      const start = maxStart > 0 ? Math.floor(randRange(0, maxStart)) : 0;
      const data = (await fetchJson(
        searchUrl(spec, start),
      )) as ArchiveSearchResponse;
      for (const doc of data.response?.docs ?? []) {
        if (typeof doc.identifier === "string") {
          discoveredByCategory[spec.category].push(doc.identifier);
        }
      }
    } catch {
      // Search failure is non-fatal; explicit identifiers still work.
    }
  }

  const explicitIds = new Set(explicit.map((e) => e.identifier));
  const remaining = Math.max(
    0,
    ATC_CONFIG.manifest.maxIdentifiers - explicit.length,
  );
  const atcSlots = Math.ceil(remaining * ATC_CONFIG.pool.discoveryAtcShare);
  const nasaSlots = remaining - atcSlots;

  function takeUnique(
    ids: string[],
    category: SourceCategory,
    slots: number,
    seen: Set<string>,
  ): DiscoveredIdentifier[] {
    const out: DiscoveredIdentifier[] = [];
    for (const id of shuffle([...ids])) {
      if (out.length >= slots) break;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ identifier: id, category });
    }
    return out;
  }

  const seen = new Set(explicitIds);
  const atcPicked = takeUnique(discoveredByCategory.atc, "atc", atcSlots, seen);
  // Any shortfall in one category (not enough distinct atc identifiers
  // surfaced this round) spills over to the other rather than leaving slots
  // empty.
  const spillToNasa = atcSlots - atcPicked.length;
  const nasaPicked = takeUnique(
    discoveredByCategory.nasa,
    "nasa",
    nasaSlots + spillToNasa,
    seen,
  );
  const spillToAtc = nasaSlots + spillToNasa - nasaPicked.length;
  const atcPickedMore =
    spillToAtc > 0
      ? takeUnique(discoveredByCategory.atc, "atc", spillToAtc, seen)
      : [];

  return [...explicit, ...atcPicked, ...nasaPicked, ...atcPickedMore];
}

/** Bounded-concurrency map so a refresh doesn't fire 50 metadata requests at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (error) {
        results[i] = { status: "rejected", reason: error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchEntries(
  target: DiscoveredIdentifier,
): Promise<TapeEntry[]> {
  const { identifier, category } = target;
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
      source: category,
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Manifest cache (localStorage, 7-day TTL, snapshot seed)             */
/* ------------------------------------------------------------------ */

/**
 * djb2 over `SOURCES`, folded into the storage key. Editing `SOURCES` (new
 * identifiers, a changed search query) is meaningless to `isFresh()` — a
 * manifest built under the *old* list looks perfectly valid for its full
 * 7-day TTL, so a code change quietly keeps serving the stale narrow pool
 * until someone thinks to clear localStorage by hand. Folding a hash of the
 * current sources into the key makes any such edit self-invalidating: the
 * old entry just becomes a different, unread key.
 */
function sourcesFingerprint(): string {
  const json = JSON.stringify(SOURCES);
  let hash = 5381;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 33) ^ json.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function storageKey(): string {
  return `${ATC_CONFIG.manifest.storageKey}.${sourcesFingerprint()}`;
}

function readStoredManifest(): AtcManifest | null {
  try {
    const raw = localStorage.getItem(storageKey());
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
    localStorage.setItem(storageKey(), JSON.stringify(manifest));
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
      const results = await mapWithConcurrency(
        identifiers,
        ATC_CONFIG.manifest.metadataConcurrency,
        fetchEntries,
      );
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
   * Weighted random pick: category first (aviation ATC over Apollo, see
   * `pool.pickAtcWeight`), then within that category never the same file
   * twice in a row, with recently played files/identifiers down-weighted.
   */
  pick(): TapeEntry {
    const pool = this.manifest.entries;
    const atc = pool.filter((e) => e.source === "atc");
    const nasa = pool.filter((e) => e.source !== "atc");

    let category: TapeEntry[];
    if (atc.length > 0 && nasa.length > 0) {
      category = Math.random() < ATC_CONFIG.pool.pickAtcWeight ? atc : nasa;
    } else {
      category = atc.length > 0 ? atc : nasa.length > 0 ? nasa : pool;
    }

    const last = this.history[this.history.length - 1];
    const recentFiles = new Set(this.history.map((e) => e.url));
    const recentIds = new Set(this.history.map((e) => e.identifier));

    const candidates = category.filter((e) => !last || e.url !== last.url);
    const usable = candidates.length > 0 ? candidates : category;

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
