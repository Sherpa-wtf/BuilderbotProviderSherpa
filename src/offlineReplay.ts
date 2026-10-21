import { randomUUID } from 'crypto'

import type { WAMessage } from './baileyWrapper'

export const OFFLINE_REPLAY_MESSAGE_EVENT = 'offline.replay.message'
export const OFFLINE_REPLAY_COMPLETE_EVENT = 'offline.replay.complete'

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
    upsertType: 'append' | 'notify' | 'history'
    message: WAMessage
}

export interface OfflineReplayCompleteEvent {
    windowId: string
    reconnectStartedAt: number
    messageCount: number
}

type Emit = (event: string, payload: unknown) => unknown

export type OfflineCaptureResult = 'captured' | 'reopened' | 'duplicate'

export interface OfflineReplayWindowOptions {
    /**
     * Silencio (sin mensajes offline nuevos) que se espera despues de
     * `receivedPendingNotifications` antes de cerrar la ventana.
     */
    quietMs?: number
    /** Tope de ids recordados entre ventanas para no reemitir duplicados. */
    maxRememberedIds?: number
    log?: (line: string) => void
}

export const DEFAULT_OFFLINE_REPLAY_QUIET_MS = 5_000
const DEFAULT_MAX_REMEMBERED_IDS = 5_000

/**
 * Tracks only the pending notification flush of an already-linked session.
 * Age/CRM policy belongs to the consumer because the provider must preserve
 * WhatsApp's original timestamp and payload without applying product rules.
 *
 * Baileys 7 emite `receivedPendingNotifications` apenas llega el marcador
 * `offline`, pero los nodos offline siguen en cola y salen despues como
 * `append`. Por eso la ventana no cierra con el flag: cierra cuando pasan
 * `quietMs` sin mensajes offline nuevos.
 */
export class OfflineReplayWindow {
    private active: OfflineReplayWindowState | null = null
    private pendingNotificationsFlushed = false
    private quietTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * Inicio de la reconexion del socket actual. Una ventana tardia lo hereda:
     * el consumer corta por antiguedad contra este valor, y tomar la hora de
     * apertura de la tardia volveria stale un mensaje del borde de 10 min.
     */
    private connectionStartedAt: number | null = null
    /** Orden de insercion = orden de descarte cuando se llena. */
    private rememberedIds = new Set<string>()
    private readonly quietMs: number
    private readonly maxRememberedIds: number

    constructor(
        private readonly emit: Emit,
        private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
        private readonly options: OfflineReplayWindowOptions = {}
    ) {
        this.quietMs = Number.isFinite(options.quietMs) && Number(options.quietMs) >= 0
            ? Number(options.quietMs)
            : DEFAULT_OFFLINE_REPLAY_QUIET_MS
        this.maxRememberedIds = Number(options.maxRememberedIds) > 0
            ? Number(options.maxRememberedIds)
            : DEFAULT_MAX_REMEMBERED_IDS
    }

    /** Socket nuevo: fija el inicio de la reconexion y abre la ventana principal. */
    startConnection(wasRegistered: boolean): OfflineReplayWindowState | null {
        this.connectionStartedAt = this.nowSeconds()
        return this.open(wasRegistered)
    }

    open(wasRegistered: boolean): OfflineReplayWindowState | null {
        this.cancel()
        if (!wasRegistered) return null

        return this.start()
    }

    /** Descarta la ventana y su cierre programado sin emitir complete. */
    cancel(): void {
        this.cancelQuietTimer()
        this.active = null
        this.pendingNotificationsFlushed = false
    }

    isActive(): boolean {
        return this.active !== null
    }

    /**
     * Un `notify` es trafico en vivo una vez que WhatsApp termino de mandar lo
     * pendiente: despues del flag no se retiene en la ventana.
     */
    capturesLiveNotify(): boolean {
        return this.active !== null && !this.pendingNotificationsFlushed
    }

    wasCaptured(messageId: string | null | undefined): boolean {
        return Boolean(messageId) && this.rememberedIds.has(messageId as string)
    }

    /** WhatsApp avisa que no quedan notificaciones pendientes en el servidor. */
    pendingNotificationsReceived(): void {
        if (!this.active) return
        this.pendingNotificationsFlushed = true
        this.armQuietTimer()
    }

    capture(message: WAMessage, upsertType: 'append' | 'notify' | 'history' = 'append'): boolean {
        if (!this.active) return false

        const messageId = message?.key?.id ?? null
        if (messageId && this.rememberedIds.has(messageId)) return false
        // Un stub (p. ej. descifrado fallido) se reentrega despues con el mismo
        // id y el contenido real: recordarlo bloquearia ese reintento.
        if (messageId && !message?.messageStubType) this.remember(messageId)

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
        if (this.pendingNotificationsFlushed) this.armQuietTimer()
        return true
    }

    /**
     * Mensaje offline (`append`) que puede llegar con la ventana ya cerrada:
     * Baileys ya lo confirmo y WhatsApp no lo reenvia, asi que en vez de
     * descartarlo se abre una ventana tardia que cierra por silencio.
     */
    captureOffline(message: WAMessage): OfflineCaptureResult {
        if (this.wasCaptured(message?.key?.id)) return 'duplicate'
        if (this.active) return this.capture(message, 'append') ? 'captured' : 'duplicate'

        this.start(this.connectionStartedAt ?? undefined)
        this.pendingNotificationsFlushed = true
        this.capture(message, 'append')
        return 'reopened'
    }

    complete(): OfflineReplayCompleteEvent | null {
        this.cancelQuietTimer()
        if (!this.active) return null

        const event: OfflineReplayCompleteEvent = {
            windowId: this.active.windowId,
            reconnectStartedAt: this.active.reconnectStartedAt,
            messageCount: this.active.messageCount,
        }
        this.active = null
        this.pendingNotificationsFlushed = false
        this.emit(OFFLINE_REPLAY_COMPLETE_EVENT, event)
        return event
    }

    private start(reconnectStartedAt: number = this.nowSeconds()): OfflineReplayWindowState {
        this.active = {
            windowId: randomUUID(),
            reconnectStartedAt,
            sequence: 0,
            messageCount: 0,
        }
        return { ...this.active }
    }

    private remember(messageId: string): void {
        this.rememberedIds.add(messageId)
        if (this.rememberedIds.size <= this.maxRememberedIds) return
        const oldest = this.rememberedIds.values().next().value
        if (oldest !== undefined) this.rememberedIds.delete(oldest)
    }

    private armQuietTimer(): void {
        this.cancelQuietTimer()
        this.quietTimer = setTimeout(() => {
            this.quietTimer = null
            const closed = this.complete()
            if (closed) {
                this.options.log?.(
                    `[OFFLINE_REPLAY_CIERRE_POR_SILENCIO] window=${closed.windowId} mensajes=${closed.messageCount} silencio_ms=${this.quietMs}`
                )
            }
        }, this.quietMs)
        this.quietTimer.unref?.()
    }

    private cancelQuietTimer(): void {
        if (!this.quietTimer) return
        clearTimeout(this.quietTimer)
        this.quietTimer = null
    }
}
