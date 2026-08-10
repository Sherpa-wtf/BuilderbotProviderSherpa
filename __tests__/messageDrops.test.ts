import { beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals'
import { BaileysProvider } from '../src'

/**
 * Regresion de la perdida silenciosa de mensajes entrantes.
 *
 * Contexto: un cliente escribio dos mensajes por WhatsApp que nunca llegaron ni
 * al bot ni al CRM, y no dejaron NINGUN rastro en los logs. La ingesta de
 * Baileys descartaba mensajes en varios `continue`/`return` mudos:
 *   - `if (type !== "notify") return` tiraba el batch entero de los mensajes
 *     que WhatsApp entrega tras una reconexion del socket.
 *   - "No session" / "Bad MAC" (fallo de desencriptado) hacian `continue`.
 * Estos tests fallan contra la version anterior del provider.
 */

jest.mock('../src/baileyWrapper', () => ({
    downloadMediaMessage: jest.fn(),
    getAggregateVotesInPollMessage: jest.fn(),
    makeCacheableSignalKeyStore: jest.fn(),
    isJidGroup: jest.fn().mockReturnValue(false),
    isJidBroadcast: jest.fn().mockReturnValue(false),
    DisconnectReason: {},
    // create() devuelve un objeto real: la version con el bug hacia
    // `return proto.Message.create({})` (mensaje VACIO), y necesitamos que el
    // test lo distinga de `undefined`.
    proto: { Message: { fromObject: jest.fn(), create: jest.fn(() => ({})) } },
    useMultiFileAuthState: jest.fn().mockImplementation(() => ({
        state: { creds: {}, keys: {} },
        saveCreds: jest.fn(),
    })),
    makeWASocketOther: jest.fn().mockImplementation(() => ({
        ev: { on: jest.fn() },
        authState: { creds: { registered: false } },
    })),
}))

// wa-sticker-formatter arrastra `sharp` (binario nativo) y no hace falta aca.
jest.mock('wa-sticker-formatter', () => ({
    Sticker: jest.fn(),
}))

jest.mock('@builderbot/bot')

const CONTACT_JID = '5492223503064@s.whatsapp.net'

const nowSeconds = () => Math.floor(Date.now() / 1000)

const textMessage = (overrides: Record<string, any> = {}) => ({
    key: { remoteJid: CONTACT_JID, id: `id-${Math.random()}`, fromMe: false },
    messageTimestamp: nowSeconds(),
    pushName: 'Belen Carlos Dario',
    message: { conversation: 'Hola buenas noches' },
    ...overrides,
})

describe('#BaileysProvider ingesta de mensajes entrantes', () => {
    let provider: any
    let stdoutSpy: any
    let stdoutChunks: string[]

    const upsertHandler = () =>
        provider.busEvents().find((e: any) => e.event === 'messages.upsert').func

    const historyHandler = () =>
        provider.busEvents().find((e: any) => e.event === 'messaging-history.set')?.func

    beforeEach(() => {
        stdoutChunks = []
        stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
            stdoutChunks.push(String(chunk))
            return true
        }) as any)

        provider = new BaileysProvider({
            name: 'test-drops',
            phoneNumber: '+123456789',
            port: 3099,
            writeMyself: 'none',
        } as any)

        provider.emit = jest.fn()
        provider.vendor = {
            requestPlaceholderResend: jest.fn().mockImplementation(async () => 'req-1'),
            sendMessage: jest.fn(),
        }
        provider.globalVendorArgs.host = { phone: '123456789' }
    })

    afterEach(() => {
        stdoutSpy.mockRestore()
        jest.clearAllMocks()
    })

    test('un mensaje que no se pudo desencriptar ("No session") pide reenvio en vez de descartarse en silencio', async () => {
        const undecryptable = textMessage({
            message: null,
            messageStubParameters: ['No session record for device'],
        })

        await upsertHandler()({ type: 'notify', messages: [undecryptable] })

        expect(provider.vendor.requestPlaceholderResend).toHaveBeenCalledWith(
            undecryptable.key
        )
        expect(stdoutChunks.join('')).toContain('BAILEYS_MESSAGE_DROPPED')
    })

    test('un "Bad MAC" tambien pide reenvio y queda logueado', async () => {
        const badMac = textMessage({
            message: null,
            messageStubParameters: ['Bad MAC'],
        })

        await upsertHandler()({ type: 'notify', messages: [badMac] })

        expect(provider.vendor.requestPlaceholderResend).toHaveBeenCalledWith(badMac.key)
        const logged = stdoutChunks.join('')
        expect(logged).toContain('BAILEYS_MESSAGE_DROPPED')
        expect(logged).toContain('bad_mac')
    })

    test('los mensajes sincronizados tras una reconexion (type "append") se procesan, no se tiran', async () => {
        const recovered = textMessage()

        await upsertHandler()({ type: 'append', messages: [recovered] })

        expect(provider.emit).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({ body: 'Hola buenas noches' })
        )
    })

    test('un mensaje sincronizado viejo NO se procesa, para no revivir conversaciones al reconectar', async () => {
        const old = textMessage({ messageTimestamp: nowSeconds() - 60 * 60 * 24 * 7 })

        await upsertHandler()({ type: 'append', messages: [old] })

        expect(provider.emit).not.toHaveBeenCalled()
        expect(stdoutChunks.join('')).toContain('synced_message_too_old_or_own')
    })

    test('el provider escucha messaging-history.set y reenvia esos mensajes a la ingesta', async () => {
        const handler = historyHandler()
        expect(handler).toBeDefined()

        await handler({ messages: [textMessage()], syncType: 'ON_DEMAND', progress: 100 })

        expect(provider.emit).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({ body: 'Hola buenas noches' })
        )
    })

    test('el mismo mensaje no se emite dos veces aunque llegue por notify y por sincronizacion', async () => {
        const duplicated = textMessage()

        await upsertHandler()({ type: 'notify', messages: [duplicated] })
        await upsertHandler()({ type: 'append', messages: [duplicated] })

        expect(provider.emit).toHaveBeenCalledTimes(1)
        expect(stdoutChunks.join('')).toContain('duplicate')
    })

    test('getMessage devuelve undefined (no un mensaje vacio) cuando no tenemos el original', async () => {
        const result = await provider.getMessage({ remoteJid: CONTACT_JID, id: 'desconocido' })
        expect(result).toBeUndefined()
    })
})
