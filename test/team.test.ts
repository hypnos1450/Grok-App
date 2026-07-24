import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gateBlockers, teamTaskTool, projectBriefTool } from '../src/main/agent/team'
import type { ToolContext } from '../src/main/agent/tools'
import type { AgentTeam, TeamState, TeamTask } from '@shared/types'

function makeCtx(
  cwd: string,
  gates: string[] = ['QA', 'AppSec']
): { ctx: ToolContext; state: () => TeamState } {
  const config: AgentTeam = {
    id: 't1',
    name: 'Test Team',
    description: '',
    orchestratorId: 'ceo',
    memberIds: [],
    reviewGates: gates
  }
  const holder: { state: TeamState } = { state: { tasks: [], brief: '' } }
  const ctx = {
    cwd,
    sessionId: 'test',
    signal: new AbortController().signal,
    team: {
      config,
      getState: () => holder.state,
      setState: (next: TeamState) => {
        holder.state = next
      }
    }
  } as unknown as ToolContext
  return { ctx, state: () => holder.state }
}

const run = (ctx: ToolContext, input: Record<string, unknown>) => teamTaskTool.run(input, ctx)

describe('gateBlockers (pure)', () => {
  const task = (reviews: TeamTask['reviews'], requiresReview = true): TeamTask => ({
    id: 'x',
    title: 't',
    status: 'review',
    requiresReview,
    reviews,
    createdAt: 0,
    updatedAt: 0
  })

  it('blocks when a gate role has no review', () => {
    expect(gateBlockers(task([]), ['QA', 'AppSec'])).toEqual([
      'QA: no review yet',
      'AppSec: no review yet'
    ])
  })

  it('blocks when the latest review from a gate role failed', () => {
    const reviews = [
      { role: 'QA', verdict: 'pass' as const, at: 1 },
      { role: 'AppSec', verdict: 'fail' as const, at: 2 }
    ]
    expect(gateBlockers(task(reviews), ['QA', 'AppSec'])).toEqual(['AppSec: last review failed'])
  })

  it('passes when every gate role has a latest passing review (case-insensitive)', () => {
    const reviews = [
      { role: 'qa', verdict: 'pass' as const, at: 1 },
      { role: 'appsec', verdict: 'pass' as const, at: 2 }
    ]
    expect(gateBlockers(task(reviews), ['QA', 'AppSec'])).toEqual([])
  })

  it('latest verdict wins (fail then pass = clear)', () => {
    const reviews = [
      { role: 'QA', verdict: 'fail' as const, at: 1 },
      { role: 'QA', verdict: 'pass' as const, at: 2 }
    ]
    expect(gateBlockers(task(reviews), ['QA'])).toEqual([])
  })

  it('skips the gate entirely when requiresReview is false', () => {
    expect(gateBlockers(task([], false), ['QA', 'AppSec'])).toEqual([])
  })
})

describe('team_task tool', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-'))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const firstId = (s: () => TeamState): string => s().tasks[0].id

  it('creates a task in todo', async () => {
    const { ctx, state } = makeCtx(tmp)
    const r = await run(ctx, { action: 'create', title: 'Build login', assignee: 'Lead Dev' })
    expect(r.ok).toBe(true)
    expect(state().tasks).toHaveLength(1)
    expect(state().tasks[0]).toMatchObject({ title: 'Build login', assignee: 'Lead Dev', status: 'todo', requiresReview: true })
  })

  it('refuses status=done via update (must use close)', async () => {
    const { ctx, state } = makeCtx(tmp)
    await run(ctx, { action: 'create', title: 'T' })
    const r = await run(ctx, { action: 'update', id: firstId(state), status: 'done' })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/close/i)
  })

  it('ENFORCES the QA/AppSec gate: close is refused until both pass', async () => {
    const { ctx, state } = makeCtx(tmp)
    await run(ctx, { action: 'create', title: 'Feature' })
    const id = firstId(state)

    // No reviews → refused, naming both missing gates.
    let r = await run(ctx, { action: 'close', id })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/QA/)
    expect(r.output).toMatch(/AppSec/)
    expect(state().tasks[0].status).not.toBe('done')

    // QA passes → still refused (AppSec missing).
    await run(ctx, { action: 'review', id, role: 'QA', verdict: 'pass' })
    r = await run(ctx, { action: 'close', id })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/AppSec/)
    expect(r.output).not.toMatch(/QA:/)

    // AppSec fails → blocked, task moved to blocked.
    await run(ctx, { action: 'review', id, role: 'AppSec', verdict: 'fail', notes: 'SQL injection' })
    expect(state().tasks[0].status).toBe('blocked')
    r = await run(ctx, { action: 'close', id })
    expect(r.ok).toBe(false)

    // AppSec re-review passes → now closeable.
    await run(ctx, { action: 'review', id, role: 'AppSec', verdict: 'pass' })
    r = await run(ctx, { action: 'close', id })
    expect(r.ok).toBe(true)
    expect(state().tasks[0].status).toBe('done')
  })

  it('closes a non-review task (requiresReview=false) with no gate', async () => {
    const { ctx, state } = makeCtx(tmp)
    await run(ctx, { action: 'create', title: 'Write test cases', assignee: 'QA Tester', requiresReview: false })
    const r = await run(ctx, { action: 'close', id: firstId(state) })
    expect(r.ok).toBe(true)
    expect(state().tasks[0].status).toBe('done')
  })

  it('lists the board with pending-gate annotations', async () => {
    const { ctx } = makeCtx(tmp)
    await run(ctx, { action: 'create', title: 'A', assignee: 'Lead Dev' })
    const r = await run(ctx, { action: 'list' })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/TODO/)
    expect(r.output).toMatch(/needs:/)
  })

  it('errors clearly when not in a team session', async () => {
    const r = await teamTaskTool.run({ action: 'list' }, { cwd: tmp, sessionId: 't', signal: new AbortController().signal } as unknown as ToolContext)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/team-project/)
  })
})

describe('project_brief tool', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('set stores the brief and mirrors it to .conduit/PROJECT_BRIEF.md', async () => {
    const { ctx, state } = makeCtx(tmp)
    const md = '# Project\n\nScope: a todo app.'
    const r = await projectBriefTool.run({ action: 'set', content: md }, ctx)
    expect(r.ok).toBe(true)
    expect(state().brief).toBe(md)
    const file = fs.readFileSync(path.join(tmp, '.conduit', 'PROJECT_BRIEF.md'), 'utf8')
    expect(file).toBe(md)
  })

  it('get returns the current brief', async () => {
    const { ctx } = makeCtx(tmp)
    await projectBriefTool.run({ action: 'set', content: 'hello' }, ctx)
    const r = await projectBriefTool.run({ action: 'get' }, ctx)
    expect(r.output).toBe('hello')
  })
})
