import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { Sticker } from 'wa-sticker-formatter'
import { BaileysProvider } from '../src'

jest.mock('../src/baileyWrapper', () => ({
    downloadMediaMessage: jest.fn(),
    getAggregateVotesInPollMessage: jest.fn(() => [{ name: 'A', voters: ['1'] }]),
    makeCacheableSignalKeyStore: jest.fn((keys: unknown) => keys),
    makeWASocketOther: jest.fn(),
    isJidGroup: jest.fn(() => false),
    isJidBroadcast: jest.fn(() => false),
    DisconnectReason: {},
    proto: { Message: { fromObject: jest.fn(() => ({})) } },
    useMultiFileAuthState: jest.fn(async () => ({
        state: { creds: { registered: true }, keys: {} },
        saveCreds: jest.fn(),
    })),
}))

jest.mock('wa-sticker-formatter', () => ({
    Sticker: jest.fn(() => ({
        toMessage: jest.fn(async () => ({ sticker: Buffer.from('sticker') })),
    })),
}))

jest.mock('@builderbot/bot')

const providerArgs = {
    name: 'outbound-test',
    phoneNumber: '+5491111111111',
    port: 3099,
}

describe('BaileysProvider durable outbound primitives', () => {
    let provider: BaileysProvider
    let sendMessage: jest.Mock

    beforeEach(() => {
        provider = new BaileysProvider(providerArgs as any)
        sendMessage = jest.fn(async (jid: string, _content: unknown, options?: any) => ({
            key: { id: options?.messageId ?? 'generated-id', remoteJid: jid, fromMe: true },
            message: { conversation: 'sent' },
        }))
        provider.vendor = { sendMessage } as any
        provider.emit = jest.fn() as any
    })

    test('injects the requested messageId into the actual vendor send and leaves normal sends unchanged', async () => {
        await provider.runWithMessageId('3EB0AAAAAAAAAAAAAAAAAA', () =>
            provider.sendText('5491111111111@s.whatsapp.net', 'hola'),
        )
        await provider.sendText('5491111111111@s.whatsapp.net', 'normal')

        expect(sendMessage.mock.calls[0][2]).toEqual({
            messageId: '3EB0AAAAAAAAAAAAAAAAAA',
        })
        expect(sendMessage.mock.calls[0][1]).toEqual({ text: 'hola' })
        expect(sendMessage.mock.calls[1]).toHaveLength(2)
    })

    test('rejects blank message ids, trims valid ids and never lets helper options override them', async () => {
        await expect(
            provider.runWithMessageId('   ', () => provider.sendText('blank@s.whatsapp.net', 'nope')),
        ).rejects.toThrow('messageId is required')
        await expect(
            (provider as any).runWithMessageId(undefined, () => provider.sendText('missing@s.whatsapp.net', 'nope')),
        ).rejects.toThrow('messageId is required')

        await provider.runWithMessageId('  3EB0TRIMMEDTRIMMEDTRIM  ', () =>
            (provider as any).sendVendorMessage(
                'trimmed@s.whatsapp.net',
                { text: 'hola' },
                { quoted: { key: { id: 'quoted' } }, messageId: 'must-not-win' },
            ),
        )

        expect(sendMessage).toHaveBeenCalledTimes(1)
        expect(sendMessage.mock.calls[0][2]).toEqual({
            quoted: { key: { id: 'quoted' } },
            messageId: '3EB0TRIMMEDTRIMMEDTRIM',
        })
    })

    test('preserves helper options outside a deterministic id context', async () => {
        const quoted = { key: { id: 'quoted-without-context' } }

        await provider.sendLocation('plain-location@s.whatsapp.net', -34.6, -58.4, quoted)

        expect(sendMessage.mock.calls[0][2]).toEqual({ quoted })
        expect(sendMessage.mock.calls[0][2]).not.toHaveProperty('messageId')
    })

    test('isolates concurrent and nested messageId contexts', async () => {
        const release: Array<() => void> = []
        const wait = () => new Promise<void>((resolve) => release.push(resolve))

        const first = provider.runWithMessageId('3EB0FIRSTFIRSTFIRSTFIRST', async () => {
            await wait()
            await provider.sendText('first@s.whatsapp.net', 'first')
            await provider.runWithMessageId('3EB0INNERINNERINNERINNER', () =>
                provider.sendText('inner@s.whatsapp.net', 'inner'),
            )
            await provider.sendText('outer@s.whatsapp.net', 'outer')
        })
        const second = provider.runWithMessageId('3EB0SECONDSECONDSECONDSE', async () => {
            await wait()
            await provider.sendText('second@s.whatsapp.net', 'second')
        })

        release.splice(0).forEach((resolve) => resolve())
        await Promise.all([first, second])

        const idsByJid = Object.fromEntries(
            sendMessage.mock.calls.map(([jid, _content, options]) => [jid, (options as any)?.messageId]),
        )
        expect(idsByJid).toEqual({
            'first@s.whatsapp.net': '3EB0FIRSTFIRSTFIRSTFIRST',
            'inner@s.whatsapp.net': '3EB0INNERINNERINNERINNER',
            'outer@s.whatsapp.net': '3EB0FIRSTFIRSTFIRSTFIRST',
            'second@s.whatsapp.net': '3EB0SECONDSECONDSECONDSE',
        })
    })

    test('returns the real provider response for location, contact and sticker', async () => {
        const location = await provider.runWithMessageId('3EB0LOCATIONLOCATIONLO', () =>
            provider.sendLocation('location@s.whatsapp.net', -34.6, -58.4, { key: { id: 'quoted' } }),
        )
        const contact = await provider.runWithMessageId('3EB0CONTACTCONTACTCONT', () =>
            provider.sendContact(
                'contact@s.whatsapp.net',
                '+54 9 11 1111 1111' as any,
                'Ada',
                'Sherpa',
            ),
        )
        const sticker = await provider.runWithMessageId('3EB0STICKERSTICKERSTI', () =>
            provider.sendSticker('sticker@s.whatsapp.net', Buffer.from('image'), {}),
        )

        expect(location.key.id).toBe('3EB0LOCATIONLOCATIONLO')
        expect(contact.key.id).toBe('3EB0CONTACTCONTACTCONT')
        expect(sticker.key.id).toBe('3EB0STICKERSTICKERSTI')
        expect(sendMessage.mock.calls[0][2]).toEqual({
            quoted: { key: { id: 'quoted' } },
            messageId: '3EB0LOCATIONLOCATIONLO',
        })
        expect(sendMessage.mock.calls[0][1]).toEqual({
            location: {
                degreesLatitude: -34.6,
                degreesLongitude: -58.4,
            },
        })
        expect(sendMessage.mock.calls[1][1]).toEqual({
            contacts: {
                displayName: '.',
                contacts: [{
                    vcard: [
                        'BEGIN:VCARD',
                        'VERSION:3.0',
                        'FN:Ada',
                        'ORG:Sherpa;',
                        'TEL;type=CELL;type=VOICE;waid=5491111111111:+5491111111111',
                        'END:VCARD',
                    ].join('\n'),
                }],
            },
        })
        expect(sendMessage.mock.calls[1][2]).toEqual({
            quoted: null,
            messageId: '3EB0CONTACTCONTACTCONT',
        })
        expect(Sticker).toHaveBeenCalledWith(Buffer.from('image'), {
            quality: 50,
            type: 'crop',
        })
        expect(sendMessage.mock.calls[2][1]).toEqual({ sticker: Buffer.from('sticker') })
        expect(sendMessage.mock.calls[2][2]).toEqual({
            quoted: null,
            messageId: '3EB0STICKERSTICKERSTI',
        })
    })

    test('routes every current high-level outbound helper through the deterministic id context', async () => {
        const sends: Array<[string, () => Promise<unknown>]> = [
            ['3EB0IMAGEIMAGEIMAGEIMAGE', () => provider.sendImage('image@s.whatsapp.net', '/tmp/image.jpg', 'image')],
            ['3EB0VIDEOVIDEOVIDEOVIDE', () => provider.sendVideo('video@s.whatsapp.net', __filename, 'video')],
            ['3EB0AUDIOAUDIOAUDIOAUDIO', () => provider.sendAudio('audio@s.whatsapp.net', '/tmp/audio.ogg')],
            ['3EB0TEXTTEXTTEXTTEXTTEXT', () => provider.sendText('text@s.whatsapp.net', 'text')],
            ['3EB0FILEFILEFILEFILEFILE', () => provider.sendFile('file@s.whatsapp.net', '/tmp/document.pdf', 'file')],
            [
                '3EB0BUTTONBUTTONBUTTONBU',
                () => provider.sendButtons('5491111111111', 'choose', [{ body: 'A' }] as any),
            ],
        ]

        for (const [messageId, send] of sends) {
            await provider.runWithMessageId(messageId, send)
        }

        expect(sendMessage.mock.calls.map(([, , options]) => (options as any)?.messageId)).toEqual(
            sends.map(([messageId]) => messageId),
        )
    })

    test.each([
        [0, 'error'],
        [1, 'pending'],
        [2, 'server_ack'],
        [3, 'delivery_ack'],
        [4, 'read'],
        [5, 'played'],
        [99, 'unknown'],
    ])('normalizes messages.update status %s as %s without suppressing it', async (status, stage) => {
        const handler = (provider as any)
            .busEvents()
            .find((entry: any) => entry.event === 'messages.update').func

        await handler([
            {
                key: {
                    id: '3EB0STATUSSTATUSSTATUSST',
                    remoteJid: '5491111111111@s.whatsapp.net',
                    fromMe: true,
                },
                update: {
                    status,
                    messageStubParameters: status === 0 ? ['server rejected'] : undefined,
                },
            },
        ])

        expect(provider.emit).toHaveBeenCalledWith(
            'message_status',
            expect.objectContaining({
                provider: 'baileys',
                providerMessageId: '3EB0STATUSSTATUSSTATUSST',
                remoteJid: '5491111111111@s.whatsapp.net',
                fromMe: true,
                status,
                stage,
                observedAt: expect.any(String),
            }),
        )
        if (status === 0) {
            expect(((provider.emit as jest.Mock).mock.calls[0][1] as any).error).toEqual({
                messageStubParameters: ['server rejected'],
            })
        }
    })

    test('bounds and sanitizes provider error evidence without leaking useless fields', async () => {
        const handler = (provider as any)
            .busEvents()
            .find((entry: any) => entry.event === 'messages.update').func
        const longMessage = `  ${'x'.repeat(700)}  `

        await handler([
            {
                key: { id: '3EB0ERRORERRORERRORERRO', fromMe: true },
                update: {
                    status: 0,
                    messageStubParameters: [' first ', '', null, 42, {}, 'six', 'seven', 'eight', 'nine', longMessage, 'ignored'],
                    error: { code: 429, name: ' Boom ', message: longMessage },
                },
            },
        ])

        const event = (provider.emit as jest.Mock).mock.calls[0][1] as any
        expect(event.error).toEqual({
            messageStubParameters: ['first', '42', 'six', 'seven', 'eight', 'nine', 'x'.repeat(512)],
            code: '429',
            name: 'Boom',
            message: 'x'.repeat(512),
        })

        ;(provider.emit as jest.Mock).mockClear()
        await handler([
            {
                key: { id: '3EB0EMPTYERROREMPTYERR', fromMe: true },
                update: { status: 0, messageStubParameters: ['', null, {}] },
            },
        ])

        expect((provider.emit as jest.Mock).mock.calls[0][1]).not.toHaveProperty('error')

        ;(provider.emit as jest.Mock).mockClear()
        await handler([
            {
                key: { id: '3EB0MALFORMEDERRORMALF', fromMe: true },
                update: { status: 0, messageStubParameters: { invalid: true } },
            },
        ])

        expect((provider.emit as jest.Mock).mock.calls[0][1]).not.toHaveProperty('error')

        ;(provider.emit as jest.Mock).mockClear()
        await handler([
            {
                key: { id: '3EB0NONERRORNONERRORNON', fromMe: true },
                update: {
                    status: 2,
                    error: { code: 500, name: 'must-not-leak', message: 'not an error status' },
                    messageStubParameters: ['must-not-leak'],
                },
            },
        ])

        expect((provider.emit as jest.Mock).mock.calls[0][1]).not.toHaveProperty('error')
    })

    test('does not emit a status event without both a provider id and a finite status', async () => {
        const handler = (provider as any)
            .busEvents()
            .find((entry: any) => entry.event === 'messages.update').func

        await handler([
            { key: undefined, update: { status: 2 } },
            { key: { id: '', fromMe: true }, update: { status: 2 } },
            { key: { id: '3EB0NOSTATUSNOSTATUSNO', fromMe: true }, update: {} },
            { key: { id: '3EB0NULLSTATUSNULLSTATU', fromMe: true }, update: { status: null } },
            { key: { id: '3EB0NANSTATUSNANSTATUS', fromMe: true }, update: { status: 'not-a-number' } },
        ])

        expect(provider.emit).not.toHaveBeenCalledWith('message_status', expect.anything())
    })

    test('preserves the existing poll update behavior while also emitting the status event', async () => {
        jest.spyOn(provider as any, 'getMessage').mockResolvedValue({ pollCreationMessage: {} })
        const handler = (provider as any)
            .busEvents()
            .find((entry: any) => entry.event === 'messages.update').func

        await handler([
            {
                key: {
                    id: '3EB0POLLSTATUSPOLLSTATU',
                    remoteJid: '5491111111111@s.whatsapp.net',
                    fromMe: true,
                },
                update: { status: 2, pollUpdates: [{}] },
            },
        ])

        expect(provider.emit).toHaveBeenCalledWith(
            'message_status',
            expect.objectContaining({ stage: 'server_ack' }),
        )
        expect(provider.emit).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({ type: 'poll', body: 'A' }),
        )
    })
})
