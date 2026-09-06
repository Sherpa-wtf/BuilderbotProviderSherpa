/** Local generator validity only; WhatsApp can invalidate a challenge earlier. */
export interface QrChallenge {
  socketGeneration: number
  revision: number
  generatedAt: number
  expiresAt: number
  image: Buffer
}

/** Publish one fully rendered artifact; no shared filenames or partial-file reads. */
export class QrChallengeStore {
  private generation = 0
  private revision = 0
  private artifact: QrChallenge | null = null
  constructor(private render: (qr: string) => Promise<Buffer>, private now: () => number = Date.now) {}

  invalidate(generation: number): void {
    this.generation = generation
    this.revision++
    this.artifact = null
  }

  current(): QrChallenge | null {
    if (!this.artifact || this.now() >= this.artifact.expiresAt) return null
    return this.artifact
  }

  async publish(qr: string, generation: number, ttl: number): Promise<QrChallenge | null> {
    if (generation !== this.generation) return null
    this.invalidate(generation)
    const revision = this.revision
    const generatedAt = this.now()
    const expiresAt = generatedAt + ttl
    const image = await this.render(qr)
    if (revision !== this.revision || generation !== this.generation || this.now() >= expiresAt) return null
    this.artifact = { socketGeneration: generation, revision, generatedAt, expiresAt, image }
    return this.artifact
  }
}
