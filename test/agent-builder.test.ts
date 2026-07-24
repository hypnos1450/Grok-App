import { describe, expect, it } from 'vitest'
import { classifySkill, namesFromReport, type DesignSkill } from '../src/main/agent/agent-builder'

const base: DesignSkill = {
  capability: '',
  reason: '',
  installedSkill: null,
  catalogId: null,
  searchQuery: null
}

describe('classifySkill', () => {
  const installed = new Set(['pdf', 'my-skill'])

  it('matches an already-installed skill', () => {
    const item = classifySkill(
      { ...base, capability: 'PDF editing', reason: 'reports', installedSkill: 'pdf' },
      installed
    )
    expect(item).toMatchObject({ status: 'installed', ref: 'pdf', capability: 'PDF editing' })
  })

  it('ignores an installed name that is not actually installed and falls through', () => {
    const item = classifySkill(
      { ...base, capability: 'X', installedSkill: 'ghost', catalogId: 'docx' },
      installed
    )
    // ghost is not installed → catalog match wins
    expect(item).toMatchObject({ status: 'catalog', ref: 'docx' })
    expect(item?.install).toContain('github.com')
  })

  it('maps a catalog id to its install source', () => {
    const item = classifySkill({ ...base, capability: 'Word docs', catalogId: 'docx' }, installed)
    expect(item?.status).toBe('catalog')
    expect(item?.install).toContain('document-skills/docx')
  })

  it('drops an unknown catalog id but keeps a search fallback', () => {
    const item = classifySkill(
      { ...base, capability: 'Terraform', catalogId: 'nope', searchQuery: 'terraform skill' },
      installed
    )
    expect(item).toMatchObject({ status: 'search', ref: 'terraform skill' })
  })

  it('uses a search query when nothing else fits', () => {
    const item = classifySkill(
      { ...base, capability: 'Kubernetes', searchQuery: 'kubernetes skill github' },
      installed
    )
    expect(item?.status).toBe('search')
  })

  it('returns null when there is no capability', () => {
    expect(classifySkill({ ...base, installedSkill: 'pdf' }, installed)).toBeNull()
  })

  it('returns null when a capability cannot be satisfied at all', () => {
    expect(classifySkill({ ...base, capability: 'Vague thing' }, installed)).toBeNull()
  })
})

describe('namesFromReport', () => {
  it('extracts skill-name tokens from import report lines', () => {
    expect(
      namesFromReport(['pdf (+3 files) [documents]', 'docx', 'my-skill (+1 files)'])
    ).toEqual(['pdf', 'docx', 'my-skill'])
  })
  it('ignores unparseable entries', () => {
    expect(namesFromReport(['', '   ', '(weird)'])).toEqual([])
  })
})
