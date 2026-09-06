import { AdministrativeAuthWrites } from '../src/administrativeAuthWrites'

describe('administrative auth writer quiescence', () => {
    it('waits for an already started write and rejects every subsequent write', async () => {
        const writes = new AdministrativeAuthWrites()
        let finish!: () => void
        const pending = writes.run(() => new Promise<void>(resolve => { finish = resolve }))
        let drained = false
        const drain = writes.quiesce().then(() => { drained = true })
        await Promise.resolve()
        expect(drained).toBe(false)
        const late = jest.fn()
        await expect(writes.run(late)).rejects.toThrow('AUTH_WRITES_QUIESCED')
        expect(late).not.toHaveBeenCalled()
        finish()
        await pending
        await drain
        expect(drained).toBe(true)
    })
    it('retains any write failure so cleanup cannot mistake a drained writer for success', async () => {
        const writes = new AdministrativeAuthWrites()
        await expect(writes.run(async () => { throw new Error('disk failure') })).rejects.toThrow('disk failure')
        await expect(writes.quiesce()).rejects.toThrow('AUTH_WRITE_FAILED')
    })
    it('tracks synchronous failures and repeated quiescence remains closed', async () => {
        const writes = new AdministrativeAuthWrites()
        await expect(writes.run(() => { throw new Error('sync') })).rejects.toThrow('sync')
        await expect(writes.quiesce()).rejects.toThrow('AUTH_WRITE_FAILED')
        await expect(writes.quiesce()).rejects.toThrow('AUTH_WRITE_FAILED')
        await expect(writes.run(jest.fn())).rejects.toThrow('AUTH_WRITES_QUIESCED')
    })
})
