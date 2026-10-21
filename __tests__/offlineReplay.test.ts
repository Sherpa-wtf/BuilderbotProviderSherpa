import { afterEach, describe, expect, jest, test } from '@jest/globals'

import {
    OFFLINE_REPLAY_COMPLETE_EVENT,
    OFFLINE_REPLAY_MESSAGE_EVENT,
    OfflineReplayWindow,
} from '../src/offlineReplay'

describe('OfflineReplayWindow', () => {
    test('publishes the documented replay event names', () => {
        expect(OFFLINE_REPLAY_MESSAGE_EVENT).toBe('offline.replay.message')
        expect(OFFLINE_REPLAY_COMPLETE_EVENT).toBe('offline.replay.complete')
    })

    test('ignores append traffic for a brand-new unregistered session', () => {
        const emit = jest.fn()
        const replay = new OfflineReplayWindow(emit, () => 1_000)

        replay.open(false)
        replay.capture({ key: { id: 'new-session-message' } } as any)
        replay.complete()

        expect(emit).not.toHaveBeenCalled()
    })

    test('emits ordered append messages without turning them into normal traffic', () => {
        const emit = jest.fn()
        const replay = new OfflineReplayWindow(emit, () => 1_000)

        const window = replay.open(true)
        replay.capture({ key: { id: 'm-1' }, messageTimestamp: 995 } as any, 'append')
        replay.capture({ key: { id: 'm-2' }, messageTimestamp: 996 } as any)

        expect(emit).toHaveBeenNthCalledWith(
            1,
            OFFLINE_REPLAY_MESSAGE_EVENT,
            expect.objectContaining({
                windowId: window?.windowId,
                reconnectStartedAt: 1_000,
                sequence: 1,
                messageId: 'm-1',
                upsertType: 'append',
            })
        )
        expect(emit).toHaveBeenNthCalledWith(
            2,
            OFFLINE_REPLAY_MESSAGE_EVENT,
            expect.objectContaining({ sequence: 2, messageId: 'm-2' })
        )
        expect(emit).not.toHaveBeenCalledWith('message', expect.anything())
    })

    test('deduplicates append ids and completes a window exactly once', () => {
        const emit = jest.fn()
        const replay = new OfflineReplayWindow(emit, () => 1_000)

        const window = replay.open(true)
        replay.capture({ key: { id: 'same-id' } } as any)
        replay.capture({ key: { id: 'same-id' } } as any)
        replay.complete()
        replay.complete()

        expect(emit).toHaveBeenCalledTimes(2)
        expect(emit).toHaveBeenLastCalledWith(OFFLINE_REPLAY_COMPLETE_EVENT, {
            windowId: window?.windowId,
            reconnectStartedAt: 1_000,
            messageCount: 1,
        })
    })

    test('ignores append messages outside an active reconnect window', () => {
        const emit = jest.fn()
        const replay = new OfflineReplayWindow(emit, () => 1_000)

        replay.capture({ key: { id: 'outside-window' } } as any)

        expect(emit).not.toHaveBeenCalled()
    })

    describe('cierre por silencio tras receivedPendingNotifications', () => {
        // Caso Cazala (bot 69310d0372d5565f8fefd5f9, 2026-10-13): Baileys emite el
        // flag apenas llega el marcador `offline`, con nodos offline todavia en
        // cola. Los `append` procesados despues del flag se perdian.
        afterEach(() => jest.useRealTimers())

        test('captura los append que llegan despues del flag y cierra recien tras el silencio', () => {
            jest.useFakeTimers()
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 1_000, { quietMs: 5_000 })

            const window = replay.open(true)
            replay.capture({ key: { id: '3AAB-antes' } } as any, 'append')
            replay.pendingNotificationsReceived()
            replay.capture({ key: { id: '3AABD677B3B81E657D81' } } as any, 'append')
            jest.advanceTimersByTime(4_999)
            replay.capture({ key: { id: '4A7AB9FFB1A20A27B02C' } } as any, 'append')
            jest.advanceTimersByTime(4_999)

            expect(replay.isActive()).toBe(true)
            expect(emit).not.toHaveBeenCalledWith(OFFLINE_REPLAY_COMPLETE_EVENT, expect.anything())

            jest.advanceTimersByTime(1)

            expect(emit).toHaveBeenCalledWith(
                OFFLINE_REPLAY_MESSAGE_EVENT,
                expect.objectContaining({ windowId: window?.windowId, sequence: 3, messageId: '4A7AB9FFB1A20A27B02C' })
            )
            expect(emit).toHaveBeenLastCalledWith(OFFLINE_REPLAY_COMPLETE_EVENT, {
                windowId: window?.windowId,
                reconnectStartedAt: 1_000,
                messageCount: 3,
            })
            expect(replay.isActive()).toBe(false)
        })

        test('deja de retener notify en vivo apenas llega el flag', () => {
            jest.useFakeTimers()
            const replay = new OfflineReplayWindow(jest.fn(), () => 1_000, { quietMs: 5_000 })

            replay.open(true)
            expect(replay.capturesLiveNotify()).toBe(true)

            replay.pendingNotificationsReceived()

            expect(replay.isActive()).toBe(true)
            expect(replay.capturesLiveNotify()).toBe(false)
        })

        test('el flag sin ventana activa no hace nada', () => {
            jest.useFakeTimers()
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 1_000, { quietMs: 5_000 })

            replay.pendingNotificationsReceived()
            jest.advanceTimersByTime(10_000)

            expect(emit).not.toHaveBeenCalled()
        })

        test('abrir una ventana nueva cancela el cierre programado de la anterior', () => {
            jest.useFakeTimers()
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 1_000, { quietMs: 5_000 })

            replay.open(true)
            replay.pendingNotificationsReceived()
            replay.open(true)
            jest.advanceTimersByTime(10_000)

            expect(replay.isActive()).toBe(true)
            expect(emit).not.toHaveBeenCalled()
        })
    })

    describe('append tardio sin ventana activa', () => {
        afterEach(() => jest.useRealTimers())

        test('reabre una ventana tardia, emite el mensaje y la cierra por silencio', () => {
            jest.useFakeTimers()
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 2_000, { quietMs: 5_000 })

            const result = replay.captureOffline({ key: { id: 'tardio-1' }, messageTimestamp: 1_990 } as any)

            expect(result).toBe('reopened')
            expect(emit).toHaveBeenCalledWith(
                OFFLINE_REPLAY_MESSAGE_EVENT,
                expect.objectContaining({ messageId: 'tardio-1', sequence: 1, reconnectStartedAt: 2_000, upsertType: 'append' })
            )
            expect(replay.capturesLiveNotify()).toBe(false)

            jest.advanceTimersByTime(5_000)

            expect(emit).toHaveBeenLastCalledWith(
                OFFLINE_REPLAY_COMPLETE_EVENT,
                expect.objectContaining({ messageCount: 1, reconnectStartedAt: 2_000 })
            )
        })

        test('con ventana activa captura en la misma ventana', () => {
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 2_000, { quietMs: 5_000 })

            const window = replay.open(true)

            expect(replay.captureOffline({ key: { id: 'en-ventana' } } as any)).toBe('captured')
            expect(emit).toHaveBeenCalledWith(
                OFFLINE_REPLAY_MESSAGE_EVENT,
                expect.objectContaining({ windowId: window?.windowId, messageId: 'en-ventana' })
            )
        })

        test('no reemite un id ya capturado en una ventana anterior', () => {
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 2_000, { quietMs: 5_000 })

            replay.open(true)
            replay.capture({ key: { id: 'repetido' } } as any, 'append')
            replay.complete()
            emit.mockClear()

            expect(replay.captureOffline({ key: { id: 'repetido' } } as any)).toBe('duplicate')
            expect(replay.wasCaptured('repetido')).toBe(true)
            expect(emit).not.toHaveBeenCalled()
            expect(replay.isActive()).toBe(false)
        })

        test('no recuerda stubs sin contenido: el reintento descifrado tiene el mismo id', () => {
            const replay = new OfflineReplayWindow(jest.fn(), () => 2_000, { quietMs: 5_000 })

            replay.open(true)
            replay.capture({ key: { id: 'cifrado-1' }, messageStubType: 2 } as any, 'append')

            expect(replay.wasCaptured('cifrado-1')).toBe(false)
        })

        test('la ventana tardia hereda reconnectStartedAt de la conexion y no vuelve stale un mensaje del borde', () => {
            jest.useFakeTimers()
            let now = 10_000
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => now, { quietMs: 5_000 })

            replay.startConnection(true)
            replay.pendingNotificationsReceived()
            jest.advanceTimersByTime(5_000)
            now = 10_020
            replay.captureOffline({ key: { id: 'borde-595s' }, messageTimestamp: 9_405, message: {} } as any)

            // El consumer descarta lo que sea < reconnectStartedAt - 600.
            expect(emit).toHaveBeenLastCalledWith(
                OFFLINE_REPLAY_MESSAGE_EVENT,
                expect.objectContaining({ messageId: 'borde-595s', reconnectStartedAt: 10_000 })
            )
        })

        test('sin ventana principal en la conexion la tardia usa el momento en que arranco el socket', () => {
            let now = 10_000
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => now, { quietMs: 5_000 })

            replay.startConnection(false)
            now = 10_020
            replay.captureOffline({ key: { id: 'sin-principal' }, message: {} } as any)

            expect(emit).toHaveBeenLastCalledWith(
                OFFLINE_REPLAY_MESSAGE_EVENT,
                expect.objectContaining({ reconnectStartedAt: 10_000 })
            )
        })

        test('una ventana a demanda no corre el inicio de la conexion', () => {
            let now = 10_000
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => now, { quietMs: 5_000 })

            replay.startConnection(true)
            replay.complete()
            now = 10_300
            replay.open(true)
            replay.complete()
            now = 10_320
            replay.captureOffline({ key: { id: 'tras-demanda' }, message: {} } as any)

            expect(emit).toHaveBeenLastCalledWith(
                OFFLINE_REPLAY_MESSAGE_EVENT,
                expect.objectContaining({ reconnectStartedAt: 10_000 })
            )
        })

        test('cancel descarta la ventana y su cierre programado sin emitir complete', () => {
            jest.useFakeTimers()
            const emit = jest.fn()
            const replay = new OfflineReplayWindow(emit, () => 1_000, { quietMs: 5_000 })

            replay.open(true)
            replay.pendingNotificationsReceived()
            replay.cancel()
            jest.advanceTimersByTime(10_000)

            expect(replay.isActive()).toBe(false)
            expect(emit).not.toHaveBeenCalled()
        })

        test('recuerda una cantidad acotada de ids', () => {
            const replay = new OfflineReplayWindow(jest.fn(), () => 2_000, { quietMs: 5_000, maxRememberedIds: 2 })

            replay.open(true)
            replay.capture({ key: { id: 'a' } } as any)
            replay.capture({ key: { id: 'b' } } as any)
            replay.capture({ key: { id: 'c' } } as any)

            expect(replay.wasCaptured('a')).toBe(false)
            expect(replay.wasCaptured('b')).toBe(true)
            expect(replay.wasCaptured('c')).toBe(true)
        })
    })
})
