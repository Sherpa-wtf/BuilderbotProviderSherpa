import { promises as fs, constants } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { makeWASocketOther, useMultiFileAuthState } from './baileyWrapper'
import { AdministrativeAuthWrites } from './administrativeAuthWrites'

export interface LogoutIdentity {
    botId: string
    operationId: string
    controlVersion: number
    runtimeId: string
    generation: number
}
export interface LogoutGrant extends LogoutIdentity { purpose: 'logout_only'; expiresAt: number }
export type LogoutResult = { result: 'uncertain' } | {
    result: 'disconnected'; evidenceStage: 'remote_ack_and_local_cleanup'; remoteAckId: string
}
type Journal = { botId: string; operationId: string; controlVersion: number; stage: 'attempted' | 'remote_ack' | 'cleaned'; remoteAckId?: string }
const active = new Set<string>()

/** Administrative socket only. No ProviderClass, business listeners, QR flow, or native logout's local-only ACK. */
export async function administrativeLogout(options: {
    sessionDirectory: string
    identity: LogoutIdentity
    authorize: () => Promise<LogoutGrant>
}): Promise<LogoutResult> {
    const { identity, authorize } = options
    const directory = path.resolve(options.sessionDirectory)
    const journalName = `.provider-migration-${createHash('sha256').update(`${identity.botId}:${identity.operationId}:${identity.controlVersion}`).digest('hex')}.json`
    const journalPath = path.join(directory, journalName)
    const pendingPath = journalPath.replace(/\.json$/, '.pending.json')
    const isAuthFile = (name: string) => name === 'creds.json' || /^(pre-key|session|sender-key|sender-key-memory|app-state-sync-key|app-state-sync-version|lid-mapping|device-list|tctoken|identity-key)-.+\.json$/.test(name)
    const validate = async () => {
        const grant = await authorize()
        if (!grant || grant.purpose !== 'logout_only' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now()
            || Object.keys(identity).some(key => grant[key] !== identity[key])) throw new Error('CONTROL_AUTHORIZATION_INVALID')
        return grant
    }
    await validate()
    if (active.has(directory)) throw new Error('CONTROL_LOGOUT_BUSY')
    active.add(directory)
    let socket: ReturnType<typeof makeWASocketOther> | undefined
    const writes = new AdministrativeAuthWrites()
    const scope = async () => {
        if (directory === path.parse(directory).root || (await fs.lstat(directory)).isSymbolicLink()
            || await fs.realpath(directory) !== directory) throw new Error('SESSION_SCOPE_INVALID')
        const entries = await fs.readdir(directory, { withFileTypes: true })
        if (entries.some(entry => entry.isSymbolicLink())) throw new Error('SESSION_SCOPE_INVALID')
        return entries.filter(entry => entry.isFile() && isAuthFile(entry.name)).map(entry => entry.name)
    }
    const persist = async (journal: Journal, exclusive = false) => {
        await scope()
        const temporary = pendingPath
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await handle.writeFile(JSON.stringify(journal)); await handle.sync() } finally { await handle.close() }
        // link is an exclusive publish: another process cannot overwrite an attempted logout.
        if (exclusive) {
            await fs.link(temporary, journalPath)
            await fs.unlink(temporary)
        } else {
            await fs.rename(temporary, journalPath)
        }
        const parent = await fs.open(directory, constants.O_RDONLY)
        try { await parent.sync() } finally { await parent.close() }
    }
    let journal: Journal | undefined
    try {
        await scope()
        const readJournal = async (file: string): Promise<Journal | undefined> => {
            let raw: string
            try { raw = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
            let value: Journal
            try { value = JSON.parse(raw) } catch {
                // Only this operation's exact pending pathname is reclaimable. A committed malformed journal is never discarded.
                if (file !== pendingPath) throw new Error('CONTROL_JOURNAL_INVALID')
                await validate(); await fs.unlink(pendingPath); return undefined
            }
            if (value.botId !== identity.botId || value.operationId !== identity.operationId || value.controlVersion !== identity.controlVersion) throw new Error('CONTROL_JOURNAL_OPERATION_MISMATCH')
            if (!['attempted', 'remote_ack', 'cleaned'].includes(value.stage) || (value.stage !== 'attempted' && (!value.remoteAckId || value.remoteAckId.length > 128))) throw new Error('CONTROL_JOURNAL_INVALID')
            return value
        }
        journal = await readJournal(journalPath)
        const pending = await readJournal(pendingPath)
        if (pending) {
            await validate()
            const stages = ['attempted', 'remote_ack', 'cleaned']
            if ((!journal && pending.stage !== 'attempted') || (journal && stages.indexOf(pending.stage) < stages.indexOf(journal.stage)) ||
                (journal?.remoteAckId && pending.remoteAckId !== journal.remoteAckId)) throw new Error('CONTROL_JOURNAL_INVALID')
            if (!journal) { await fs.link(pendingPath, journalPath); await fs.unlink(pendingPath) }
            else { await fs.rename(pendingPath, journalPath) }
            const parent = await fs.open(directory, constants.O_RDONLY)
            try { await parent.sync() } finally { await parent.close() }
            journal = pending
        }
        if (journal?.stage === 'attempted') return { result: 'uncertain' }
        if (journal && !['cleaned', 'remote_ack'].includes(journal.stage)) throw new Error('CONTROL_JOURNAL_INVALID')
        if (journal && (!journal.remoteAckId || journal.remoteAckId.length > 128)) throw new Error('CONTROL_JOURNAL_INVALID')
        if (!journal) {
            const { state, saveCreds } = await useMultiFileAuthState(directory)
            // QR pairing sets me.id; registered belongs to the pairing-code flow.
            if (!state.creds.me?.id) throw new Error('CONTROL_LINKED_SESSION_REQUIRED')
            await validate()
            const originalSet = state.keys.set.bind(state.keys)
            state.keys.set = data => writes.run(() => originalSet(data))
            socket = makeWASocketOther({ auth: state, syncFullHistory: false, markOnlineOnConnect: false,
                shouldIgnoreJid: () => true, shouldSyncHistoryMessage: () => false,
                getMessage: async () => undefined, defaultQueryTimeoutMs: 10000 })
            socket.ev.on('creds.update', () => { void writes.run(saveCreds).catch(() => undefined) })
            let timer: ReturnType<typeof setTimeout>
            try {
                await Promise.race([socket.waitForSocketOpen(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CONTROL_SOCKET_TIMEOUT')), 10000) })])
            } finally { clearTimeout(timer!) }
            const grant = await validate()
            const remoteAckId = socket.generateMessageTag()
            if (!remoteAckId || remoteAckId.length > 128) throw new Error('CONTROL_ACK_ID_INVALID')
            journal = { botId: identity.botId, operationId: identity.operationId, controlVersion: identity.controlVersion, stage: 'attempted' }
            await persist(journal, true)
            await validate()
            const result = await socket.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', id: remoteAckId, xmlns: 'md' },
                content: [{ tag: 'remove-companion-device', attrs: { jid: state.creds.me.id, reason: 'user_initiated' } }] }, Math.max(1, Math.min(10000, grant.expiresAt - Date.now())))
            if (result?.tag !== 'iq' || result.attrs.id !== remoteAckId || result.attrs.type !== 'result') return { result: 'uncertain' }
            journal = { ...journal, stage: 'remote_ack', remoteAckId }
            await persist(journal)
        }
        socket?.end(new Error('Administrative logout quiescence'))
        await writes.quiesce()
        await validate()
        if (journal.stage !== 'cleaned') {
            for (const file of await scope()) {
                await validate()
                await fs.unlink(path.join(directory, file))
            }
            journal = { ...journal, stage: 'cleaned' }
            await persist(journal)
        }
        return { result: 'disconnected', evidenceStage: 'remote_ack_and_local_cleanup', remoteAckId: journal.remoteAckId! }
    } catch (error) {
        if (socket || journal?.stage === 'remote_ack') return { result: 'uncertain' }
        throw error
    } finally {
        socket?.end(new Error('Administrative control finished'))
        await writes.quiesce().catch(() => undefined)
        active.delete(directory)
    }
}
