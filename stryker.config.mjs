const fullRun = process.env.STRYKER_FULL === 'true'

export default {
  mutate: [
    'src/bailey.ts:79-103',
    'src/bailey.ts:836-854',
    'src/bailey.ts:911-931',
    'src/bailey.ts:1021-1021',
    'src/bailey.ts:1041-1041',
    'src/bailey.ts:1058-1058',
    'src/bailey.ts:1069-1069',
    'src/bailey.ts:1090-1090',
    'src/bailey.ts:1125-1125',
    'src/bailey.ts:1158-1174',
    'src/bailey.ts:1186-1214',
    'src/bailey.ts:1246-1246',
  ],
  testRunner: 'jest',
  coverageAnalysis: 'perTest',
  incremental: !fullRun,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  thresholds: { high: 98, low: 95, break: 95 },
  jest: {
    configFile: 'jest.stryker.config.cjs',
    enableFindRelatedTests: true,
  },
  timeoutMS: 15000,
  timeoutFactor: 1.5,
  tempDirName: '.stryker-tmp',
}
