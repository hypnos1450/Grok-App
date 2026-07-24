// Curated "skill marketplace": known, installable SKILL.md skills the agent
// builder can pull in with one click (still routed through the same import
// validation + prompt-injection scanning as any other install). `install` is
// whatever installFromGitHub accepts — owner/repo, or a repo/tree subpath URL
// pointing at a skill folder. Kept small and high-signal; the builder falls
// back to a live web search when no catalog entry fits.
import { SkillCatalogEntry } from '@shared/types'

export const SKILL_CATALOG: SkillCatalogEntry[] = [
  {
    id: 'pdf',
    name: 'PDF toolkit',
    description: 'Read, fill, split, merge, and extract text/tables from PDF files.',
    category: 'documents',
    install: 'https://github.com/anthropics/skills/tree/main/document-skills/pdf'
  },
  {
    id: 'docx',
    name: 'Word documents',
    description: 'Create, read, and edit .docx Word documents with formatting.',
    category: 'documents',
    install: 'https://github.com/anthropics/skills/tree/main/document-skills/docx'
  },
  {
    id: 'pptx',
    name: 'PowerPoint decks',
    description: 'Build and edit .pptx slide decks and presentations.',
    category: 'documents',
    install: 'https://github.com/anthropics/skills/tree/main/document-skills/pptx'
  },
  {
    id: 'xlsx',
    name: 'Spreadsheets',
    description: 'Read, edit, and compute over .xlsx / .csv spreadsheets.',
    category: 'documents',
    install: 'https://github.com/anthropics/skills/tree/main/document-skills/xlsx'
  }
]

export function findCatalogSkill(id: string): SkillCatalogEntry | undefined {
  return SKILL_CATALOG.find((s) => s.id === id)
}
