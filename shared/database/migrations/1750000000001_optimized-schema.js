function generateMonthlyPartitions(tableName, columnName, monthsAhead = 6) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();

  const partitions = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const absMonth = currentMonth + i;
    const year = currentYear + Math.floor(absMonth / 12);
    const month = (absMonth % 12) + 1;
    const padded = String(month).padStart(2, '0');

    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const nextPadded = String(nextMonth).padStart(2, '0');

    partitions.push({
      name: `${tableName}_${year}_${padded}`,
      from: `${year}-${padded}-01`,
      to: `${nextYear}-${nextPadded}-01`,
    });
  }
  return partitions;
}

export const up = (pgm) => {
  // ============================================================
  // Extensions
  // ============================================================
  pgm.createExtension('citext', { ifNotExists: true });
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  // ============================================================
  // Custom Types
  // ============================================================
  pgm.createType('status', ['active', 'inactive', 'blocked', 'pending']);
  pgm.createType('audit_entity_type', ['user', 'role', 'oauth_account', 'session']);

  // ============================================================
  // Function: set_updated_at()
  // ============================================================
  pgm.createFunction('set_updated_at', [], {
    returns: 'trigger',
    language: 'plpgsql',
    replace: true,
  }, `
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
`);

  // ============================================================
  // Table: users
  // Includes soft-delete, citext email, status workflow
  // ============================================================
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'citext', notNull: true, unique: true },
    status: { type: 'status', notNull: true, default: 'pending' },
    email_verified_at: { type: 'timestamptz' },
    last_login_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    deleted_at: { type: 'timestamptz' },
  });

  // ============================================================
  // Table: roles
  // RBAC role definitions, seeded with 5 roles
  // ============================================================
  pgm.createTable('roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'varchar(50)', notNull: true, unique: true },
    name: { type: 'varchar(100)', notNull: true, unique: true },
    description: { type: 'text' },
    is_system: { type: 'boolean', default: false },
    is_super_admin: { type: 'boolean', default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // ============================================================
  // Table: user_roles
  // Many-to-many user-to-role assignments
  // ============================================================
  pgm.createTable('user_roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    role_id: { type: 'uuid', notNull: true, references: 'roles(id)', onDelete: 'CASCADE' },
    assigned_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('user_roles', 'uq_user_roles', 'UNIQUE (user_id, role_id)');
  pgm.createIndex('user_roles', 'role_id', { name: 'idx_user_roles_role_id' });

  // ============================================================
  // Table: user_profiles
  // Profile data with JSONB metadata + GIN index
  // ============================================================
  pgm.createTable('user_profiles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, unique: true, references: 'users(id)', onDelete: 'CASCADE' },
    first_name: { type: 'varchar(100)' },
    last_name: { type: 'varchar(100)' },
    phone: { type: 'varchar(50)', unique: true },
    avatar_url: { type: 'text' },
    country_code: { type: 'char(2)', default: 'IN' },
    city: { type: 'varchar(100)' },
    timezone: { type: 'varchar(100)' },
    metadata: { type: 'jsonb', default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_profiles', 'user_id', { name: 'idx_user_profiles_user_id' });
  pgm.sql('CREATE INDEX idx_user_profiles_metadata_gin ON public.user_profiles USING gin (metadata)');

  // ============================================================
  // Table: user_sessions
  // Refresh token sessions with last_used_at for rotation pruning
  // ============================================================
  pgm.createTable('user_sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    refresh_token_hash: { type: 'text', notNull: true, unique: true },
    device_name: { type: 'varchar(255)' },
    ip_address: { type: 'inet' },
    last_used_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_sessions', ['user_id', 'created_at'], { name: 'idx_user_sessions_user_created' });
  pgm.createIndex('user_sessions', 'expires_at', { name: 'idx_user_sessions_expires_at' });
  pgm.createIndex('user_sessions', 'last_used_at', { name: 'idx_user_sessions_last_used_at' });

  // ============================================================
  // Table: oauth_providers
  // Registry of supported OAuth providers (google, github, etc.)
  // ============================================================
  pgm.createTable('oauth_providers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'varchar(50)', notNull: true, unique: true },
    name: { type: 'varchar(100)', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  // ============================================================
  // Table: oauth_accounts
  // Links OAuth identities to local users, JSONB metadata + GIN
  // ============================================================
  pgm.createTable('oauth_accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    provider_id: { type: 'uuid', notNull: true, references: 'oauth_providers(id)', onDelete: 'CASCADE' },
    provider_user_id: { type: 'varchar(255)', notNull: true },
    provider_email: { type: 'varchar(255)' },
    provider_username: { type: 'varchar(255)' },
    metadata: { type: 'jsonb', default: '{}' },
    linked_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('oauth_accounts', 'uq_oauth_provider_user', 'UNIQUE (provider_id, provider_user_id)');
  pgm.createIndex('oauth_accounts', 'provider_id', { name: 'idx_oauth_accounts_provider_id' });
  pgm.createIndex('oauth_accounts', 'user_id', { name: 'idx_oauth_account_user_id' });
  pgm.sql('CREATE INDEX idx_oauth_accounts_metadata_gin ON public.oauth_accounts USING gin (metadata)');

  // ============================================================
  // Table: oauth_tokens
  // Encrypted OAuth tokens with expires_at index for cleanup
  // ============================================================
  pgm.createTable('oauth_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    oauth_account_id: { type: 'uuid', notNull: true, references: 'oauth_accounts(id)', onDelete: 'CASCADE' },
    encrypted_access_token: { type: 'text' },
    encrypted_refresh_token: { type: 'text' },
    encrypted_id_token: { type: 'text' },
    token_type: { type: 'varchar(50)' },
    expires_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.createIndex('oauth_tokens', 'oauth_account_id', { name: 'idx_oauth_account_id' });
  pgm.createIndex('oauth_tokens', 'expires_at', { name: 'idx_oauth_tokens_expires_at' });

  // ============================================================
  // Table: user_passwords
  // Password hashing with failed-attempt tracking and lockout
  // ============================================================
  pgm.createTable('user_passwords', {
    user_id: { type: 'uuid', primaryKey: true, references: 'users(id)', onDelete: 'CASCADE' },
    password_hash: { type: 'text', notNull: true },
    password_changed_at: { type: 'timestamptz' },
    failed_attempts: { type: 'integer', default: 0 },
    locked_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // ============================================================
  // Table: email_verifications
  // Email verification tokens with expires_at index
  // ============================================================
  pgm.createTable('email_verifications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    token_hash: { type: 'varchar(255)', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    verified_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.createIndex('email_verifications', 'user_id', { name: 'idx_email_verification_user_id' });
  pgm.createIndex('email_verifications', 'expires_at', { name: 'idx_email_verifications_expires_at' });

  // ============================================================
  // Table: password_resets
  // Password reset tokens with expires_at index
  // ============================================================
  pgm.createTable('password_resets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    token_hash: { type: 'varchar(255)', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.createIndex('password_resets', ['user_id', 'used_at'], { name: 'idx_password_resets_user_used' });
  pgm.createIndex('password_resets', 'expires_at', { name: 'idx_password_resets_expires_at' });
  pgm.sql('CREATE INDEX idx_password_resets_unused ON public.password_resets (token_hash) WHERE used_at IS NULL');

  // ============================================================
  // Table: permissions
  // Permission definitions grouped by module
  // ============================================================
  pgm.createTable('permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'varchar(100)', notNull: true, unique: true },
    name: { type: 'varchar(100)', notNull: true },
    description: { type: 'text' },
    module: { type: 'varchar(100)', notNull: true },
    is_system: { type: 'boolean', default: false },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  // ============================================================
  // Table: role_permissions
  // Many-to-many role-to-permission assignments
  // ============================================================
  pgm.createTable('role_permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    role_id: { type: 'uuid', notNull: true, references: 'roles(id)', onDelete: 'CASCADE' },
    permission_id: { type: 'uuid', notNull: true, references: 'permissions(id)', onDelete: 'CASCADE' },
    assigned_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('role_permissions', 'uq_role_permissions', 'UNIQUE (role_id, permission_id)');
  pgm.createIndex('role_permissions', 'permission_id', { name: 'idx_role_permissions_permission_id' });

  // ============================================================
  // Table: auth_login_history (PARTITIONED)
  // Monthly partitions by created_at — PK includes partition key
  // ============================================================
  pgm.sql(`
    CREATE TABLE public.auth_login_history (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      user_id uuid,
      provider_id uuid,
      login_method varchar(50),
      ip_address inet,
      user_agent text,
      success boolean,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `);

  const loginPartitions = generateMonthlyPartitions('auth_login_history', 'created_at');
  for (const p of loginPartitions) {
    pgm.sql(`
      CREATE TABLE public.${p.name} PARTITION OF public.auth_login_history
        FOR VALUES FROM ('${p.from}') TO ('${p.to}')
    `);
  }

  pgm.createIndex('auth_login_history', ['provider_id', 'user_id', 'created_at'], {
    name: 'idx_auth_login_history_provider_user_created',
  });
  pgm.createIndex('auth_login_history', 'user_id', { name: 'idx_auth_login_history_user' });
  pgm.sql('CREATE INDEX idx_auth_login_history_created_at ON public.auth_login_history (created_at DESC)');

  pgm.sql(`
    ALTER TABLE public.auth_login_history
      ADD CONSTRAINT fk_auth_login_history_user
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL
  `);
  pgm.sql(`
    ALTER TABLE public.auth_login_history
      ADD CONSTRAINT fk_auth_login_history_provider
      FOREIGN KEY (provider_id) REFERENCES public.oauth_providers(id) ON DELETE SET NULL
  `);

  // ============================================================
  // Table: audit_logs (PARTITIONED)
  // Monthly partitions by created_at — PK includes partition key
  // ============================================================
  pgm.sql(`
    CREATE TABLE public.audit_logs (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      actor_id uuid,
      entity_type public.audit_entity_type,
      entity_id uuid,
      action varchar(100),
      old_values jsonb,
      new_values jsonb,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `);

  const auditPartitions = generateMonthlyPartitions('audit_logs', 'created_at');
  for (const p of auditPartitions) {
    pgm.sql(`
      CREATE TABLE public.${p.name} PARTITION OF public.audit_logs
        FOR VALUES FROM ('${p.from}') TO ('${p.to}')
    `);
  }

  pgm.createIndex('audit_logs', ['entity_type', 'entity_id'], { name: 'idx_audit_logs_entity' });
  pgm.createIndex('audit_logs', 'actor_id', { name: 'idx_audit_logs_actor_id' });
  pgm.sql('CREATE INDEX idx_audit_logs_created_at ON public.audit_logs (created_at DESC)');
  pgm.sql('CREATE INDEX idx_audit_logs_old_values_gin ON public.audit_logs USING gin (old_values)');
  pgm.sql('CREATE INDEX idx_audit_logs_new_values_gin ON public.audit_logs USING gin (new_values)');

  pgm.sql(`
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT fk_audit_logs_actor
      FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL
  `);

  // ============================================================
  // View: active_users
  // Filters out soft-deleted users
  // ============================================================
  pgm.createView('active_users', {}, `
    SELECT id, email, status, email_verified_at, last_login_at,
           created_at, updated_at, deleted_at
    FROM public.users
    WHERE deleted_at IS NULL
  `);

  // ============================================================
  // Triggers
  // Auto-update updated_at on row modification
  // ============================================================
  pgm.createTrigger('users', 'trg_users_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
  pgm.createTrigger('user_profiles', 'trg_user_profiles_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
  pgm.createTrigger('user_passwords', 'trg_user_passwords_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });

  // ============================================================
  // Seed Data: Roles
  // ============================================================
  pgm.sql(`
    INSERT INTO public.roles (code, name, description, is_system, is_super_admin) VALUES
      ('super_admin', 'Super Admin', 'Super administrator role', true, true),
      ('admin', 'Admin', 'Administrator role', true, false),
      ('publisher', 'Publisher', 'Publisher role', true, false),
      ('client', 'Client', 'Client role', true, false),
      ('support_agent', 'Support Agent', 'Support agent role', true, false)
    ON CONFLICT (code) DO NOTHING
  `);
};

export const down = (pgm) => {
  pgm.dropView('active_users');
  pgm.dropTable('audit_logs');
  pgm.dropTable('auth_login_history');
  pgm.dropTable('role_permissions');
  pgm.dropTable('permissions');
  pgm.dropTable('password_resets');
  pgm.dropTable('email_verifications');
  pgm.dropTable('user_passwords');
  pgm.dropTable('oauth_tokens');
  pgm.dropTable('oauth_accounts');
  pgm.dropTable('oauth_providers');
  pgm.dropTable('user_sessions');
  pgm.dropTable('user_profiles');
  pgm.dropTable('user_roles');
  pgm.dropTable('roles');
  pgm.dropTable('users');
  pgm.dropType('audit_entity_type');
  pgm.dropType('status');
  pgm.dropFunction('set_updated_at', []);
  pgm.dropExtension('citext');
  pgm.dropExtension('pgcrypto');
};
