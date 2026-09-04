import { beforeEach, describe, expect, jest, test } from '@jest/globals'

jest.mock('../src/utils', () => ({
    baileyCleanNumber: (numero: string, full = false) => {
        const limpio = String(numero)
            .replace('@s.whatsapp.net', '')
            .replace('+', '')
            .replace(/\s/g, '')
        return full ? limpio : `${limpio}@s.whatsapp.net`
    },
    // El heuristico real: movil AR = 13 digitos, fijo AR = 12.
    baileyIsPossibleNumber: (numero: string) => {
        const d = String(numero).replace(/\D/g, '')
        if (!d || d.startsWith('0')) return false
        if (d.length < 8 || d.length > 15) return false
        if (d.startsWith('549')) return d.length === 13
        if (d.startsWith('54')) return d.length === 12
        return true
    },
    baileyGenerateImage: jest.fn(),
    baileyCleanNumberPhone: jest.fn(),
    generalDownload: jest.fn(),
    convertAudio: jest.fn(),
    delay: jest.fn(),
    removePlus: (n: string) => String(n).replace('+', ''),
    generateRefProvider: jest.fn(),
    emptyDirSessions: jest.fn(),
}))

jest.mock('wa-sticker-formatter', () => ({
    Sticker: jest.fn().mockImplementation(() => ({ toMessage: jest.fn() })),
}))

jest.mock('mime-types', () => ({ lookup: jest.fn(), extension: jest.fn() }))

jest.mock('@builderbot/bot')

jest.mock('baileys', () => ({
    __esModule: true,
    default: jest.fn(),
    DisconnectReason: {},
    isJidGroup: (jid: string) => String(jid).includes('@g.us'),
    isJidBroadcast: (jid: string) => String(jid).includes('@broadcast'),
    makeCacheableSignalKeyStore: jest.fn(),
    useMultiFileAuthState: jest.fn(),
    proto: { Message: { create: jest.fn() } },
    downloadMediaMessage: jest.fn(),
    getAggregateVotesInPollMessage: jest.fn(),
    makeInMemoryStore: jest.fn(),
    makeWASocketOther: jest.fn(),
}))

import { BAILEYS_DESTINATION_UNREACHABLE, BaileysProvider } from '../src/bailey'

/**
 * La forma REAL de la respuesta de `onWhatsApp` en baileys 7.0.0-rc14:
 * un numero que no existe NO vuelve como `exists:false`, vuelve ausente.
 * Verificado contra produccion el 2026-09-04 con 41 numeros de resultado
 * conocido. El bug anterior era buscar `exists === false`, que no ocurre nunca.
 */
const EXISTE = [{ jid: '5491151552871@s.whatsapp.net', exists: true }]
const NO_EXISTE: unknown[] = []
const CONSULTA_FALLO = undefined

const conSocket = (onWhatsApp: any): BaileysProvider => {
    const provider = new BaileysProvider({ name: 'test' } as any)
    ;(provider as any).vendor = {
        onWhatsApp,
        sendMessage: jest.fn(async () => ({ key: { id: 'MSG1' } })),
    }
    ;(provider as any).logger = { log: jest.fn() }
    return provider
}

const enviar = (provider: BaileysProvider, jid: string) =>
    (provider as any).sendVendorMessage(jid, { text: 'hola' })

describe('no enviar a un destino que no puede recibir', () => {
    let provider: BaileysProvider

    beforeEach(() => jest.clearAllMocks())

    test('un numero ausente del resultado se rechaza (el bug que estaba vivo)', async () => {
        provider = conSocket(jest.fn(async () => NO_EXISTE))
        await expect(enviar(provider, '5491135225026@s.whatsapp.net')).rejects.toMatchObject({
            code: BAILEYS_DESTINATION_UNREACHABLE,
        })
        expect((provider as any).vendor.sendMessage).not.toHaveBeenCalled()
    })

    test('un numero presente en el resultado se envia', async () => {
        provider = conSocket(jest.fn(async () => EXISTE))
        await expect(enviar(provider, '5491151552871@s.whatsapp.net')).resolves.toBeDefined()
        expect((provider as any).vendor.sendMessage).toHaveBeenCalled()
    })

    test('no confunde otro numero que si exista en la misma respuesta', async () => {
        provider = conSocket(jest.fn(async () => EXISTE))
        await expect(enviar(provider, '5491135225026@s.whatsapp.net')).rejects.toMatchObject({
            code: BAILEYS_DESTINATION_UNREACHABLE,
        })
    })

    test('acepta el jid con sufijo de dispositivo', async () => {
        provider = conSocket(jest.fn(async () => [{ jid: '5491151552871:12@s.whatsapp.net' }]))
        await expect(enviar(provider, '5491151552871@s.whatsapp.net')).resolves.toBeDefined()
    })

    describe('nunca bloquea sin una respuesta de WhatsApp', () => {
        // Un falso negativo corta mensajes buenos, que es peor que la perdida.
        test('si la consulta devuelve undefined, envia igual', async () => {
            provider = conSocket(jest.fn(async () => CONSULTA_FALLO))
            await expect(enviar(provider, '5491151552871@s.whatsapp.net')).resolves.toBeDefined()
        })

        test('si la consulta tira, envia igual', async () => {
            provider = conSocket(jest.fn(async () => { throw new Error('rate limit') }))
            await expect(enviar(provider, '5491151552871@s.whatsapp.net')).resolves.toBeDefined()
        })
    })

    test('el largo imposible se corta sin salir a la red', async () => {
        const onWhatsApp = jest.fn()
        provider = conSocket(onWhatsApp)
        await expect(enviar(provider, '549111551260459@s.whatsapp.net')).rejects.toMatchObject({
            code: BAILEYS_DESTINATION_UNREACHABLE,
        })
        expect(onWhatsApp).not.toHaveBeenCalled()
    })

    test('grupos y difusiones no pasan por USync', async () => {
        const onWhatsApp = jest.fn()
        provider = conSocket(onWhatsApp)
        await expect(enviar(provider, '12345-6789@g.us')).resolves.toBeDefined()
        expect(onWhatsApp).not.toHaveBeenCalled()
    })

    test('el negativo se cachea: no se consulta dos veces el mismo numero', async () => {
        const onWhatsApp = jest.fn(async () => NO_EXISTE)
        provider = conSocket(onWhatsApp)
        await expect(enviar(provider, '5491135225026@s.whatsapp.net')).rejects.toBeDefined()
        await expect(enviar(provider, '5491135225026@s.whatsapp.net')).rejects.toBeDefined()
        expect(onWhatsApp).toHaveBeenCalledTimes(1)
    })
})
