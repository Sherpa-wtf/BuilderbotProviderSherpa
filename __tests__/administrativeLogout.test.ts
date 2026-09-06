import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { administrativeLogout } from '../src/administrativeLogout'
import { makeWASocketOther, useMultiFileAuthState } from '../src/baileyWrapper'
jest.mock('../src/baileyWrapper', () => ({ makeWASocketOther: jest.fn(), useMultiFileAuthState: jest.fn() }))

describe('administrative logout without business runtime', () => {
    let dir: string
    let socket: any
    let authorize: jest.Mock
    const identity = { botId: 'qa', operationId: 'op1', controlVersion: 2, runtimeId: 'runtime1', generation: 3 }
    beforeEach(async () => {
        dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'logout-unit-')))
        await fs.writeFile(path.join(dir, 'creds.json'), '{}')
        authorize = jest.fn(async () => ({ ...identity, purpose: 'logout_only', expiresAt: Date.now() + 15000 }))
        socket = { ev: new EventEmitter(), waitForSocketOpen: jest.fn(async () => {}), generateMessageTag: () => 'ack1', query: jest.fn(async () => ({ tag: 'iq', attrs: { id: 'ack1', type: 'result' } })), end: jest.fn() }
        ;(makeWASocketOther as jest.Mock).mockReturnValue(socket)
        ;(useMultiFileAuthState as jest.Mock).mockResolvedValue({ state: { creds: { registered: true, me: { id: 'linked@s.whatsapp.net' } }, keys: { get: jest.fn(), set: jest.fn() } }, saveCreds: jest.fn() })
    })
    afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); jest.clearAllMocks() })
    const run = () => administrativeLogout({ sessionDirectory: dir, identity, authorize })
    it('rejects a stale generation before reading auth or opening socket', async () => {
        authorize.mockResolvedValue({ ...identity, generation: 2, purpose: 'logout_only', expiresAt: Date.now() + 15000 })
        await expect(run()).rejects.toThrow('CONTROL_AUTHORIZATION_INVALID')
        expect(useMultiFileAuthState).not.toHaveBeenCalled()
        expect(makeWASocketOther).not.toHaveBeenCalled()
    })
    it('disconnects a QR-linked session even when pairing-code registered remains false', async () => {
        ;(useMultiFileAuthState as jest.Mock).mockResolvedValue({ state: { creds: { registered: false, me: { id: 'linked@s.whatsapp.net' } }, keys: { get: jest.fn(), set: jest.fn() } }, saveCreds: jest.fn() })
        expect(await run()).toMatchObject({ result: 'disconnected', evidenceStage: 'remote_ack_and_local_cleanup' })
        expect(socket.query).toHaveBeenCalledTimes(1)
    })
    it('refuses an unlinked session before opening a socket or deleting credentials', async () => {
        ;(useMultiFileAuthState as jest.Mock).mockResolvedValue({ state: { creds: { registered: true }, keys: {} }, saveCreds: jest.fn() })
        await expect(run()).rejects.toThrow('CONTROL_LINKED_SESSION_REQUIRED')
        expect(makeWASocketOther).not.toHaveBeenCalled()
        expect(await fs.readFile(path.join(dir, 'creds.json'), 'utf8')).toBe('{}')
    })
    it('requires a correlated remote result then cleans auth only and replays durable evidence', async () => {
        expect(await run()).toEqual({ result: 'disconnected', evidenceStage: 'remote_ack_and_local_cleanup', remoteAckId: 'ack1' })
        await expect(fs.stat(path.join(dir, 'creds.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(socket.query).toHaveBeenCalledWith(expect.objectContaining({ tag: 'iq', content: [expect.objectContaining({ tag: 'remove-companion-device' })] }), expect.any(Number))
        expect((makeWASocketOther as jest.Mock).mock.calls[0][0]).toMatchObject({ syncFullHistory: false, markOnlineOnConnect: false })
        expect(await run()).toMatchObject({ result: 'disconnected', remoteAckId: 'ack1' })
        expect(makeWASocketOther).toHaveBeenCalledTimes(1)
    })
    it.each(['timeout', 'wrong_id', 'error'])('preserves credentials and never blindly retries uncertain %s', async kind => {
        socket.query.mockImplementation(async () => {
            if (kind === 'timeout') throw new Error('timeout')
            return { tag: 'iq', attrs: { id: kind === 'wrong_id' ? 'other' : 'ack1', type: kind === 'error' ? 'error' : 'result' } }
        })
        expect(await run()).toEqual({ result: 'uncertain' })
        expect(await fs.readFile(path.join(dir, 'creds.json'), 'utf8')).toBe('{}')
        expect(await run()).toEqual({ result: 'uncertain' })
        expect(socket.query).toHaveBeenCalledTimes(1)
        expect(makeWASocketOther).toHaveBeenCalledTimes(1)
    })
    it('preserves auth after remote ACK when current operation is revoked before cleanup', async () => {
        socket.query.mockImplementation(async () => {
            authorize.mockRejectedValue(new Error('revoked'))
            return { tag: 'iq', attrs: { id: 'ack1', type: 'result' } }
        })
        expect(await run()).toEqual({ result: 'uncertain' })
        expect(await fs.readFile(path.join(dir, 'creds.json'), 'utf8')).toBe('{}')
    })
    it('rejects symlink auth entries without deleting the target', async () => {
        await fs.symlink(path.join(dir, 'creds.json'), path.join(dir, 'session-key.json'))
        await expect(run()).rejects.toThrow('SESSION_SCOPE_INVALID')
        expect(makeWASocketOther).not.toHaveBeenCalled()
    })
    it('does not issue remote logout when authorization is expired', async () => {
        authorize.mockResolvedValue({ ...identity, purpose: 'logout_only', expiresAt: Date.now() - 1 })
        await expect(run()).rejects.toThrow('CONTROL_AUTHORIZATION_INVALID')
        expect(socket.query).not.toHaveBeenCalled()
    })
    it('drains in-flight credential saves before cleaning and rejects later saves', async () => {
        let finish!: () => void
        const save = jest.fn(() => new Promise<void>(resolve => { finish = resolve }))
        ;(useMultiFileAuthState as jest.Mock).mockResolvedValue({ state: { creds: { registered: true, me: { id: 'linked@s.whatsapp.net' } }, keys: { get: jest.fn(), set: jest.fn() } }, saveCreds: save })
        let queried!: () => void
        const didQuery = new Promise<void>(resolve => { queried = resolve })
        socket.query.mockImplementation(async () => {
            socket.ev.emit('creds.update', {})
            queried()
            return { tag: 'iq', attrs: { id: 'ack1', type: 'result' } }
        })
        const result = run()
        await didQuery
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(await fs.readFile(path.join(dir, 'creds.json'), 'utf8')).toBe('{}')
        finish()
        expect(await result).toMatchObject({ result: 'disconnected' })
        socket.ev.emit('creds.update', {})
        await Promise.resolve()
        expect(save).toHaveBeenCalledTimes(1)
    })
    it('resumes persisted ACK cleanup after crash without constructing a socket', async () => {
        await fs.writeFile(path.join(dir, `.provider-migration-${createHash('sha256').update('qa:op1:2').digest('hex')}.json`), JSON.stringify({ botId: identity.botId, operationId: identity.operationId, controlVersion: identity.controlVersion, stage: 'remote_ack', remoteAckId: 'persisted-ack' }))
        expect(await run()).toMatchObject({ result: 'disconnected', remoteAckId: 'persisted-ack' })
        expect(makeWASocketOther).not.toHaveBeenCalled()
    })
    it('does not accept another operation journal or unexpected session content', async () => {
        await fs.writeFile(path.join(dir, `.provider-migration-${createHash('sha256').update('qa:op1:2').digest('hex')}.json`), JSON.stringify({ botId: 'other', operationId: 'op1', controlVersion: 2, stage: 'cleaned', remoteAckId: 'ack' }))
        await expect(run()).rejects.toThrow('CONTROL_JOURNAL_OPERATION_MISMATCH')
        expect(makeWASocketOther).not.toHaveBeenCalled()
    })

    it('does not reuse an older operation proof for a new migration', async () => {
        expect(await run()).toMatchObject({ result: 'disconnected' })
        await fs.writeFile(path.join(dir, 'creds.json'), '{}')
        const next = { ...identity, operationId: 'op2', controlVersion: 4, generation: 5 }
        authorize.mockResolvedValue({ ...next, purpose: 'logout_only', expiresAt: Date.now() + 15000 })
        expect(await administrativeLogout({ sessionDirectory: dir, identity: next, authorize })).toMatchObject({ result: 'disconnected' })
        expect(socket.query).toHaveBeenCalledTimes(2)
    })

    it('revalidates a cleaned journal before reporting it after revocation', async () => {
        expect(await run()).toMatchObject({ result: 'disconnected' })
        authorize.mockReset().mockResolvedValueOnce({ ...identity, purpose: 'logout_only', expiresAt: Date.now() + 15000 }).mockRejectedValue(new Error('revoked'))
        await expect(run()).rejects.toThrow('revoked')
        expect(makeWASocketOther).toHaveBeenCalledTimes(1)
    })

    it('rejects a second concurrent controller for the same session without a second socket', async () => {
        let finish!: () => void
        let entered!: () => void
        const queryEntered = new Promise<void>(resolve => { entered = resolve })
        socket.query.mockImplementation(() => { entered(); return new Promise(resolve => { finish = () => resolve({ tag: 'iq', attrs: { id: 'ack1', type: 'result' } }) }) })
        const first = run()
        await queryEntered
        await expect(run()).rejects.toThrow('CONTROL_LOGOUT_BUSY')
        expect(makeWASocketOther).toHaveBeenCalledTimes(1)
        finish()
        expect(await first).toMatchObject({ result: 'disconnected' })
    })

    it('preserves foreign regular files while deleting only known Baileys auth keys', async () => {
        await fs.writeFile(path.join(dir, 'notes.json'), '{"keep":true}')
        await fs.writeFile(path.join(dir, 'session-known.json'), '{}')
        expect(await run()).toMatchObject({ result: 'disconnected' })
        expect(await fs.readFile(path.join(dir, 'notes.json'), 'utf8')).toBe('{"keep":true}')
        await expect(fs.stat(path.join(dir, 'session-known.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('recovers a fully written operation-owned pending ACK after rename crash without another socket', async () => {
        const name = `.provider-migration-${createHash('sha256').update('qa:op1:2').digest('hex')}`
        const journal = { botId: 'qa', operationId: 'op1', controlVersion: 2, stage: 'attempted' }
        await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(journal))
        await fs.writeFile(path.join(dir, `${name}.pending.json`), JSON.stringify({ ...journal, stage: 'remote_ack', remoteAckId: 'crash-ack' }))
        expect(await run()).toMatchObject({ result: 'disconnected', remoteAckId: 'crash-ack' })
        expect(makeWASocketOther).not.toHaveBeenCalled()
        await expect(fs.stat(path.join(dir, `${name}.pending.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('does not erase a foreign pending file or block recovery merely because it exists', async () => {
        await fs.writeFile(path.join(dir, '.control-write-foreign'), 'untouched')
        expect(await run()).toMatchObject({ result: 'disconnected' })
        expect(await fs.readFile(path.join(dir, '.control-write-foreign'), 'utf8')).toBe('untouched')
    })

    it('recovers after the real journal rename adapter fails, without resending the IQ', async () => {
        const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated crash before rename'))
        try { expect(await run()).toEqual({ result: 'uncertain' }) } finally { rename.mockRestore() }
        expect(await fs.readFile(path.join(dir, 'creds.json'), 'utf8')).toBe('{}')
        expect(await run()).toMatchObject({ result: 'disconnected', remoteAckId: 'ack1' })
        expect(socket.query).toHaveBeenCalledTimes(1)
    })
    it('reclaims only truncated own pending write while preserving attempted uncertainty and foreign files', async () => {
        const name = `.provider-migration-${createHash('sha256').update('qa:op1:2').digest('hex')}`
        await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify({ botId: 'qa', operationId: 'op1', controlVersion: 2, stage: 'attempted' }))
        await fs.writeFile(path.join(dir, `${name}.pending.json`), '{partial')
        await fs.writeFile(path.join(dir, 'foreign.pending.json'), '{partial')
        expect(await run()).toEqual({ result: 'uncertain' })
        expect(makeWASocketOther).not.toHaveBeenCalled()
        await expect(fs.stat(path.join(dir, `${name}.pending.json`))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await fs.readFile(path.join(dir, 'foreign.pending.json'), 'utf8')).toBe('{partial')
    })

})
