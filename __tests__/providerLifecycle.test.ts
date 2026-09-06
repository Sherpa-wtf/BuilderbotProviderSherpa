import { EventEmitter } from 'node:events'
import { BaileysProvider } from '../src/bailey'
import { makeWASocketOther } from '../src/baileyWrapper'

jest.mock('@builderbot/bot', () => ({
  ProviderClass: class extends require('node:events').EventEmitter {
    server = { use: jest.fn().mockReturnThis(), get: jest.fn().mockReturnThis() }
    idBotName = 'bot'
    listenOnEvents = jest.fn()
  },
  utils: { cleanImage: jest.fn(), delay: jest.fn(async () => undefined) },
}))
jest.mock('../src/baileyWrapper', () => ({
  makeWASocketOther: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn((keys) => keys),
  useMultiFileAuthState: jest.fn(async () => ({ state: { creds: {}, keys: {} }, saveCreds: jest.fn() })),
  DisconnectReason: { loggedOut: 401, connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, badSession: 500, restartRequired: 515 },
  proto: { Message: { create: jest.fn() } },
}))
jest.mock('../src/utils', () => ({ ...jest.requireActual('../src/utils'), emptyDirSessions: jest.fn(async () => true) }))
jest.mock('../src/releaseTmp', () => ({ releaseTmp: jest.fn(async () => undefined) }))
jest.mock('wa-sticker-formatter', () => ({ Sticker: jest.fn() }))
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createWriteStream: jest.fn(() => new (require('node:stream').Writable)({ write(_c: any, _e: any, done: any) { done() } })),
  createReadStream: jest.fn(() => { throw new Error('ENOENT: no QR exists') }),
}))

const makeSocket = () => ({ ev: new EventEmitter(), authState: { creds: { registered: false } }, user: { id: '5491100000000:1@s.whatsapp.net' }, end: jest.fn(), sendMessage: jest.fn(async () => ({ key: { id: 'sent' } })) })
const response = () => ({ writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() })
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }

describe('provider lifecycle and current QR only', () => {
  let provider: BaileysProvider
  beforeEach(() => {
    jest.spyOn(BaileysProvider.prototype as any, 'setupCleanupHandlers').mockImplementation(() => undefined)
    jest.spyOn(BaileysProvider.prototype as any, 'setupPeriodicCleanup').mockImplementation(() => undefined)
    ;(makeWASocketOther as jest.Mock).mockImplementation(makeSocket)
    provider = new BaileysProvider({ name: 'lifecycle-test' })
    jest.spyOn(provider as any, 'delayedReconnect').mockResolvedValue(undefined)
  })
  afterEach(() => { jest.restoreAllMocks() })

  test('known logout requires linking immediately and cannot downgrade during replacement startup', async () => {
    const observed: any[] = []
    provider.on('provider.lifecycle', event => observed.push(event))
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
    // Must be known before async session cleanup / replacement QR.
    expect(observed[0]).toMatchObject({ state: 'requires_link', reasonCode: 401 })
    await flush()
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'connecting' })
    expect(observed[observed.length - 1]).toMatchObject({ state: 'requires_link', socketGeneration: 2 })
    ;(provider.vendor as any).ev.emit('connection.update', { qr: 'local-fixture-not-real-qr' })
    await flush()
    expect(observed.every(event => event.state === 'requires_link')).toBe(true)
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'open' })
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } })
    expect(observed.slice(-2).map(event => event.state)).toEqual(['ready', 'disconnected'])
  })

  test('QR proves linking required even if a later reconnect event arrives before ready', async () => {
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { qr: 'local-qr-fixture' })
    await flush()
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'connecting' })
    expect(provider.getLifecycleSnapshot()?.state).toBe('requires_link')
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } })
    expect(provider.getLifecycleSnapshot()?.state).toBe('requires_link')
  })

  test('unknown disconnect does not invent logout and obsolete socket logout cannot downgrade ready', async () => {
    await (provider as any).initVendor()
    const old: any = provider.vendor
    old.ev.emit('connection.update', { connection: 'close' })
    expect(provider.getLifecycleSnapshot()?.state).toBe('disconnected')
    old.ev.emit('connection.update', { connection: 'connecting' })
    expect(provider.getLifecycleSnapshot()?.state).toBe('connecting')
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'open' })
    old.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
    expect(provider.getLifecycleSnapshot()?.state).toBe('ready')
  })

  test('missing QR is a safe pending response, never reads a stale file', () => {
    const res = response()
    provider.indexHome({ bot: 'lifecycle-test' } as any, res as any, jest.fn())
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ 'Cache-Control': 'private, no-store' }))
    expect(require('fs').createReadStream).not.toHaveBeenCalled()
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ state: 'waiting_qr' })
  })

  test('reports connecting, ready, then disconnect immediately and clears QR on ready', async () => {
    const observed: any[] = []
    provider.on('provider.lifecycle', (value) => observed.push(value))
    await (provider as any).initVendor()
    const sock: any = provider.vendor
    sock.ev.emit('connection.update', { connection: 'connecting' })
    sock.ev.emit('connection.update', { connection: 'open' })
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } })
    await flush()
    expect(observed.map((e) => e.state)).toEqual(['connecting', 'ready', 'disconnected'])
    expect(observed[1]).toMatchObject({ phoneNumber: '5491100000000' })
    expect(observed[0]).not.toHaveProperty('phoneNumber')
    expect(observed[2]).toMatchObject({ reasonCode: 408, socketGeneration: 1 })
    expect(observed.every((e) => Number.isFinite(Date.parse(e.observedAt)))).toBe(true)
  })

  test('late events from an obsolete socket cannot make the provider ready', async () => {
    const observed: any[] = []
    const ready = jest.fn()
    provider.on('ready', ready)
    provider.on('provider.lifecycle', (value) => observed.push(value))
    await (provider as any).initVendor()
    const first: any = provider.vendor
    await (provider as any).initVendor()
    first.ev.emit('connection.update', { connection: 'open' })
    await flush()
    expect(observed).toEqual([])
    expect(ready).not.toHaveBeenCalled()
  })
  test('serves a current PNG then immediately invalidates on ready and disconnect', async () => {
    await (provider as any).initVendor()
    const sock: any = provider.vendor
    sock.ev.emit('connection.update', { qr: 'test-only-noncredential' })
    await flush()
    const res = response()
    provider.indexHome({} as any, res as any, jest.fn())
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'image/png', 'X-QR-Generation': '1' }))
    expect(Buffer.isBuffer(res.end.mock.calls[0][0])).toBe(true)
    sock.ev.emit('connection.update', { connection: 'open' })
    const after = response()
    provider.indexHome({} as any, after as any, jest.fn())
    expect(after.writeHead).toHaveBeenCalledWith(503, expect.anything())
  })

  test('stop cancels reconnect and closes without logout; late ready and sends are denied', async () => {
    await (provider as any).initVendor()
    const sock: any = provider.vendor
    const ready = jest.fn()
    provider.on('ready', ready)
    ;(provider as any).stopLifecycle()
    expect(sock.end).toHaveBeenCalledTimes(1)
    sock.ev.emit('connection.update', { connection: 'open' })
    expect(ready).not.toHaveBeenCalled()
    await expect(sock.sendMessage('recipient', {})).rejects.toMatchObject({ code: 'BOT_LIFECYCLE_DENIED' })
    const created = (makeWASocketOther as jest.Mock).mock.calls.length
    await (provider as any).initVendor()
    expect((makeWASocketOther as jest.Mock).mock.calls).toHaveLength(created)
  })

  test('recoverable authority outage closes old socket without latching intentional stop',async()=>{
    await (provider as any).initVendor();const old:any=provider.vendor
    ;(provider as any).recoverLifecycle()
    expect(old.end).toHaveBeenCalledTimes(1)
    await expect(old.sendMessage('recipient',{})).rejects.toMatchObject({code:'BOT_LIFECYCLE_DENIED'})
    expect((provider as any).delayedReconnect).toHaveBeenCalledTimes(1)
    await (provider as any).initVendor()
    expect(provider.vendor).not.toBe(old)
  })

  test('final provider fence checks authority after async work and never calls network when denied', async () => {
    const send = jest.fn(async () => ({ key: { id: 'sent' } }))
    ;(makeWASocketOther as jest.Mock).mockImplementationOnce(() => ({ ...makeSocket(), sendMessage: send }))
    await (provider as any).initVendor()
    ;(provider as any).setLifecycleGuard(async () => { throw Object.assign(new Error('paused'), { code: 'BOT_LIFECYCLE_DENIED' }) })
    await expect(provider.vendor.sendMessage('recipient', {} as any)).rejects.toMatchObject({ code: 'BOT_LIFECYCLE_DENIED' })
    expect(send).not.toHaveBeenCalled()
  })

  test('a pause during an asynchronous authority check still denies the final network request', async () => {
    const send = jest.fn(async () => ({ key: { id: 'sent' } }))
    ;(makeWASocketOther as jest.Mock).mockImplementationOnce(() => ({ ...makeSocket(), sendMessage: send }))
    await (provider as any).initVendor()
    let allow!: () => void
    ;(provider as any).setLifecycleGuard(() => new Promise<void>(resolve => { allow = resolve }))
    const sending = provider.vendor.sendMessage('recipient', {} as any)
    ;(provider as any).stopLifecycle()
    allow()
    await expect(sending).rejects.toMatchObject({ code: 'BOT_LIFECYCLE_DENIED' })
    expect(send).not.toHaveBeenCalled()
  })

  test('a late QR after ready cannot re-publish an onboarding artifact', async () => {
    await (provider as any).initVendor()
    const sock: any = provider.vendor
    sock.ev.emit('connection.update', { connection: 'open' })
    sock.ev.emit('connection.update', { qr: 'obsolete-test-challenge' })
    await flush()
    const res = response()
    provider.indexHome({} as any, res as any, jest.fn())
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything())
  })

  test('exhausted recovery emits explicit error before supervised restart', () => {
    jest.useFakeTimers()
    try {
      const lifecycle = jest.fn()
      provider.on('provider.lifecycle', lifecycle)
      ;(provider as any).giveUpAndExit('budget exhausted')
      expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }))
    } finally { jest.clearAllTimers(); jest.useRealTimers() }
  })

  test('a new socket may require QR even when the previous socket was ready', async () => {
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { connection: 'open' })
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { qr: 'replacement-test-challenge' })
    await flush()
    const res = response()
    provider.indexHome({} as any, res as any, jest.fn())
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'X-QR-Generation': '2' }))
  })

  test('stop during asynchronous session cleanup prevents creating a replacement socket', async () => {
    let cleaned!: () => void
    require('../src/releaseTmp').releaseTmp.mockImplementationOnce(() => new Promise<void>(resolve => { cleaned = resolve }))
    provider.globalVendorArgs.useBaileysStore = true
    provider.globalVendorArgs.timeRelease = 1
    const created = (makeWASocketOther as jest.Mock).mock.calls.length
    const starting = (provider as any).initVendor()
    await flush()
    ;(provider as any).stopLifecycle()
    cleaned()
    await starting
    expect((makeWASocketOther as jest.Mock).mock.calls).toHaveLength(created)
  })

  test('metadata and conditional image share a boot-scoped tuple and reject old revision', async () => {
    await (provider as any).initVendor()
    ;(provider.vendor as any).ev.emit('connection.update', { qr: 'qr-for-metadata' })
    await flush()
    const metadata = response()
    ;(provider as any).qrMetadata({} as any, metadata as any)
    const artifact = JSON.parse(metadata.end.mock.calls[0][0])
    expect(artifact).toMatchObject({ available: true, generation: 1 })
    expect(artifact.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(artifact).not.toHaveProperty('image')
    const current = response()
    provider.indexHome({ query: { qrInstanceId: artifact.instanceId, qrGeneration: '1', qrRevision: String(artifact.revision) } } as any, current as any, jest.fn())
    expect(current.writeHead).toHaveBeenCalledWith(200, expect.anything())
    const oldBoot=response()
    provider.indexHome({query:{qrInstanceId:'00000000-0000-0000-0000-000000000000',qrGeneration:'1',qrRevision:String(artifact.revision)}} as any,oldBoot as any,jest.fn())
    expect(oldBoot.writeHead).toHaveBeenCalledWith(409,expect.anything())
    const stale = response()
    provider.indexHome({ query: { qrInstanceId: artifact.instanceId, qrGeneration: '1', qrRevision: String(artifact.revision - 1) } } as any, stale as any, jest.fn())
    expect(stale.writeHead).toHaveBeenCalledWith(409, expect.anything())
    expect(Buffer.isBuffer(stale.end.mock.calls[0][0])).toBe(false)
  })

  test('durable send wrapper surrounds the actual socket request and receives its result', async () => {
    const send = jest.fn(async () => ({ key: { id: 'durable-id' } }))
    ;(makeWASocketOther as jest.Mock).mockImplementationOnce(() => ({ ...makeSocket(), sendMessage: send }))
    await (provider as any).initVendor()
    const order: string[] = []
    ;(provider as any).setLifecycleSendWrapper(async (descriptor: any, network: () => Promise<any>) => {
      expect(descriptor).toMatchObject({ to: 'recipient', content: { text: 'hello' } })
      expect(send).not.toHaveBeenCalled(); order.push('claim')
      const result = await network(); order.push(result.key.id); return result
    })
    await expect(provider.vendor.sendMessage('recipient', { text: 'hello' })).resolves.toMatchObject({ key: { id: 'durable-id' } })
    expect(order).toEqual(['claim', 'durable-id']); expect(send).toHaveBeenCalledTimes(1)
  })

  test('a pause while durable claim waits still prevents the original socket call', async () => {
    const send = jest.fn(async () => ({ key: { id: 'never' } }))
    ;(makeWASocketOther as jest.Mock).mockImplementationOnce(() => ({ ...makeSocket(), sendMessage: send }))
    await (provider as any).initVendor()
    ;(provider as any).setLifecycleSendWrapper(async (_descriptor: any, network: () => Promise<any>) => {
      await Promise.resolve(); provider.stopLifecycle(); return network()
    })
    await expect(provider.vendor.sendMessage('recipient', { text: 'blocked' })).rejects.toMatchObject({ code: 'BOT_LIFECYCLE_DENIED' })
    expect(send).not.toHaveBeenCalled()
  })

  test('fresh migration QR guard fences metadata and image before disclosing a challenge', async () => {
    await (provider as any).initVendor()
    provider.vendor.ev.emit('connection.update', { qr: 'migration-qr' })
    await flush()
    const guard = jest.fn(async (query: any) => { if(query.operationId !== 'op' || query.controlVersion !== '2') throw new Error('revoked') })
    ;(provider as any).setLifecycleQrGuard(guard)
    const rejected = response()
    await provider.indexHome({ query: { operationId: 'old', controlVersion: '1' } } as any, rejected as any, jest.fn())
    expect(rejected.writeHead).toHaveBeenCalledWith(409, expect.anything())
    expect(Buffer.isBuffer(rejected.end.mock.calls[0][0])).toBe(false)
    const metadata = response()
    await (provider as any).qrMetadata({ query: { operationId: 'old' } }, metadata)
    expect(metadata.writeHead).toHaveBeenCalledWith(409, expect.anything())
    const accepted = response()
    await provider.indexHome({ query: { operationId: 'op', controlVersion: '2' } } as any, accepted as any, jest.fn())
    expect(accepted.writeHead).toHaveBeenCalledWith(200, expect.anything())
  })

})
