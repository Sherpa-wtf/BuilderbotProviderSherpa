import { QrChallengeStore } from '../src/qrChallenge'

describe('QR challenge publication', () => {
  let now: number
  beforeEach(() => { now = 1000 })
  test('publishes a complete image scoped to generation and expires at the exact boundary', async () => {
    const store = new QrChallengeStore(async () => Buffer.from('png'), () => now)
    store.invalidate(3)
    expect(store.current()).toBeNull()
    const published = await store.publish('secret', 3, 40000)
    expect(published).toMatchObject({ socketGeneration: 3, generatedAt: 1000, expiresAt: 41000 })
    expect(store.current()?.image.toString()).toBe('png')
    now = 40999
    expect(store.current()).not.toBeNull()
    now = 41000
    expect(store.current()).toBeNull()
  })
  test('new challenge invalidates the old immediately; late older renderer never overwrites current', async () => {
    const pending: Record<string, (image: Buffer) => void> = {}
    const store = new QrChallengeStore((qr) => new Promise(resolve => { pending[qr] = resolve }), () => now)
    store.invalidate(1)
    const old = store.publish('old', 1, 40000)
    const next = store.publish('new', 1, 40000)
    expect(store.current()).toBeNull()
    pending.new(Buffer.from('new'))
    await next
    pending.old(Buffer.from('old'))
    expect(await old).toBeNull()
    expect(store.current()?.image.toString()).toBe('new')
  })
  test.each(['ready', 'new socket'])('%s invalidation rejects an in-flight publication', async () => {
    let resolve!: (value: Buffer) => void
    let renders = 0
    const store = new QrChallengeStore(() => ++renders === 1 ? new Promise(done => { resolve = done }) : Promise.resolve(Buffer.from('stale')), () => now)
    store.invalidate(1)
    const pending = store.publish('secret', 1, 40000)
    store.invalidate(2)
    resolve(Buffer.from('old'))
    expect(await pending).toBeNull()
    expect(await store.publish('stale socket', 1, 40000)).toBeNull()
    expect(store.current()).toBeNull()
  })
  test('slow rendering cannot extend the generator deadline', async () => {
    const store = new QrChallengeStore(async () => { now += 40000; return Buffer.from('png') }, () => now)
    store.invalidate(1)
    expect(await store.publish('secret', 1, 40000)).toBeNull()
    expect(store.current()).toBeNull()
  })
})
