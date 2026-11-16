import { useSyncExternalStore } from 'react'
import type { WorkerRole } from '@shared/models/autoEdit'

/** Where an agent's cursor is on the timeline: an instant and a lane, with a word on what it is doing. */
export interface AgentCursor {
  role: WorkerRole
  timeMs: number
  /** Which lane the cursor sits on, by the class of its element on the timeline. */
  lane: string
  label: string
  color: string
  /** Counts up with every move, so the timeline can flash the cursor on each one. */
  tick: number
}

/**
 * The cursors of the agents while their work is being shown: one per agent,
 * moved by the editor as it replays the agent's actions, read by the timeline
 * to draw them. Cosmetic: nothing here touches the project.
 */
class AgentCursorsStore {
  private cursors: ReadonlyMap<WorkerRole, AgentCursor> = new Map()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly AgentCursor[] = []

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): readonly AgentCursor[] => this.snapshot

  move(cursor: Omit<AgentCursor, 'tick'>): void {
    const next = new Map(this.cursors)
    next.set(cursor.role, { ...cursor, tick: (this.cursors.get(cursor.role)?.tick ?? 0) + 1 })
    this.commit(next)
  }

  remove(role: WorkerRole): void {
    const next = new Map(this.cursors)
    next.delete(role)
    this.commit(next)
  }

  clear(): void {
    this.commit(new Map())
  }

  private commit(next: ReadonlyMap<WorkerRole, AgentCursor>): void {
    this.cursors = next
    this.snapshot = [...next.values()]
    for (const listener of this.listeners) listener()
  }
}

export const agentCursors = new AgentCursorsStore()

export const useAgentCursors = (): readonly AgentCursor[] => useSyncExternalStore(agentCursors.subscribe, agentCursors.getState)
