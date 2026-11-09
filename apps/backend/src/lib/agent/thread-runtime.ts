import { parseLocalRuntimeId } from '@/lib/agent/devices/local-runtime/address'
import {
  listRuntimeInstances,
  listRuntimeQuotas,
  withRuntimeReadiness,
} from '@/lib/claude-code-preview/runtime-catalog'
import { conversationSessionConfig } from '@/lib/claude-code-preview/session-config'
import { pickOf } from '@/lib/claude-code-preview/session-config-options'
import { AppError } from '@/lib/errors'

import { getConversationBySessionId } from './db'

import type { AgentConversation } from './db'
import type { CredentialRef } from './thread-credentials'
import type { RuntimeInstance } from '@/lib/claude-code-preview/runtime-instances'

// What a thread runs on: its agent, and the model and effort it uses there.

type Actor = { teamId: string; userId: string }

/**
 * Whether a local agent is on the computer the parent itself runs on, and that
 * computer is the owner's own. The parent's turns already run there as the owner,
 * so another agent on it reaches no new machine. A teammate's shared computer, or
 * any other computer, stays the owner's own choice in the Desktop.
 */
function onParentComputer(actor: Actor, instance: RuntimeInstance, parentRuntimeId?: string) {
  if (instance.kind !== 'local' || !parentRuntimeId || instance.local?.shared) return false
  const parent = parseLocalRuntimeId(parentRuntimeId)
  const agent = parseLocalRuntimeId(instance.id)

  return (
    parent !== undefined &&
    agent !== undefined &&
    parent.userId === actor.userId &&
    agent.userId === actor.userId &&
    instance.local?.ownerUserId === actor.userId &&
    agent.deviceId === parent.deviceId
  )
}

/**
 * The team's agents, the owner's Boxes, and the other agents on the owner's
 * computer the parent runs on. Never an agent on another computer, which only
 * its owner can choose, with the consent the Desktop asks for.
 */
export async function threadRuntimeInstances(actor: Actor, parentRuntimeId?: string) {
  return (await listRuntimeInstances(actor.teamId, actor.userId)).filter(
    (instance) =>
      instance.kind !== 'local' ||
      instance.local?.box !== undefined ||
      onParentComputer(actor, instance, parentRuntimeId),
  )
}

/** Why a computer's agent cannot take a turn now (offline or signed out), or nothing. */
function notReadyReason(instance: RuntimeInstance): string | undefined {
  if (instance.kind !== 'local' || instance.local?.box) return
  if (!instance.local?.online) return 'the computer does not report this agent right now.'
  if (instance.local.signedIn === false) return 'its CLI is signed out on that computer.'
}

/** Those agents with each one's readiness and usage, marking the one a conversation runs on. */
export async function threadRuntimes(actor: Actor, currentRuntimeId: string | undefined) {
  const instances = await withRuntimeReadiness(
    actor.teamId,
    await threadRuntimeInstances(actor, currentRuntimeId),
  )
  const quotas = await listRuntimeQuotas(actor.teamId, instances)

  return {
    runtimes: instances.map((instance, i) => {
      const reason = notReadyReason(instance)

      return {
        runtimeId: instance.id,
        label: instance.label,
        provider: instance.provider,
        kind: instance.kind,
        ...(onParentComputer(actor, instance, currentRuntimeId)
          ? { sameComputer: true as const }
          : {}),
        status: instance.status,
        ready: !instance.notReady && !reason,
        ...(reason ? { notReady: reason } : {}),
        current: instance.id === currentRuntimeId,
        quota: quotas[i],
      }
    }),
  }
}

export type ThreadRuntimePick = { runtimeId?: string; provider?: string }

/** The one agent of a provider a pick means, or a refusal naming the choices. */
function agentOfProvider(
  actor: Actor,
  candidates: RuntimeInstance[],
  provider: string,
  parentRuntimeId: string | undefined,
  currentRuntimeId: string | undefined,
): RuntimeInstance {
  const ofProvider = candidates.filter((instance) => instance.provider === provider)
  const sameComputer = ofProvider.filter((instance) =>
    onParentComputer(actor, instance, parentRuntimeId),
  )
  const target =
    ofProvider.find(({ id }) => id === currentRuntimeId) ??
    ofProvider.find(({ id }) => id === parentRuntimeId) ??
    (sameComputer.length === 1 ? sameComputer[0] : undefined) ??
    (ofProvider.length === 1 ? ofProvider[0] : undefined)

  if (target) return target
  if (ofProvider.length)
    throw new Error(
      `Several ${provider} agents are available; pass runtimeId, one of: ${ofProvider
        .map(({ id }) => id)
        .join(', ')}.`,
    )
  const providers = [...new Set(candidates.map((instance) => instance.provider))]

  throw new Error(
    `No ${provider} agent is available to this conversation's threads ` +
      `(available: ${providers.join(', ') || 'none'}). Sign it in on this computer, ` +
      'or ask a team admin to add one.',
  )
}

/**
 * The agent a thread should run on: `runtimeId` as listed, or the one agent of
 * `provider`, preferring the parent's own agent, then one on the parent's
 * computer. Returns undefined when nothing was asked or the pick is
 * `currentRuntimeId`. Refuses an agent thread tools may not use, or one that
 * cannot run now, before anything is written.
 */
export async function resolveThreadRuntime(
  actor: Actor,
  parentRuntimeId: string | undefined,
  pick: ThreadRuntimePick,
  currentRuntimeId: string | undefined = parentRuntimeId,
): Promise<RuntimeInstance | undefined> {
  if (!pick.runtimeId && !pick.provider) return
  const candidates = await threadRuntimeInstances(actor, parentRuntimeId)
  let target: RuntimeInstance | undefined

  if (pick.runtimeId) {
    target = candidates.find(({ id }) => id === pick.runtimeId)
    if (!target)
      throw new Error(
        "A thread can only run on one of the team's agents, your Boxes, or another agent on " +
          'the computer this conversation runs on, never on another computer. ' +
          'Pick a runtimeId from list_agent_runtimes.',
      )
    if (pick.provider && target.provider !== pick.provider)
      throw new Error(`runtimeId ${target.id} is a ${target.provider} agent, not ${pick.provider}.`)
  } else {
    target = agentOfProvider(
      actor,
      candidates,
      pick.provider ?? '',
      parentRuntimeId,
      currentRuntimeId,
    )
  }
  if (target.id === currentRuntimeId) return
  const reason = notReadyReason(target)

  if (reason) throw new Error(`${target.label} cannot run a thread now: ${reason}`)
  if (target.status !== 'active') throw new Error(`${target.label} is disabled.`)

  return target
}

/** The parent's project folder is on its computer: another agent there opens it too. */
export function threadWorkspace(
  workspace: AgentConversation['workspace'],
  runtime: RuntimeInstance | undefined,
): AgentConversation['workspace'] {
  return workspace && runtime?.kind === 'local' && !runtime.local?.box
    ? { ...workspace, runtimeId: runtime.id }
    : workspace
}

/**
 * Puts a thread on another agent through the picker's own move: its owner,
 * enabled, deletion and reachability checks, and its lock.
 */
export async function moveThread(threadId: string, runtimeId: string, userId: string) {
  const thread = await getConversationBySessionId(threadId)

  if (!thread) throw new Error('Thread not found.')
  const { moveConversationRuntime } =
    await import('@/lib/claude-code-preview/conversation-runtime-move')

  await moveConversationRuntime(thread, runtimeId, 'history', userId)
}

/** The agent the stored thread runs on, read back rather than assumed. */
export async function threadPlacement(threadId: string) {
  const thread = await getConversationBySessionId(threadId)

  return {
    agentRuntime: thread?.agentRuntime,
    runtimeId: thread?.runtimeId,
    runtimeLabel: thread?.runtimeLabel,
  }
}

export type ThreadModelPick = { model?: string; effort?: string }

/** What update_thread may change on a thread. */
export type ThreadChange = {
  fullAccess?: boolean
  grant?: CredentialRef[]
  revoke?: CredentialRef[]
} & ThreadModelPick &
  ThreadRuntimePick

/**
 * Sets a thread's model and effort as the conversation's model picker does, so
 * the runtime's own catalog decides what is valid. The model goes first: the
 * efforts on offer depend on it. Nothing to set returns nothing.
 */
export async function setThreadModel(threadId: string, userId: string, pick: ThreadModelPick) {
  if (!pick.model && !pick.effort) return
  let options: Awaited<ReturnType<typeof conversationSessionConfig>>['options'] = []

  for (const configId of ['model', 'effort'] as const) {
    const value = pick[configId]

    if (!value) continue
    const conversation = await getConversationBySessionId(threadId)

    if (!conversation) throw new Error('Thread not found.')
    try {
      ;({ options } = await conversationSessionConfig(conversation, { configId, value }, userId))
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'invalid_runtime_config') throw error
      const offered = (await conversationSessionConfig(conversation, undefined, userId)).options
      const choices = offered.find((option) => option.kind === configId)?.options ?? []
      const agent = conversation.agentRuntime ? ` (${conversation.agentRuntime})` : ''

      throw new Error(
        `${configId} "${value}" is not offered by the thread's agent${agent}. Choose one of: ${
          choices.map((choice) => choice.value).join(', ') || 'none'
        }.${configId === 'model' ? ' For another agent type, pass provider or runtimeId.' : ''}`,
        { cause: error },
      )
    }
  }

  return pickOf(options)
}
