const COUNTRY_CODES = [
  { code: '+91', iso2: 'IN', name: 'India', pattern: '^[6-9]\\\\d{9}$', priority: 0 },
  { code: '+1', iso2: 'US', name: 'United States', pattern: '^\\\\d{10}$', priority: 1 },
  { code: '+1', iso2: 'CA', name: 'Canada', pattern: '^\\\\d{10}$', priority: 1 },
  { code: '+44', iso2: 'GB', name: 'United Kingdom', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+61', iso2: 'AU', name: 'Australia', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+49', iso2: 'DE', name: 'Germany', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+33', iso2: 'FR', name: 'France', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+39', iso2: 'IT', name: 'Italy', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+34', iso2: 'ES', name: 'Spain', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+31', iso2: 'NL', name: 'Netherlands', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+46', iso2: 'SE', name: 'Sweden', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+47', iso2: 'NO', name: 'Norway', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+45', iso2: 'DK', name: 'Denmark', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+358', iso2: 'FI', name: 'Finland', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+353', iso2: 'IE', name: 'Ireland', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+64', iso2: 'NZ', name: 'New Zealand', pattern: '^\\\\d{8,10}$', priority: 1 },
  { code: '+65', iso2: 'SG', name: 'Singapore', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+60', iso2: 'MY', name: 'Malaysia', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+62', iso2: 'ID', name: 'Indonesia', pattern: '^\\\\d{10,12}$', priority: 1 },
  { code: '+63', iso2: 'PH', name: 'Philippines', pattern: '^\\\\d{10}$', priority: 1 },
  { code: '+66', iso2: 'TH', name: 'Thailand', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+84', iso2: 'VN', name: 'Vietnam', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+82', iso2: 'KR', name: 'South Korea', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+81', iso2: 'JP', name: 'Japan', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+86', iso2: 'CN', name: 'China', pattern: '^\\\\d{11}$', priority: 1 },
  { code: '+971', iso2: 'AE', name: 'UAE', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+966', iso2: 'SA', name: 'Saudi Arabia', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+974', iso2: 'QA', name: 'Qatar', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+965', iso2: 'KW', name: 'Kuwait', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+973', iso2: 'BH', name: 'Bahrain', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+968', iso2: 'OM', name: 'Oman', pattern: '^\\\\d{8}$', priority: 1 },
  { code: '+27', iso2: 'ZA', name: 'South Africa', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+55', iso2: 'BR', name: 'Brazil', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+52', iso2: 'MX', name: 'Mexico', pattern: '^\\\\d{10}$', priority: 1 },
  { code: '+54', iso2: 'AR', name: 'Argentina', pattern: '^\\\\d{10,11}$', priority: 1 },
  { code: '+56', iso2: 'CL', name: 'Chile', pattern: '^\\\\d{9,10}$', priority: 1 },
  { code: '+57', iso2: 'CO', name: 'Colombia', pattern: '^\\\\d{10}$', priority: 1 },
];

const UP = `
CREATE TABLE IF NOT EXISTS country_codes (
  code       VARCHAR(6) NOT NULL,
  iso2       CHAR(2) NOT NULL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  pattern    VARCHAR(100) NOT NULL,
  priority   TINYINT NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO country_codes (code, iso2, name, pattern, priority) VALUES
${COUNTRY_CODES.map(c => `('${c.code}', '${c.iso2}', '${c.name}', '${c.pattern}', ${c.priority})`).join(',\n')};
`;

const DOWN = 'DROP TABLE IF EXISTS country_codes;';

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}

export async function down({ context: pool }) {
  await pool.execute(DOWN);
}

export default { up, down };
