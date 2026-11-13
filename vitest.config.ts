// No import alias is needed: the scheduler's host-package references are
// type-only (erased at transpile time), so the suite runs against the TS
// sources with any vitest install — e.g. the DSH checkout's own
// `node_modules/.bin/vitest run --config vitest.config.ts`.
export default {
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
}
