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
      ENCRYPTION_KEY: 'd42a84bcb6e83b6264d482e8f8b346862c60a905a3c4e585b5607cccea30dfaa',
      // Hermetic defaults: vitest autoloads the repo .env, so a developer's
      // local dev values would otherwise leak into tests and flip behavior
      // (e.g. INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED=true in dev .env
      // would route image publishes into the FSM suite-wide). Config env wins
      // over .env autoload; files exercising a flag set it explicitly.
      INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED: 'false',
      POST_IG_IMAGE_POLL_SECONDS: '5',
      POST_IG_IMAGE_PROCESSING_CAP_MS: '600000',
    },
    testTimeout: 60000,
    fileParallelism: false,
  },
})
