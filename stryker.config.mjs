const fullRun = process.env.STRYKER_FULL === 'true'

export default {
  mutate: [
    'src/bailey.ts:81-105',
    'src/bailey.ts:935-953',
    'src/bailey.ts:1010-1030',
    'src/bailey.ts:1120-1120',
    'src/bailey.ts:1140-1140',
    'src/bailey.ts:1157-1157',
    'src/bailey.ts:1168-1168',
    'src/bailey.ts:1189-1189',
    'src/bailey.ts:1224-1224',
    'src/bailey.ts:1257-1273',
    'src/bailey.ts:1285-1313',
    'src/bailey.ts:1345-1345',
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
