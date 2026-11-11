import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SUPPORTS_EXIT_ON_REPLACED } from '../src/capabilities'

describe('capacidades del paquete', () => {
  it('declara SUPPORTS_EXIT_ON_REPLACED para que el host verifique la red de seguridad del 440', () => {
    expect(SUPPORTS_EXIT_ON_REPLACED).toBe(true)
  })

  it('la entrada del paquete la reexporta', () => {
    expect(readFileSync(join(__dirname, '../src/index.ts'), 'utf8')).toContain("export * from './capabilities'")
  })
})
