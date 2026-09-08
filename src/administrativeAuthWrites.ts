/** Tracks the administrative socket's auth writes, including work already in flight. */
export class AdministrativeAuthWrites {
    private closed = false
    private failed = false
    private pending = new Set<Promise<unknown>>()

    async run<T>(write: () => Promise<T> | T): Promise<T> {
        if (this.closed) throw new Error('AUTH_WRITES_QUIESCED')
        const operation = Promise.resolve().then(write)
        this.pending.add(operation)
        try {
            return await operation
        } catch (error) {
            this.failed = true
            throw error
        } finally {
            this.pending.delete(operation)
        }
    }

    async quiesce(): Promise<void> {
        this.closed = true
        await Promise.allSettled([...this.pending])
        if (this.failed) throw new Error('AUTH_WRITE_FAILED')
    }
}
