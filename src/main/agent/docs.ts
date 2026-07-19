// DevDocs (devdocs.io) client backing the docs tool: versioned official
// documentation for languages and frameworks. The catalog and per-docset
// indexes are cached on disk (7 days, stale-if-offline) so lookups after the
// first are fast and work without network; pages are small and fetched live.
import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CATALOG_URL = 'https://devdocs.io/docs.json'
const CONTENT_BASE = 'https://documents.devdocs.io'
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 20_000

export interface DocsetMeta {
  name: string
  slug: string
  version?: string
  release?: string
  /** Content build timestamp — the best "which is newest" signal in the catalog */
  mtime?: number
}

export interface IndexEntry {
  name: string
  path: string
  type?: string
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'devdocs')
}

function slugCacheFile(slug: string): string {
  return path.join(cacheDir(), `${slug.replace(/[^a-zA-Z0-9~._-]/g, '_')}.index.json`)
}

async function readCache(file: string, maxAgeMs: number): Promise<string | null> {
  try {
    const st = await fsp.stat(file)
    if (Date.now() - st.mtimeMs > maxAgeMs) return null
    return await fsp.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function writeCache(file: string, data: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, data, 'utf8')
  } catch {
    // Cache is an optimization — a failed write must not fail the lookup.
  }
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Conduit/1.0)' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} from devdocs for ${url}`)
      return await res.text()
    } catch (err) {
      // devdocs' CDN occasionally stalls a single request — one retry clears
      // it. Never retry a user cancellation or a definitive HTTP error.
      const httpError = err instanceof Error && err.message.startsWith('HTTP ')
      if (attempt >= 1 || signal?.aborted || httpError) throw err
    }
  }
}

/** Fetch-with-cache: fresh cache wins, then network, then stale cache. */
async function cachedFetch(file: string, url: string, signal?: AbortSignal): Promise<string> {
  const fresh = await readCache(file, CACHE_TTL_MS)
  if (fresh) return fresh
  try {
    const raw = await fetchText(url, signal)
    await writeCache(file, raw)
    return raw
  } catch (err) {
    const stale = await readCache(file, Infinity)
    if (stale) return stale
    throw err
  }
}

export async function loadCatalog(signal?: AbortSignal): Promise<DocsetMeta[]> {
  const raw = await cachedFetch(path.join(cacheDir(), 'catalog.json'), CATALOG_URL, signal)
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? (parsed as DocsetMeta[]) : []
}

export async function loadIndex(slug: string, signal?: AbortSignal): Promise<IndexEntry[]> {
  const raw = await cachedFetch(slugCacheFile(slug), `${CONTENT_BASE}/${slug}/index.json`, signal)
  const parsed = JSON.parse(raw) as { entries?: IndexEntry[] }
  return Array.isArray(parsed?.entries) ? parsed.entries : []
}

/**
 * Resolve what the model called a docset to a catalog entry: exact slug, else
 * the newest versioned variant ("python" → "python~3.14"), else exact name.
 */
export function resolveDocset(catalog: DocsetMeta[], doc: string): DocsetMeta | null {
  const q = doc.trim().toLowerCase()
  if (!q) return null
  const newest = (list: DocsetMeta[]): DocsetMeta =>
    list.reduce((a, b) => ((b.mtime ?? 0) > (a.mtime ?? 0) ? b : a))
  const exact = catalog.find((d) => d.slug.toLowerCase() === q)
  if (exact) return exact
  const versioned = catalog.filter((d) => d.slug.toLowerCase().startsWith(`${q}~`))
  if (versioned.length) return newest(versioned)
  const byName = catalog.filter((d) => d.name.toLowerCase() === q)
  if (byName.length) return newest(byName)
  return null
}

/**
 * Rank index entries for a query: exact > prefix > word > substring. When the
 * literal query misses entirely, fall back to token matching — docset entry
 * names rarely match canonical spellings exactly ("Array.prototype.flatMap()"
 * is indexed as "Array.flatMap"), so anchor on the last token (the member
 * name) and rank by how many other tokens also appear.
 */
export function searchIndex(entries: IndexEntry[], query: string, limit = 15): IndexEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { entry: IndexEntry; score: number }[] = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    let score: number
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) score = 2
    else if (name.includes(q)) score = 3
    else continue
    scored.push({ entry, score })
  }
  if (!scored.length) {
    const tokens = q.split(/[^a-z0-9]+/).filter(Boolean)
    const anchor = tokens[tokens.length - 1]
    if (anchor) {
      for (const entry of entries) {
        const name = entry.name.toLowerCase()
        if (!name.includes(anchor)) continue
        const matched = tokens.filter((t) => name.includes(t)).length
        // More matched tokens → lower (better) score, after the literal tiers.
        scored.push({ entry, score: 10 + (tokens.length - matched) })
      }
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length)
    .slice(0, limit)
    .map((s) => s.entry)
}

/**
 * Validate an index-entry path and strip its fragment. Paths come from the
 * model, so anything that could escape documents.devdocs.io/<slug>/ is
 * rejected rather than fetched.
 */
export function sanitizeEntryPath(entryPath: string): string | null {
  const clean = entryPath.split('#')[0].trim()
  if (!clean || clean.startsWith('/') || clean.includes('..') || clean.includes('\\')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return null // no scheme smuggling
  return clean
}

/** Fetch one doc page's raw HTML (caller strips it to readable text). */
export async function fetchDocPage(slug: string, entryPath: string, signal?: AbortSignal): Promise<string> {
  const clean = sanitizeEntryPath(entryPath)
  if (!clean) throw new Error(`Invalid entry path "${entryPath}" — use a path exactly as returned by search.`)
  return fetchText(`${CONTENT_BASE}/${slug}/${clean}.html`, signal)
}
