import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.js'],
    setupFiles: ['./tests/helpers/setup.js', './tests/setup-mocks.js'],
    env: {
      DB_NAME: 'flowx_test',
      NODE_ENV: 'test',
      RAZORPAY_KEY: 'rzp_test_mock',
      RAZORPAY_SECRET: 'mock_secret_for_testing',
      RAZORPAY_WEBHOOK_SECRET: 'mock_webhook_secret',
      JWT_SECRET: 'fallback-secret',
      JWT_REFRESH_SECRET: 'fallback-refresh-secret',
    },
    testTimeout: 60000,
    fileParallelism: false,
  },
})
