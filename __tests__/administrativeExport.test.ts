import fs from 'fs'
import path from 'path'
test('published provider source exposes administrative primitive, not native logout fallback', () => {
  expect(fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8')).toContain("export { administrativeLogout } from './administrativeLogout'")
})
