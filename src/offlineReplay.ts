import { randomUUID } from 'crypto'

import type { WAMessage } from './baileyWrapper'

export const OFFLINE_REPLAY_MESSAGE_EVENT = 'offline_replay_message'
export const OFFLINE_REPLAY_COMPLETE_EVENT = 'offline_replay_complete'

export interface OfflineReplayWindowState {
    windowId: string
    reconnectStartedAt: number
    sequence: number
    messageCount: number
}

export interface OfflineReplayMessageEvent {
    windowId: string
    reconnectStartedAt: number
    sequence: number
    messageId: string | null
    messageTimestamp: number | null
    upsertType: 'append' | 'notify'
    message: WAMessage
}

export interface OfflineReplayCompleteEvent {
    windowId: string
    reconnectStartedAt: number
    messageCount: number
}

type Emit = (event: string, payload: unknown) => unknown

/**
 * Tracks only the pending notification flush of an already-linked session.
 * Age/CRM policy belongs to the consumer because the provider must preserve
 * WhatsApp's original timestamp and payload without applying product rules.
 */
export class OfflineReplayWindow {
    private active: OfflineReplayWindowState | null = null
    private seenIds = new Set<string>()

    constructor(
        private readonly emit: Emit,
        private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
    ) {}

    open(wasRegistered: boolean): OfflineReplayWindowState | null {
        this.active = null
        this.seenIds.clear()
        if (!wasRegistered) return null

        this.active = {
            windowId: randomUUID(),
            reconnectStartedAt: this.nowSeconds(),
            sequence: 0,
            messageCount: 0,
        }
        return { ...this.active }
    }

    isActive(): boolean {
        return this.active !== null
    }

    capture(message: WAMessage, upsertType: 'append' | 'notify' = 'append'): boolean {
        if (!this.active) return false

        const messageId = message?.key?.id ?? null
        if (messageId && this.seenIds.has(messageId)) return false
        if (messageId) this.seenIds.add(messageId)

        this.active.sequence += 1
        this.active.messageCount += 1
        const event: OfflineReplayMessageEvent = {
            windowId: this.active.windowId,
            reconnectStartedAt: this.active.reconnectStartedAt,
            sequence: this.active.sequence,
            messageId,
            messageTimestamp: message?.messageTimestamp ? Number(message.messageTimestamp) : null,
            upsertType,
            message,
        }
        this.emit(OFFLINE_REPLAY_MESSAGE_EVENT, event)
        return true
    }

    complete(): OfflineReplayCompleteEvent | null {
        if (!this.active) return null

        const event: OfflineReplayCompleteEvent = {
            windowId: this.active.windowId,
            reconnectStartedAt: this.active.reconnectStartedAt,
            messageCount: this.active.messageCount,
        }
        this.active = null
        this.seenIds.clear()
        this.emit(OFFLINE_REPLAY_COMPLETE_EVENT, event)
        return event
    }
}
