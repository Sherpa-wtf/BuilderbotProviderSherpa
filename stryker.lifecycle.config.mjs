export default {
  mutate: ['src/qrChallenge.ts'],
  testRunner: 'jest',
  coverageAnalysis: 'perTest',
  incremental: false,
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/lifecycle.json' },
  jest: { configFile: 'jest.lifecycle.config.cjs', enableFindRelatedTests: false },
  concurrency: 2,
  timeoutMS: 15000,
  tempDirName: '.stryker-lifecycle-tmp',
}
