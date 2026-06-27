import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const UP = `
CREATE TABLE IF NOT EXISTS app_config (
  id          BINARY(16) NOT NULL,
  config_key  VARCHAR(100) NOT NULL,
  config_value JSON NOT NULL,
  is_public   TINYINT(1) NOT NULL DEFAULT 1,
  description VARCHAR(255) DEFAULT NULL,
  version     INT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by  BINARY(16) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_app_config_key (config_key),
  KEY fk_app_config_updated_by (updated_by),
  CONSTRAINT fk_app_config_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = 'DROP TABLE IF EXISTS app_config;';

const SEEDS = [
  {
    key: 'theme',
    value: {
      primaryColor: '#1d4ed8',
      logoUrl: '/logo.png',
      faviconUrl: '/favicon.ico',
      fontFamily: 'Inter, sans-serif',
      borderRadius: '0.5rem',
      sidebarWidth: '16rem',
    },
    description: 'UI theme configuration',
  },
  {
    key: 'app_settings',
    value: {
      name: 'FlowX',
      environment: process.env.NODE_ENV || 'development',
      defaultCountryCode: 'IN',
      timezone: 'Asia/Kolkata',
    },
    description: 'Application-level settings',
  },
  {
    key: 'feature_flags',
    value: {
      googleOAuth: true,
      mobileOtp: false,
      identityVerification: true,
      subscriptions: false,
    },
    description: 'Feature toggles',
  },
  {
    key: 'form_rules',
    value: {
      password: {
        minLength: 8,
        maxLength: 128,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSpecial: false,
      },
      otp: {
        length: 6,
        expirySeconds: 600,
      },
      pincode: {
        length: 6,
        country: 'IN',
      },
      phone: {
        countryCode: 'IN',
        pattern: '^[6-9]\\d{9}$',
      },
    },
    description: 'Form validation rules exposed to frontend',
  },
  {
    key: 'pagination',
    value: {
      defaultPageSize: 20,
      maxPageSize: 100,
    },
    description: 'Default pagination limits',
  },
  {
    key: 'uploads',
    value: {
      maxFileSizeMb: 5,
      allowedImageTypes: ['image/jpeg', 'image/png'],
      allowedDocumentTypes: ['image/jpeg', 'image/png', 'application/pdf'],
    },
    description: 'Upload constraints',
  },
];

export async function up({ context: pool }) {
  await pool.execute(UP);

  for (const seed of SEEDS) {
    await pool.execute(
      `INSERT IGNORE INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, ?, ?, 1, ?, 1)`,
      [uuidToBuffer(generateUuid()), seed.key, JSON.stringify(seed.value), seed.description]
    );
  }
}

export async function down({ context: pool }) {
  await pool.execute(DOWN);
}

export default { up, down };
