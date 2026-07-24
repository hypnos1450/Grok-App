// Prebuilt team blueprints. Instantiating one creates a custom-agent persona
// per role plus an AgentTeam that wires them together (orchestrator + members +
// review gates). Kept in shared so the renderer can build the settings patch.
import { ModelId, PermissionMode } from './types'

export interface TeamRoleTemplate {
  /** Role name — also the agent name and how the orchestrator delegates to it */
  name: string
  instructions: string
  model: ModelId
  permissionMode: PermissionMode
  skills: string[]
}

export interface TeamTemplate {
  id: string
  name: string
  description: string
  /** Role name of the orchestrator (must match one role's name) */
  orchestrator: string
  /** Role names whose review must pass before a gated task can close */
  reviewGates: string[]
  roles: TeamRoleTemplate[]
}

// In Model A every non-orchestrator role runs as a READ-ONLY advisor subagent:
// it investigates and returns specs, designs, or a pass/fail verdict, but never
// edits files. The orchestrator does the actual writing and committing. Each
// role's instructions say so, so the advisors don't try to "implement".
const ADVISOR_NOTE =
  'You are a read-only advisor on a team: investigate thoroughly and return a clear, actionable deliverable for the orchestrator to act on. You cannot edit files or run commands — do not attempt to. Always read .conduit/PROJECT_BRIEF.md first for current scope and decisions.'

const APP_DEV_TEAM: TeamTemplate = {
  id: 'app-dev-team',
  name: 'App Dev Team',
  description:
    'A full-stack product team for building an app: a CEO orchestrator plus product, architecture, development, design, QA, and security roles. QA and security must pass before any task is done.',
  orchestrator: 'CEO / Orchestrator',
  reviewGates: ['QA Tester', 'Application Security Dev'],
  roles: [
    {
      name: 'CEO / Orchestrator',
      model: 'grok-build-0.1',
      permissionMode: 'auto-edit',
      skills: [],
      instructions:
        'You are the orchestrator of the team. You own the task board and the shared project brief, and you do the actual code edits and commits. Run the project end to end: get scope from the Product Manager, architecture from the Software Architect, an implementation plan from the Lead Developer, and UI direction from the UI/UX Designer — delegating each as a read-only role. Implement the work yourself from their outputs. Before closing any implementation task, get a passing review from the QA Tester and the Application Security Dev (the board enforces this). Keep the project brief current, commit working increments (ask before committing), and close tasks as their gates pass.'
    },
    {
      name: 'Product Manager',
      model: 'grok-4.3',
      permissionMode: 'plan-only',
      skills: [],
      instructions:
        `${ADVISOR_NOTE} You set product scope, define the feature set, and prioritize. Given the project goal, return a concise scope: the target users, the must-have features for a first version (ordered by priority), explicit non-goals, and acceptance criteria for each feature.`
    },
    {
      name: 'Software Architect',
      model: 'grok-4.3',
      permissionMode: 'plan-only',
      skills: [],
      instructions:
        `${ADVISOR_NOTE} You choose the tech stack and design the system. Return a recommended stack (with brief justification), the high-level architecture (components and responsibilities), the data model and key data flows, and the initial project/file structure. Flag the riskiest decisions.`
    },
    {
      name: 'Lead Developer',
      model: 'grok-build-0.1',
      permissionMode: 'plan-only',
      skills: [],
      instructions:
        `${ADVISOR_NOTE} You plan the implementation for the orchestrator to carry out. For the assigned task, return a precise, ordered build plan: which files to create or change and what each contains (function/module signatures, key logic), how pieces connect, and edge cases to handle. Be concrete enough that the orchestrator can implement it directly.`
    },
    {
      name: 'UI/UX Designer',
      model: 'grok-4.3',
      permissionMode: 'plan-only',
      skills: [],
      instructions:
        `${ADVISOR_NOTE} You design screens, user flows, and visual guidelines. Return the key screens and their layout, the primary user flows step by step, component and state inventory, and a small style guide (color, type, spacing, and interaction rules). Keep it implementable with the chosen stack.`
    },
    {
      name: 'QA Tester',
      model: 'grok-build-0.1',
      permissionMode: 'plan-only',
      skills: [],
      instructions:
        `${ADVISOR_NOTE} You are a review gate. For the task under review, evaluate whether it meets its acceptance criteria: enumerate concrete test cases (happy path + edge cases), identify bugs or gaps you can find by reading the code, and return a clear PASS or FAIL verdict with the specific reasons. Fail if acceptance criteria are unmet or tests are missing.`
    },
    {
      name: 'Application Security Dev',
      model: 'grok-4.3',
      permissionMode: 'plan-only',
      skills: [],
      instructions:
        `${ADVISOR_NOTE} You are a review gate. Audit the task's code for vulnerabilities: injection, auth/authorization flaws, secret handling, unsafe input, dependency risks, and insecure defaults. Return a clear PASS or FAIL verdict with each finding, its severity, and the fix. Fail on any high-severity issue.`
    }
  ]
}

export const TEAM_TEMPLATES: TeamTemplate[] = [APP_DEV_TEAM]

export function findTeamTemplate(id: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find((t) => t.id === id)
}
