import { describe, expect, jest, test } from '@jest/globals'

import {
    OFFLINE_REPLAY_COMPLETE_EVENT,
    OFFLINE_REPLAY_MESSAGE_EVENT,
    OfflineReplayWindow,
} from '../src/offlineReplay'

describe('OfflineReplayWindow', () => {
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
        replay.capture({ key: { id: 'm-1' }, messageTimestamp: 995 } as any)
        replay.capture({ key: { id: 'm-2' }, messageTimestamp: 996 } as any)

        expect(emit).toHaveBeenNthCalledWith(
            1,
            OFFLINE_REPLAY_MESSAGE_EVENT,
            expect.objectContaining({
                windowId: window?.windowId,
                reconnectStartedAt: 1_000,
                sequence: 1,
                messageId: 'm-1',
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
})
