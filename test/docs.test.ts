import { describe, expect, it } from 'vitest'
import {
  resolveDocset,
  sanitizeEntryPath,
  searchIndex,
  type DocsetMeta,
  type IndexEntry
} from '../src/main/agent/docs'

const CATALOG: DocsetMeta[] = [
  { name: 'JavaScript', slug: 'javascript', mtime: 100 },
  { name: 'Python', slug: 'python~3.12', version: '3.12', mtime: 90 },
  { name: 'Python', slug: 'python~3.13', version: '3.13', mtime: 110 },
  { name: 'Node.js', slug: 'node~22_lts', version: '22 LTS', mtime: 105 },
  { name: 'React', slug: 'react', mtime: 80 }
]

describe('resolveDocset', () => {
  it('matches an exact slug', () => {
    expect(resolveDocset(CATALOG, 'javascript')?.slug).toBe('javascript')
    expect(resolveDocset(CATALOG, 'python~3.12')?.slug).toBe('python~3.12')
  })

  it('resolves an unversioned name to the newest versioned docset', () => {
    expect(resolveDocset(CATALOG, 'python')?.slug).toBe('python~3.13')
    expect(resolveDocset(CATALOG, 'node')?.slug).toBe('node~22_lts')
  })

  it('falls back to display-name match, case-insensitively', () => {
    expect(resolveDocset(CATALOG, 'Node.js')?.slug).toBe('node~22_lts')
    expect(resolveDocset(CATALOG, 'REACT')?.slug).toBe('react')
  })

  it('returns null for unknown or empty', () => {
    expect(resolveDocset(CATALOG, 'cobol')).toBeNull()
    expect(resolveDocset(CATALOG, '')).toBeNull()
  })
})

describe('searchIndex', () => {
  const ENTRIES: IndexEntry[] = [
    { name: 'Array.prototype.flat()', path: 'global_objects/array/flat', type: 'Array' },
    { name: 'Array.prototype.flatMap()', path: 'global_objects/array/flatmap', type: 'Array' },
    { name: 'flatMap', path: 'alias/flatmap' },
    { name: 'String.prototype.at()', path: 'global_objects/string/at', type: 'String' },
    { name: 'inflate', path: 'zlib/inflate' }
  ]

  it('ranks exact > prefix > word-boundary > substring', () => {
    const names = searchIndex(ENTRIES, 'flatMap').map((e) => e.name)
    expect(names[0]).toBe('flatMap') // exact
    expect(names[1]).toBe('Array.prototype.flatMap()') // word-boundary (.flatMap)
    expect(names).not.toContain('String.prototype.at()')
  })

  it('matches substrings and respects the limit', () => {
    expect(searchIndex(ENTRIES, 'flat').map((e) => e.name)).toContain('inflate')
    expect(searchIndex(ENTRIES, 'flat', 2)).toHaveLength(2)
  })

  it('returns nothing for an empty query', () => {
    expect(searchIndex(ENTRIES, '  ')).toEqual([])
  })

  it('treats regex metacharacters in queries literally', () => {
    expect(() => searchIndex(ENTRIES, 'flat()')).not.toThrow()
    expect(searchIndex(ENTRIES, 'array.prototype.flat()')[0]?.name).toBe('Array.prototype.flat()')
  })

  it('falls back to token matching for canonical names the index abbreviates', () => {
    // Real devdocs names look like "Array.flatMap", not "Array.prototype.flatMap()".
    const real: IndexEntry[] = [
      { name: 'Array.flat', path: 'global_objects/array/flat', type: 'Array' },
      { name: 'Array.flatMap', path: 'global_objects/array/flatmap', type: 'Array' },
      { name: 'Iterator.flatMap', path: 'global_objects/iterator/flatmap', type: 'Iterator' }
    ]
    const hits = searchIndex(real, 'Array.prototype.flatMap()')
    expect(hits[0]?.name).toBe('Array.flatMap') // both tokens beat one token
    expect(hits.map((e) => e.name)).toContain('Iterator.flatMap')
  })
})

describe('sanitizeEntryPath', () => {
  it('passes normal paths and strips fragments', () => {
    expect(sanitizeEntryPath('global_objects/array/flatmap')).toBe('global_objects/array/flatmap')
    expect(sanitizeEntryPath('dom/document#events')).toBe('dom/document')
  })

  it('rejects escapes and scheme smuggling', () => {
    expect(sanitizeEntryPath('../other-docset/page')).toBeNull()
    expect(sanitizeEntryPath('/etc/passwd')).toBeNull()
    expect(sanitizeEntryPath('https://evil.example/x')).toBeNull()
    expect(sanitizeEntryPath('a\\b')).toBeNull()
    expect(sanitizeEntryPath('#only-fragment')).toBeNull()
    expect(sanitizeEntryPath('')).toBeNull()
  })
})
