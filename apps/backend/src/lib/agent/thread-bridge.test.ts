import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { listSessionCredentials } from '@/lib/claude-code-preview/credential-listing'
import { useAgentDb } from '@/lib/test/doubles/agent-db'
import { useAgentSessionsShared } from '@/lib/test/doubles/agent-sessions-shared'
import { real as realOptions, useCredentialOptions } from '@/lib/test/doubles/credential-options'
import { useConversationRuntimeMove } from '@/lib/test/doubles/conversation-runtime-move'
import { useDb } from '@/lib/test/doubles/db'
import { useConversationChatRoute } from '@/lib/test/doubles/conversation-chat-route'
import { useIdentity } from '@/lib/test/doubles/identity'
import { useRuntimeCatalog } from '@/lib/test/doubles/runtime-catalog'
import { useSessionConfig } from '@/lib/test/doubles/session-config'

import { clearPendingUserMessages } from './pending-messages'
import { getSessionBypass, setSessionBypass } from './auto-mode/store'
import { threadReadGrants } from './db/access'
import {
  authorizeThreadDelivery,
  createAgentThread,
  listThreadRuntimes,
  sendAgentThreadMessage,
  updateThread,
  setAgentThreadArchived,
} from './thread-bridge'
import { installTurnRunner, resetTurnRunner } from './turn-runner'

import type { AgentConversation, AgentCredentialAccess } from './db'
import type { RuntimeInstance } from '@/lib/claude-code-preview/runtime-instances'

import type { TurnRunner } from './turn-runner'

const access = {
  awsRoleIds: ['role-1'],
  updatedAt: new Date(),
  updatedBy: 'owner',
} as AgentCredentialAccess
const actor = { userId: 'owner', teamId: 'team', sessionId: 'source', locale: 'zh-TW' }
let source: AgentConversation
let target: AgentConversation
let member = true
const archives: unknown[][] = []
const claims: Parameters<TurnRunner['claimAgentRunOrEnqueue']>[0][] = []
const shells: Parameters<typeof import('./db').upsertConversationShell>[0][] = []

beforeEach(() => {
  source = {
    ...actor,
    title: 'Source',
    firstMessage: 'Original',
    messageCount: 1,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    credentialAccess: access,
    agentRuntime: 'codex',
    runtimeId: 'runtime-1',
  }
  target = { ...source, sessionId: 'target' }
  member = true
  archives.length = 0
  claims.length = 0
  shells.length = 0
  bypass.clear()
  events.length = 0
  moves.length = 0
  placements.clear()
  moveError = undefined
  macClaude = { online: true, signedIn: true }
  writes.length = 0
  removals.length = 0
  selections.clear()
  picks.length = 0
  getAccess = readSelection
  installTurnRunner({
    claimAgentRunOrEnqueue: async (args) => {
      claims.push(args)

      return { mode: 'queued' }
    },
  })
})
afterEach(async () => {
  resetTurnRunner()
  for (const id of ['target', ...shells.map((shell) => shell.sessionId)])
    await clearPendingUserMessages('owner', id)
})

useConversationChatRoute({
  resolveConversationChatRuntime: async () => ({ runtime: 'claude-code' }),
})
useIdentity({
  getTeamMembership: async () => (member ? { role: 'MEMBER' } : null),
  signNuphosToken: () => 'test-token',
})
const bypass = new Map<string, Record<string, unknown>>()
const events: { conversationId: string; event: string }[] = []
const moves: { sessionId: string; runtimeId: string; mode: string; userId: string }[] = []
// Each conversation's selection as list_credentials reads it, and the fields grants write.
const selections = new Map<string, Partial<AgentCredentialAccess>>()
const writes: { sessionId: string; fields: Partial<Record<string, string[]>> }[] = []
const removals: {
  sessionId: string
  pull: Partial<Record<string, string[]>>
  narrow: Partial<Record<string, string[]>>
}[] = []
const options = await realOptions.getAgentCredentialOptions(undefined, 'owner')

useCredentialOptions({
  getAgentCredentialOptions: async () =>
    ({
      ...options,
      awsRoles: ['role-1', 'role-2'].map((roleId) => ({ roleId, accountId: roleId })),
      linearWorkspaces: [{ workspaceId: 'ws-1', label: 'Zeabur' }],
      // A connector whose unset selection means all of them.
      githubInstallations: ['gh-1', 'gh-2'].map((installationId) => ({
        installationId,
        accountLogin: installationId,
      })),
      devices: [
        { deviceId: 'mac-1', available: true },
        { deviceId: 'mac-2', available: true },
        { deviceId: 'offline-mac', available: false },
      ].map((device) => ({ ...device, label: device.deviceId, platform: 'darwin' })),
    }) as never,
})
const readSelection: typeof getAccess = async ({ sessionId }) =>
  (selections.get(sessionId) ?? {}) as never
let getAccess: (agent: { sessionId: string }) => Promise<never> = readSelection

useAgentSessionsShared({ getAgentCredentialAccess: async (agent) => getAccess(agent) })

useDb({
  db: () => ({
    collection: () => ({
      updateOne(
        filter: { conversationId: string; userId: string },
        update: { $setOnInsert?: Record<string, unknown>; $set?: Record<string, unknown> },
        options: { upsert?: boolean },
      ) {
        const key = `${filter.userId}:${filter.conversationId}`
        let doc = bypass.get(key)

        if (!doc && options.upsert) {
          doc = { ...filter, ...update.$setOnInsert }
          bypass.set(key, doc)
        }
        if (doc) Object.assign(doc, update.$set)

        return Promise.resolve()
      },
      findOne(filter: { conversationId: string; userId: string }) {
        return Promise.resolve(bypass.get(`${filter.userId}:${filter.conversationId}`) ?? null)
      },
    }),
  }),
})
// Where a move put each conversation, as the store's $set would, read back by
// getConversationBySessionId. A move that should fail sets moveError.
const placements = new Map<
  string,
  Pick<AgentConversation, 'runtimeId' | 'agentRuntime' | 'runtimeLabel'>
>()
let moveError: Error | undefined

useConversationRuntimeMove({
  moveConversationRuntime: async (conversation, runtimeId, mode, userId) => {
    if (moveError) throw moveError
    moves.push({ sessionId: conversation.sessionId, runtimeId, mode, userId })
    const instance = (await catalog('team', 'owner')).find(({ id }) => id === runtimeId)!

    placements.set(conversation.sessionId, {
      runtimeId,
      agentRuntime: instance.provider,
      runtimeLabel: instance.label,
    })

    return { runtimeId, runtimeLabel: instance.label, agentRuntime: instance.provider, mode }
  },
})
// The owner's own computer `mac-1`, which the parent runs on in the local tests,
// another of theirs `mac-2`, and a teammate's `mac-3` shared with them.
const MAC_CODEX = 'local_owner_mac-1_codex'
const MAC_CLAUDE = 'local_owner_mac-1'
const OTHER_MAC_CLAUDE = 'local_owner_mac-2'
const SHARED_MAC_CLAUDE = 'local_mate_mac-3'
let macClaude: { online: boolean; signedIn: boolean | null } = { online: true, signedIn: true }
const onComputer = (
  id: string,
  provider: 'codex' | 'claude-code',
  deviceId: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  provider,
  label: `${provider} in ${deviceId}`,
  status: 'active' as const,
  kind: 'local' as const,
  createdAt: '',
  local: { ownerUserId: 'owner', deviceId, online: true, signedIn: true, ...extra } as never,
})
const catalog = async (_teamId: string, userId?: string): Promise<RuntimeInstance[]> => [
  {
    id: 'runtime-2',
    provider: 'codex',
    label: 'Other',
    status: 'active',
    kind: 'managed',
    createdAt: '',
  },
  ...(userId
    ? [
        {
          id: 'local-1',
          provider: 'codex' as const,
          label: 'Mac',
          status: 'active' as const,
          kind: 'local' as const,
          createdAt: '',
        },
        {
          id: 'box-1',
          provider: 'claude-code' as const,
          label: 'Claude Code in Box',
          status: 'active' as const,
          kind: 'local' as const,
          createdAt: '',
          local: { box: { provider: 'instabox' } } as never,
        },
        onComputer(MAC_CODEX, 'codex', 'mac-1'),
        onComputer(MAC_CLAUDE, 'claude-code', 'mac-1', macClaude),
        onComputer(OTHER_MAC_CLAUDE, 'claude-code', 'mac-2'),
        onComputer(SHARED_MAC_CLAUDE, 'claude-code', 'mac-3', {
          ownerUserId: 'mate',
          shared: { level: 'full' },
        }),
      ]
    : []),
]

useRuntimeCatalog({
  withRuntimeReadiness: async (_teamId, instances) => instances,
  listRuntimeQuotas: async (_teamId, instances) => instances.map(() => ({}) as never),
  // Without a user only the team's agents are listed; a local one would need the owner.
  listRuntimeInstances: catalog,
})
// The model picker: what each conversation was set to, and the runtime's catalog.
const picks: { sessionId: string; configId: string; value: string }[] = []
// Each agent type's catalog: a model is only valid for the agent the thread runs on.
const catalogs = {
  codex: { model: ['gpt-6.1-sol', 'default'], effort: ['high', 'low'] },
  'claude-code': { model: ['claude-fable-5-1', 'default'], effort: ['high', 'low'] },
}

useSessionConfig({
  conversationSessionConfig: async (conversation, selection) => {
    const offered = catalogs[(conversation.agentRuntime ?? 'codex') as 'codex']
    const options = Object.entries(offered).map(([kind, values]) => ({
      id: kind,
      name: kind,
      kind: kind as 'model',
      currentValue: picks.findLast((pick) => pick.configId === kind)?.value ?? 'default',
      options: values.map((value) => ({ value, name: value })),
    }))

    if (!selection) return { status: 'ready', options }
    if (!offered[selection.configId as 'model'].includes(selection.value)) {
      const { AppError } = await import('@/lib/errors')

      throw new AppError(400, 'invalid_runtime_config', 'no longer available')
    }
    picks.push({ sessionId: conversation.sessionId, ...selection })

    return {
      status: 'ready',
      options: options.map((option) =>
        option.id === selection.configId ? { ...option, currentValue: selection.value } : option,
      ),
    }
  },
})
useAgentDb({
  setConversationArchived: async (...args) => {
    archives.push(args)

    return undefined
  },
  getConversationBySessionId: async (id) =>
    id === 'source'
      ? source
      : id === 'target'
        ? target
        : shells.some((shell) => shell.sessionId === id)
          ? {
              ...source,
              ...(({ agentRuntime, runtimeId, runtimeLabel, workspace }) => ({
                agentRuntime,
                runtimeId,
                runtimeLabel,
                workspace,
              }))(shells.find((shell) => shell.sessionId === id)!),
              sessionId: id,
              parentSessionId: shells.find((shell) => shell.sessionId === id)?.parentSessionId,
              ...placements.get(id),
            }
          : null,
  upsertConversationShell: async (data) => {
    shells.push(data)

    return { isNew: true }
  },
  agentMessages: () => ({ findOne: async () => null }),
  recordAgentEvent: (event) => {
    events.push(event)
  },
  // The store's $addToSet, with the guard that a field in `existing` is still set.
  addConversationCredentialIds: async (sessionId, _userId, _teamId, fields, existing) => {
    const stored = selections.get(sessionId) ?? {}

    if (existing.some((key) => stored[key as keyof AgentCredentialAccess] === undefined))
      return null
    writes.push({ sessionId, fields })
    const next = { ...stored } as Record<string, unknown>

    for (const [key, ids] of Object.entries(fields))
      next[key] = [...new Set([...((next[key] as string[] | undefined) ?? []), ...(ids ?? [])])]
    selections.set(sessionId, next as Partial<AgentCredentialAccess>)

    return {} as AgentConversation
  },
  // The store's $pull and $set, guarded that pulled fields are lists and narrowed
  // ones unset: missing or null, as the driver stores undefined.
  removeConversationCredentialIds: async (sessionId, _userId, _teamId, pull, narrow) => {
    const stored = selections.get(sessionId) ?? {}
    const isList = (key: string) => Array.isArray(stored[key as keyof AgentCredentialAccess])

    if (Object.keys(pull).some((key) => !isList(key)) || Object.keys(narrow).some(isList))
      return null
    removals.push({ sessionId, pull, narrow })
    const next = { ...stored, ...narrow } as Record<string, unknown>

    for (const [key, ids] of Object.entries(pull))
      next[key] = (next[key] as string[]).filter((id) => !ids.includes(id))
    selections.set(sessionId, next as Partial<AgentCredentialAccess>)

    return {} as AgentConversation
  },
  getConversationWithMessages: async (sessionId) => ({
    conversation: { ...source, sessionId },
    messages: [],
  }),
})

describe('conversation-scoped thread tools', () => {
  test('creates a visible conversation with the same principal, runtime and credentials, then starts it', async () => {
    const result = await createAgentThread(actor, 'Wait for CI', 'CI watcher')

    expect(result.status).toBe('queued')
    expect(result.sourceThreadId).toBe('source')
    expect(shells[0]).toMatchObject({
      userId: 'owner',
      teamId: 'team',
      agentRuntime: 'codex',
      runtimeId: 'runtime-1',
      credentialAccess: access,
      sessionId: result.threadId,
      parentSessionId: 'source',
    })
    expect(shells[0]).not.toHaveProperty('claudeCodePreview')
    expect(claims[0]).toMatchObject({
      userId: 'owner',
      sessionId: result.threadId,
      message: { id: result.messageId, renderedText: 'Wait for CI' },
    })
    expect(claims[0]?.message.metadata).toMatchObject({
      source: 'agent.thread',
      sourceSessionId: 'source',
    })
  })

  test("a thread copies its parent's readers, never its watchers", async () => {
    Object.assign(source, {
      generalAccess: 'reply',
      participantIds: ['x', 'v'],
      watcherIds: ['owner', 'x'],
    })
    await createAgentThread(actor, 'Wait for CI', 'CI watcher')

    expect(threadReadGrants(shells[0]!.parentGrants!)).toEqual({
      generalAccess: 'view',
      participantIds: ['x', 'v'],
    })
  })

  test('a thread of a private parent stays private', async () => {
    Object.assign(source, { generalAccess: 'none' })
    await createAgentThread(actor, 'Wait for CI', 'CI watcher')

    expect(threadReadGrants(shells[0]!.parentGrants!)).toEqual({ generalAccess: 'none' })
  })

  test('returns without waiting for the turn, like a message typed into a chat', async () => {
    const runs: Parameters<TurnRunner['runAgentForTrigger']>[0][] = []

    installTurnRunner({
      claimAgentRunOrEnqueue: async (args) => {
        claims.push(args)

        return { mode: 'run', carried: [], release: () => {} }
      },
      runAgentForTrigger: (args) => {
        runs.push(args)

        // A long turn that never finishes must not hold back other threads.
        return new Promise(() => {})
      },
    })
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createAgentThread(actor, `Task ${i}`, `Thread ${i}`)),
    )

    expect(results.map((result) => result.status)).toEqual(Array(12).fill('started'))
    for (let i = 0; i < 200 && runs.length < 12; i++) await Bun.sleep(5)
    expect(runs).toHaveLength(12)
    expect(new Set(claims.map((claim) => claim.sessionId))).toEqual(
      new Set(results.map((result) => result.threadId)),
    )
  })

  test.each([true, false])("a thread starts in its parent's mode (Full Access %p)", async (on) => {
    await setSessionBypass('source', 'owner', on)
    const result = await createAgentThread(actor, 'Work', 'Task')

    expect(await getSessionBypass(result.threadId, 'owner')).toBe(on)
  })

  test('a Full Access parent switches its thread to Auto Mode and back', async () => {
    await setSessionBypass('source', 'owner', true)
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    await updateThread(actor, threadId, { fullAccess: false })
    expect(await getSessionBypass(threadId, 'owner')).toBe(false)
    await updateThread(actor, threadId, { fullAccess: true })
    expect(await getSessionBypass(threadId, 'owner')).toBe(true)
    expect(events.map((e) => [e.conversationId, e.event])).toEqual([
      [threadId, 'auth.bypass_disabled'],
      [threadId, 'auth.bypass_enabled'],
    ])
  })

  test('an Auto Mode parent cannot give its thread Full Access, but can still lower it', async () => {
    await setSessionBypass('source', 'owner', true)
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    await setSessionBypass('source', 'owner', false)
    await expect(updateThread(actor, threadId, { fullAccess: true })).rejects.toThrow('Full Access')
    expect(await getSessionBypass(threadId, 'owner')).toBe(true)
    await updateThread(actor, threadId, { fullAccess: false })
    expect(await getSessionBypass(threadId, 'owner')).toBe(false)
  })

  test('only a thread nested under this conversation can be switched', async () => {
    await setSessionBypass('source', 'owner', true)
    await expect(updateThread(actor, 'target', { fullAccess: true })).rejects.toThrow(
      'nested under',
    )
    await expect(updateThread(actor, 'source', { fullAccess: true })).rejects.toThrow()
    expect(await getSessionBypass('target', 'owner')).toBe(false)
    expect(events).toHaveLength(0)
  })

  test('a conversation adopted as a child is managed like one created here', async () => {
    await setSessionBypass('source', 'owner', true)
    selections.set('source', { deviceIds: ['mac-1'] })
    selections.set('target', {})
    target = { ...target, parentSessionId: 'source' }
    await updateThread(actor, 'target', {
      fullAccess: true,
      grant: [{ provider: 'device', id: 'mac-1' }],
    })
    expect(await getSessionBypass('target', 'owner')).toBe(true)
    expect(selections.get('target')?.deviceIds).toEqual(['mac-1'])
  })

  test('a parent grants its thread what it has selected itself, and nothing else', async () => {
    selections.set('source', {
      awsRoleIds: ['role-1'],
      linearWorkspaceIds: ['ws-1'],
      deviceIds: ['mac-1', 'offline-mac'],
    })
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    selections.set(threadId, { awsRoleIds: ['role-1'], deviceIds: [] })
    const grant = [
      { provider: 'device', id: 'mac-1' },
      // Selected but offline: the selection is what was ticked, online is checked at use.
      { provider: 'device', id: 'offline-mac' },
      { provider: 'linear', id: 'ws-1' },
      { provider: 'aws', id: 'role-1' },
    ]
    const result = await updateThread(actor, threadId, { grant })

    expect(result.granted).toEqual(grant)
    // Only the fields that change, so the thread's other choices are left alone.
    expect(writes).toEqual([
      {
        sessionId: threadId,
        fields: { linearWorkspaceIds: ['ws-1'], deviceIds: ['mac-1', 'offline-mac'] },
      },
    ])
  })

  test("refuses anything outside the parent's selection, without a write", async () => {
    selections.set('source', { awsRoleIds: ['role-1'], deviceIds: ['mac-1'] })
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    // Bound to the team but not selected here, online but not the parent's, unknown.
    for (const ref of [
      { provider: 'aws', id: 'role-2' },
      { provider: 'device', id: 'mac-2' },
      { provider: 'device', id: 'someone-elses-mac' },
      { provider: 'linear', id: 'ws-1' },
      { provider: 'gcp', id: 'role-1' },
    ]) {
      await expect(
        updateThread(actor, threadId, { grant: [{ provider: 'device', id: 'mac-1' }, ref] }),
      ).rejects.toThrow(`${ref.provider} ${ref.id}`)
    }
    expect(writes).toHaveLength(0)
  })

  test('a grant never narrows a connector whose unset selection means all', async () => {
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    await updateThread(actor, threadId, { grant: [{ provider: 'github', id: 'gh-1' }] })
    expect(writes).toHaveLength(0)
    selections.set('source', { githubInstallationIds: ['gh-1'] })
    selections.set(threadId, { githubInstallationIds: ['gh-2'] })
    await updateThread(actor, threadId, { grant: [{ provider: 'github', id: 'gh-1' }] })
    expect(selections.get(threadId)?.githubInstallationIds).toEqual(['gh-2', 'gh-1'])
    // Unset (all of them) after the thread was read: adding would narrow it, so nothing is written.
    selections.set(threadId, { githubInstallationIds: ['gh-2'] })
    getAccess = async ({ sessionId }) => {
      const read = selections.get(sessionId) ?? {}

      if (sessionId === threadId) selections.set(threadId, {})

      return read as never
    }
    await expect(
      updateThread(actor, threadId, { grant: [{ provider: 'github', id: 'gh-1' }] }),
    ).rejects.toThrow('changed meanwhile')
    expect(selections.get(threadId)).toEqual({})
  })

  test('overlapping grants to the same field keep every id', async () => {
    selections.set('source', { awsRoleIds: ['role-1', 'role-2'] })
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    selections.set(threadId, { awsRoleIds: [] })
    // Both read the thread's empty selection before either writes.
    await Promise.all(
      ['role-1', 'role-2'].map((id) =>
        updateThread(actor, threadId, { grant: [{ provider: 'aws', id }] }),
      ),
    )
    expect(selections.get(threadId)?.awsRoleIds).toEqual(['role-1', 'role-2'])
  })

  test('a thread created with a subset gets exactly that subset', async () => {
    selections.set('source', {
      awsRoleIds: ['role-1', 'role-2'],
      linearWorkspaceIds: ['ws-1'],
      deviceIds: ['mac-1', 'mac-2'],
      teamIdentity: ['github'],
      // githubInstallationIds unset: all of them.
    })
    source = { ...source, credentialAccess: { ...access, teamIdentity: ['github'] } }
    const credentials = [
      { provider: 'aws', id: 'role-2' },
      { provider: 'device', id: 'mac-1' },
      { provider: 'github', id: 'gh-1' },
    ]
    const { threadId } = await createAgentThread(actor, 'Work', 'Task', { credentials })
    const stored = shells[0]?.credentialAccess

    expect(stored).toMatchObject({
      awsRoleIds: ['role-2'],
      deviceIds: ['mac-1'],
      githubInstallationIds: ['gh-1'],
      linearWorkspaceIds: [],
      // Every field is set, so one whose unset selection means all is narrowed too.
      gitlabBindingIds: [],
      cloudflareAccountIds: [],
      teamIdentity: ['github'],
      updatedBy: 'owner',
    })
    // What its list_credentials, and so get_credential, then sees.
    selections.set(threadId, stored as never)
    const listed = await listSessionCredentials({ userId: 'owner', sessionId: threadId }, 'team')

    expect(listed.selected.map(({ provider, id }) => ({ provider, id }))).toEqual([
      { provider: 'aws', id: 'role-2' },
      { provider: 'github', id: 'gh-1' },
      { provider: 'device', id: 'mac-1' },
    ])
  })

  test('a thread created with an empty subset gets nothing, and without one inherits all', async () => {
    selections.set('source', { awsRoleIds: ['role-1'], deviceIds: ['mac-1'] })
    await createAgentThread(actor, 'Work', 'Task', { credentials: [] })
    await createAgentThread(actor, 'Work', 'Task')
    selections.set('empty', shells[0]?.credentialAccess as never)

    expect(
      (await listSessionCredentials({ userId: 'owner', sessionId: 'empty' }, 'team')).selected,
    ).toEqual([])
    expect(shells[1]?.credentialAccess).toBe(access)
  })

  test('a conversation with no selection can still create threads, within its own reach', async () => {
    source = { ...source, credentialAccess: undefined }
    const list = (sessionId: string) =>
      listSessionCredentials({ userId: 'owner', sessionId }, 'team').then(
        ({ selected }) => selected,
      )
    const inherited = await createAgentThread(actor, 'Work', 'Task')
    const none = await createAgentThread(actor, 'Work', 'Task', { credentials: [] })

    for (const shell of shells) selections.set(shell.sessionId, shell.credentialAccess as never)
    // Unset is the parent's own selection, so the thread lists exactly what the parent does.
    expect(shells[0]?.credentialAccess).toBeUndefined()
    expect(await list(inherited.threadId)).toEqual(await list('source'))
    expect(await list(none.threadId)).toEqual([])
  })

  test("create_thread refuses anything outside the parent's selection, before any write", async () => {
    selections.set('source', { awsRoleIds: ['role-1'], deviceIds: ['mac-1'] })
    for (const ref of [
      { provider: 'aws', id: 'role-2' },
      { provider: 'device', id: 'mac-2' },
      { provider: 'linear', id: 'ws-1' },
      { provider: 'gcp', id: 'role-1' },
    ]) {
      await expect(
        createAgentThread(actor, 'Work', 'Task', {
          credentials: [{ provider: 'aws', id: 'role-1' }, ref],
        }),
      ).rejects.toThrow(`${ref.provider} ${ref.id}`)
    }
    expect(shells).toHaveLength(0)
    expect(claims).toHaveLength(0)
  })

  test('a parent revokes what its thread has, leaving the rest of the selection', async () => {
    selections.set('source', { awsRoleIds: ['role-1', 'role-2'], deviceIds: ['mac-1'] })
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    selections.set(threadId, { awsRoleIds: ['role-1', 'role-2'], deviceIds: ['mac-1'] })
    const revoke = [
      { provider: 'aws', id: 'role-1' },
      { provider: 'device', id: 'mac-1' },
    ]
    const result = await updateThread(actor, threadId, { revoke })

    expect(result).toMatchObject({ revoked: revoke })
    expect(result).not.toHaveProperty('granted')
    expect(removals).toEqual([
      {
        sessionId: threadId,
        pull: { awsRoleIds: ['role-1'], deviceIds: ['mac-1'] },
        narrow: {},
      },
    ])
    expect(selections.get(threadId)).toEqual({ awsRoleIds: ['role-2'], deviceIds: [] })
  })

  test('revoking from a connector whose unset selection means all keeps the rest', async () => {
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    selections.set(threadId, {})
    await updateThread(actor, threadId, { revoke: [{ provider: 'github', id: 'gh-1' }] })
    expect(selections.get(threadId)).toEqual({ githubInstallationIds: ['gh-2'] })
    // Set to an explicit list after the thread was read: nothing is written.
    selections.set(threadId, {})
    getAccess = async ({ sessionId }) => {
      const read = selections.get(sessionId) ?? {}

      if (sessionId === threadId) selections.set(threadId, { githubInstallationIds: ['gh-1'] })

      return read as never
    }
    await expect(
      updateThread(actor, threadId, { revoke: [{ provider: 'github', id: 'gh-2' }] }),
    ).rejects.toThrow('changed meanwhile')
    expect(selections.get(threadId)).toEqual({ githubInstallationIds: ['gh-1'] })
  })

  test('a null selection, as the driver stores undefined, is revoked from as all', async () => {
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    selections.set(threadId, { githubInstallationIds: null } as never)
    await updateThread(actor, threadId, { revoke: [{ provider: 'github', id: 'gh-1' }] })
    expect(removals.at(-1)).toMatchObject({ pull: {}, narrow: { githubInstallationIds: ['gh-2'] } })
    expect(selections.get(threadId)).toEqual({ githubInstallationIds: ['gh-2'] })
  })

  test('refuses to revoke what the thread does not have, or to grant and revoke one pair', async () => {
    selections.set('source', { awsRoleIds: ['role-1', 'role-2'] })
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    selections.set(threadId, { awsRoleIds: ['role-1'] })
    await expect(
      updateThread(actor, threadId, {
        revoke: [
          { provider: 'aws', id: 'role-1' },
          { provider: 'aws', id: 'role-2' },
        ],
      }),
    ).rejects.toThrow('Not selected for the thread: aws role-2')
    const ref = { provider: 'aws', id: 'role-2' }

    await expect(updateThread(actor, threadId, { grant: [ref], revoke: [ref] })).rejects.toThrow(
      'Both granted and revoked: aws role-2',
    )
    // A refused grant in the same call stops the revoke too.
    await expect(
      updateThread(actor, threadId, {
        grant: [{ provider: 'linear', id: 'ws-1' }],
        revoke: [{ provider: 'aws', id: 'role-1' }],
      }),
    ).rejects.toThrow('linear ws-1')
    expect(writes).toHaveLength(0)
    expect(removals).toHaveLength(0)
    expect(selections.get(threadId)).toEqual({ awsRoleIds: ['role-1'] })
  })

  test("only a thread nested here gets a grant, never another owner's", async () => {
    selections.set('source', { deviceIds: ['mac-1'] })
    const grant = [{ provider: 'device', id: 'mac-1' }]

    // Another conversation's thread, even one this conversation created before.
    target = { ...target, parentSessionId: 'elsewhere' }
    await expect(updateThread(actor, 'target', { grant })).rejects.toThrow('nested under')
    // Nested here, but owned by someone else.
    target = { ...target, parentSessionId: 'source', userId: 'other' }
    await expect(updateThread(actor, 'target', { grant })).rejects.toThrow('you own')
    expect(writes).toHaveLength(0)
  })

  test("a thread on a team agent never moves onto the owner's computer", async () => {
    await setSessionBypass('source', 'owner', true)
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    await expect(updateThread(actor, threadId, { runtimeId: 'local-1' })).rejects.toThrow(
      'computer',
    )
    expect(moves).toHaveLength(0)
  })

  test('a parent moves its thread to another agent through the shared move path', async () => {
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')
    const result = await updateThread(actor, threadId, { runtimeId: 'runtime-2' })

    expect(moves).toEqual([
      { sessionId: threadId, runtimeId: 'runtime-2', mode: 'history', userId: 'owner' },
    ])
    expect(result.runtime?.runtimeId).toBe('runtime-2')
    await expect(updateThread(actor, 'target', { runtimeId: 'runtime-2' })).rejects.toThrow(
      'nested under',
    )
    expect(moves).toHaveLength(1)
  })

  test("lists the team's agents and the owner's Boxes, never a computer", async () => {
    const { runtimes } = await listThreadRuntimes(actor)

    expect(runtimes.map((runtime) => runtime.runtimeId)).toEqual(['runtime-2', 'box-1'])
  })

  test('a parent moves its thread onto a Box', async () => {
    const { threadId } = await createAgentThread(actor, 'Work', 'Task')

    await updateThread(actor, threadId, { runtimeId: 'box-1' })
    expect(moves.map((move) => move.runtimeId)).toEqual(['box-1'])
  })

  describe('another agent on the computer the parent runs on', () => {
    beforeEach(() => {
      source = { ...source, runtimeId: MAC_CODEX, agentRuntime: 'codex' }
    })

    test("lists the parent computer's other agents, never another computer's", async () => {
      const { runtimes } = await listThreadRuntimes(actor)

      expect(runtimes.map((runtime) => runtime.runtimeId)).toEqual([
        'runtime-2',
        'box-1',
        MAC_CODEX,
        MAC_CLAUDE,
      ])
      expect(runtimes.find((runtime) => runtime.runtimeId === MAC_CLAUDE)).toMatchObject({
        provider: 'claude-code',
        sameComputer: true,
        ready: true,
        current: false,
      })
      expect(runtimes.find((runtime) => runtime.runtimeId === MAC_CODEX)?.current).toBe(true)
    })

    test('a Codex parent starts a Claude Code thread there, with its model, as the same owner', async () => {
      const result = await createAgentThread(actor, 'Review', 'Reviewer', {
        provider: 'claude-code',
        model: 'claude-fable-5-1',
      })

      // Placed through the picker's move, then the model checked by that agent's catalog.
      expect(moves).toEqual([
        { sessionId: result.threadId, runtimeId: MAC_CLAUDE, mode: 'history', userId: 'owner' },
      ])
      expect(picks).toEqual([
        { sessionId: result.threadId, configId: 'model', value: 'claude-fable-5-1' },
      ])
      // Read back from the stored thread, not echoed from the request.
      expect(result).toMatchObject({ agentRuntime: 'claude-code', runtimeId: MAC_CLAUDE })
      expect(shells[0]).toMatchObject({
        userId: 'owner',
        teamId: 'team',
        credentialAccess: access,
        parentSessionId: 'source',
      })
      expect(claims[0]).toMatchObject({ userId: 'owner', sessionId: result.threadId })
      expect(archives).toHaveLength(0)
    })

    test('a runtimeId from the list works the same way', async () => {
      const result = await createAgentThread(actor, 'Review', 'Reviewer', {
        runtimeId: MAC_CLAUDE,
      })

      expect(result.agentRuntime).toBe('claude-code')
      expect(moves.map((move) => move.runtimeId)).toEqual([MAC_CLAUDE])
    })

    test("the parent's own agent type stays on the parent's agent", async () => {
      const result = await createAgentThread(actor, 'Work', 'Task', { provider: 'codex' })

      expect(moves).toHaveLength(0)
      expect(result).toMatchObject({ agentRuntime: 'codex', runtimeId: MAC_CODEX })
    })

    test('the project folder follows to the other agent on its computer', async () => {
      source = {
        ...source,
        workspace: { kind: 'folder', path: '/project', runtimeId: MAC_CODEX },
      }
      await createAgentThread(actor, 'Work', 'Task', { provider: 'claude-code' })

      expect(shells[0]?.workspace).toEqual({
        kind: 'folder',
        path: '/project',
        runtimeId: MAC_CLAUDE,
      })
    })

    test("a model of another agent type is refused on the parent's agent, with the hint", async () => {
      const refusal = createAgentThread(actor, 'Work', 'Task', { model: 'claude-fable-5-1' })

      await expect(refusal).rejects.toThrow('(codex). Choose one of: gpt-6.1-sol, default.')
      await expect(
        createAgentThread(actor, 'Work', 'Task', { model: 'claude-fable-5-1' }),
      ).rejects.toThrow('pass provider or runtimeId')
      expect(claims).toHaveLength(0)
    })

    test.each([
      ['another of their computers', OTHER_MAC_CLAUDE],
      ["a teammate's shared computer", SHARED_MAC_CLAUDE],
      ['an unknown agent', 'local_owner_mac-1_opencode'],
    ])('refuses %s before writing anything', async (_case, runtimeId) => {
      await expect(createAgentThread(actor, 'Work', 'Task', { runtimeId })).rejects.toThrow(
        'never on another computer',
      )
      expect(shells).toHaveLength(0)
      expect(moves).toHaveLength(0)
    })

    test('refuses an agent type no listed agent has, naming the ones there are', async () => {
      await expect(createAgentThread(actor, 'Work', 'Task', { provider: 'grok' })).rejects.toThrow(
        "No grok agent is available to this conversation's threads (available: codex, claude-code)",
      )
      expect(shells).toHaveLength(0)
    })

    test('refuses a runtimeId of another agent type than the provider asked', async () => {
      await expect(
        createAgentThread(actor, 'Work', 'Task', { runtimeId: MAC_CLAUDE, provider: 'codex' }),
      ).rejects.toThrow('is a claude-code agent, not codex')
      expect(shells).toHaveLength(0)
    })

    test.each([
      ['signed out', { online: true, signedIn: false }, 'signed out'],
      ['offline', { online: false, signedIn: true }, 'does not report'],
    ])('refuses an agent that is %s, and lists why', async (_case, state, reason) => {
      macClaude = state
      const listed = (await listThreadRuntimes(actor)).runtimes.find(
        (runtime) => runtime.runtimeId === MAC_CLAUDE,
      )

      expect(listed).toMatchObject({ ready: false })
      expect(listed?.notReady).toContain(reason)
      await expect(
        createAgentThread(actor, 'Work', 'Task', { provider: 'claude-code' }),
      ).rejects.toThrow(reason)
      expect(shells).toHaveLength(0)
    })

    test('a move the picker refuses hides the unused thread and starts nothing', async () => {
      moveError = new Error('The destination agent is not ready yet.')

      await expect(
        createAgentThread(actor, 'Work', 'Task', { provider: 'claude-code' }),
      ).rejects.toThrow('not ready yet')
      expect(archives).toEqual([[shells[0]?.sessionId, true]])
      expect(claims).toHaveLength(0)
    })

    test('update_thread moves a thread to that agent type and reads back where it runs', async () => {
      const { threadId } = await createAgentThread(actor, 'Work', 'Task')
      const result = await updateThread(actor, threadId, {
        provider: 'claude-code',
        model: 'claude-fable-5-1',
      })

      expect(moves.map((move) => move.runtimeId)).toEqual([MAC_CLAUDE])
      expect(result.runtime).toMatchObject({ agentRuntime: 'claude-code', runtimeId: MAC_CLAUDE })
      expect(result.model).toMatchObject({ model: 'claude-fable-5-1' })
      // Already there: nothing moves again.
      await updateThread(actor, threadId, { provider: 'claude-code' })
      expect(moves).toHaveLength(1)
      await expect(updateThread(actor, threadId, { runtimeId: OTHER_MAC_CLAUDE })).rejects.toThrow(
        'never on another computer',
      )
    })
  })

  test("sets a thread's model, then its effort, through the model picker", async () => {
    const { threadId } = await createAgentThread(actor, 'Work', 'Task', {
      model: 'gpt-6.1-sol',
    })

    expect(picks).toEqual([{ sessionId: threadId, configId: 'model', value: 'gpt-6.1-sol' }])
    const result = await updateThread(actor, threadId, { effort: 'high', model: 'default' })

    expect(picks.slice(1).map((pick) => pick.configId)).toEqual(['model', 'effort'])
    expect(result.model).toEqual({ model: 'default', effort: 'high' })
  })

  test('refuses a model the agent does not offer, naming the choices', async () => {
    await expect(createAgentThread(actor, 'Work', 'Task', { model: 'gpt-1' })).rejects.toThrow(
      'gpt-6.1-sol, default',
    )
    // Nothing ran; the unused conversation is archived.
    expect(claims).toHaveLength(0)
    expect(archives).toEqual([[shells[0]?.sessionId, true]])
  })

  test('send returns the delivered message id', async () => {
    const result = await sendAgentThreadMessage(actor, 'target', 'CI passed')

    expect(claims).toHaveLength(1)
    expect(result.messageId).toBe(claims[0]!.message.id)
  })

  test.each([
    ['another owner', { userId: 'teammate' }],
    ['another team', { teamId: 'other-team' }],
  ])('refuses %s', async (_, change) => {
    Object.assign(target, change)
    await expect(sendAgentThreadMessage(actor, 'target', 'Do work')).rejects.toThrow()
    await Bun.sleep(20)
    expect(claims).toHaveLength(0)
  })

  test('delivers to an archived thread, whose turn then restores it', async () => {
    target.archivedAt = new Date()
    await sendAgentThreadMessage(actor, 'target', 'Do work')
    expect(claims).toHaveLength(1)
  })

  test('delivers to an own thread with another runtime or credential selection', async () => {
    Object.assign(target, {
      runtimeId: 'other-runtime',
      agentRuntime: 'claude-code',
      credentialAccess: { ...access, awsRoleIds: ['role-1', 'role-2'] },
    })
    await sendAgentThreadMessage(actor, 'target', 'Do work')
    expect(claims).toHaveLength(1)
  })

  test('refuses self-delivery, unknown targets and non-owner source sessions', async () => {
    await expect(sendAgentThreadMessage(actor, 'source', 'Loop')).rejects.toThrow()
    await expect(sendAgentThreadMessage(actor, 'missing', 'Work')).rejects.toThrow()
    source.userId = 'teammate'
    await expect(createAgentThread(actor, 'Work', 'Task')).rejects.toThrow()
  })

  test('rechecks membership and ownership when the turn starts', async () => {
    const data = { ...actor, targetSessionId: 'target', messageId: 'delivery', prompt: 'Work' }

    member = false
    await expect(authorizeThreadDelivery(data)).rejects.toThrow()
    member = true
    target.userId = 'teammate'
    await expect(authorizeThreadDelivery(data)).rejects.toThrow()
  })
})

describe('archive thread', () => {
  test('archives and restores an owned thread, including the current one', async () => {
    expect(await setAgentThreadArchived(actor, 'target', true)).toMatchObject({
      threadId: 'target',
      archived: true,
    })
    target.archivedAt = new Date()
    await setAgentThreadArchived(actor, 'target', false)
    await setAgentThreadArchived(actor, 'source', true)
    expect(archives).toEqual([
      ['target', true],
      ['target', false],
      ['source', true],
    ])
  })
  test('rejects missing, foreign-owner and cross-team targets without a write', async () => {
    await expect(setAgentThreadArchived(actor, 'missing', true)).rejects.toThrow('Target must')
    target.userId = 'other'
    await expect(setAgentThreadArchived(actor, 'target', true)).rejects.toThrow('Target must')
    target.userId = actor.userId
    target.teamId = 'other-team'
    await expect(setAgentThreadArchived(actor, 'target', false)).rejects.toThrow('Target must')
    expect(archives).toEqual([])
  })
  test('rejects an actor who left the team', async () => {
    member = false
    await expect(setAgentThreadArchived(actor, 'target', true)).rejects.toThrow('still belong')
    expect(archives).toEqual([])
  })
})
