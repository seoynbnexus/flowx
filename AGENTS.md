# FlowX Backend — AI Agent Guide

## Project Overview

FlowX is a backend service for managing content publishing, AI-powered content generation, identity verification, publisher platform accounts (including Meta/Instagram OAuth), ad categories, user/role/permission management, and system analytics.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (ES Modules, `"type": "module"`) |
| Framework | Express 5 |
| Database | MySQL 8 (via `mysql2/promise`, raw SQL) |
| Auth | JWT (`jsonwebtoken`) — short-lived access + httpOnly cookie refresh tokens |
| Validation | Zod (`zod`) |
| Migrations | Umzug (custom MySQL storage) |
| AI/LLM | LangChain (`@langchain/core`, `@langchain/google-genai`, `@langchain/openai`) |
| Image Processing | Sharp |
| File Upload | Multer (disk storage) |
| Email | Nodemailer |
| OAuth | Google (`google-auth-library`), Meta/Facebook Graph API (custom) |
| API Docs | Swagger UI (`swagger-ui-express`, OpenAPI YAML spec) |
| Logging | Morgan (HTTP, dev only), JSON structured errors |
| Rate Limiting | `express-rate-limit` |
| Package Manager | npm (`package-lock.json`) |

## Project Structure

```
flowx-backend/
├── app.js                          # Entry point
├── package.json
├── .env / .env.example
├── .gitignore
├── docs/
│   └── openapi.yaml                # OpenAPI spec
├── public/
│   ├── index.html
│   ├── privacy-policy.html
│   ├── terms-of-service.html
│   └── uploads/
│       └── identity/               # Uploaded identity documents
├── src/
│   ├── routes/
│   │   └── index.js                # Route aggregator (mounts all modules under /api/v1)
│   ├── docs/
│   │   └── swagger.js              # Swagger UI middleware
│   ├── jobs/
│   │   └── refresh-tokens.js       # Meta token refresh cron job
│   └── modules/
│       ├── auth/                   # Registration, login, OTP, OAuth, token refresh
│       ├── users/                  # Profile management, admin user CRUD
│       ├── roles/                  # Role CRUD + permission assignment
│       ├── permissions/            # Permission listing
│       ├── analytics/              # Admin analytics (overview, users, logins, AI usage, economy)
│       ├── ai/                     # Content generation, image generation, wallets, admin config
│       ├── ad-categories/          # Ad category CRUD + user category preferences
│       ├── config/                 # Public/full app config endpoint
│       ├── identity-document-types/     # Document type CRUD
│       ├── identity-documents/          # Document upload, user listing, admin verification
│       └── publisher-platforms/         # Platform account submission, OAuth (Meta), admin verification
└── shared/
    ├── database/
    │   ├── config.js               # MySQL pool config from env
    │   ├── connection.js           # Pool singleton, query/queryOne/transaction helpers
    │   ├── migrate.js              # Umzug migration runner (up/down/list)
    │   ├── schema-sync.js          # Schema comparison & migration generation
    │   ├── cleanup.js              # Purge expired sessions, OTPs, tokens, audit logs
    │   └── migrations/             # 19 numbered SQL migration files
    ├── middleware/
    │   ├── auth.middleware.js      # authenticate, optionalAuth, requireRole, requirePermission
    │   ├── error.middleware.js     # Global error handler
    │   └── validate.middleware.js  # Zod validation middleware
    ├── errors/
    │   ├── AppError.js             # Base + NotFoundError, AuthError, ForbiddenError, ValidationError, ConflictError, MethodMismatchError
    │   └── errorCodes.js           # String error code constants
    ├── utils/
    │   ├── response.utils.js       # sendSuccess, sendError, sendPaginated, sendCreated, sendNoContent
    │   ├── crypto.utils.js         # hash/compare password, generateOtp, encrypt/decrypt (AES-256-CBC), hashToken
    │   ├── uuid.utils.js           # generateUuid (v7), uuidToBuffer, bufferToUuid
    │   └── upload.utils.js         # Multer config for identity document uploads
    ├── constants/
    │   ├── index.js                # USER_STATUS, LOGIN_METHOD, OTP_PURPOSE, ROLE_CODES, IDENTITY_STATUS, PAGINATION, etc.
    │   └── httpStatus.js           # HTTP_STATUS map
    ├── mailer/
    │   └── mailer.js               # Nodemailer transporter, sendOtpEmail, sendPasswordResetEmail
    ├── services/
    │   ├── meta-oauth.config.js    # META_CONFIG object
    │   ├── meta-auth.service.js    # OAuth URL, token exchange, long-lived token, debugToken
    │   └── meta-graph.service.js   # Facebook pages, Instagram business account, media, insights
    └── ai/
        ├── provider.js             # LLM provider factory (gemini, openai, anthropic, groq)
        ├── pricing.js              # Token cost calculation
        ├── prompt-templates.js     # System prompts and content templates
        ├── moderation.service.js   # Content moderation
        ├── policy-loader.js        # YAML policy loader and validator
        ├── image-provider.js       # Image generation provider factory
        └── ai-safety-policy.yaml   # Content safety rules
```

## Architecture Overview

### Layered Pattern: Controller → Service → Repository → Database

Every module follows a strict separation:

```
Route (defines HTTP method + path + middleware)
  → Controller (parses request, calls service, sends response)
    → Service (business logic, validation, orchestrates repositories, throws AppError)
      → Repository (raw SQL queries via connection.js helpers, UUID conversion)
        → MySQL (BINARY(16) IDs, utf8mb4)
```

### Key Architecture Decisions

- **Single entry point** `app.js` mounts all routes under `/api/v1`
- **No DI container** — services import repositories directly, controllers import services directly
- **No ORM** — all database access is raw SQL via `mysql2/promise`
- **ID format** — UUID v7 generated in application code, stored as `BINARY(16)`, converted via `uuidToBuffer`/`bufferToUuid`
- **Auth flow** — JWT access token (Bearer header, short-lived ~2m) + refresh token (httpOnly cookie, path-scoped to `/api/v1/auth/refresh`, 30d)
- **Permission model** — Roles ↔ Permissions (many-to-many via `role_permissions`); `super_admin` bypasses permission checks
- **Error propagation** — Services throw `AppError` subclasses → `errorHandler` middleware maps to JSON responses
- **Config** — `.env` loaded via `dotenv` at app startup; AI config stored in `app_config` DB table

## Coding Standards

### JavaScript Conventions

- **ES Modules** exclusively (`import`/`export`, `"type": "module"` in package.json)
- **No semicolons** in the codebase
- **`async/await`** for all asynchronous code (no raw promises or callbacks)
- **Arrow functions** for exports (`export async function` for named exports)
- **No TypeScript** — plain JavaScript only
- **No comments** in the existing codebase (keep it that way)
- **`camelCase`** for variables and functions, **`snake_case`** for database columns/JSON keys
- **Descriptive function names** — e.g., `sendRegistrationOtp`, `verifyAccount`, `getMyDocuments`

### Module File Conventions

Each module under `src/modules/<name>/` follows this file naming convention:

| File | Convention | Purpose |
|------|-----------|---------|
| `<name>.controller.js` | Exports named async handler functions | Request parsing, response sending |
| `<name>.service.js` | Exports named async business logic functions | Orchestration, validation, error throwing |
| `<name>.repository.js` | Exports named async DB query functions | Raw SQL, UUID conversion, row mapping |
| `<name>.model.js` | Exports constants, config objects, and Zod schemas | Shared definitions |
| `<name>.validation.js` | Exports Zod schemas | Request body/query validation |
| `<name>.routes.js` | Exports default Express Router | Route definitions with middleware chain |
| `<name>.routes.js` / `admin.routes.js` | Separate admin route files when admin vs user endpoints differ | Admin-specific routes |

### Exceptions to the Standard Pattern

- Some modules omit files when not needed (e.g., `permissions/` has no model or validation, `config/` has no model/repository/validation, `analytics/` has no service/repository)
- Multiple route files per module when user and admin endpoints diverge significantly (e.g., `publisher-platforms/` has `publisher.routes.js`, `oauth.routes.js`, `admin.routes.js`; `identity-documents/` has `identity.routes.js` and `admin.routes.js`)

## Naming Conventions

### General

- `camelCase` for all JavaScript identifiers (variables, functions, parameters)
- `UPPER_SNAKE_CASE` for constants (`JWT_SECRET`, `AUTH_COOKIE_NAME`, `HTTP_STATUS.OK`)
- `PascalCase` for error classes (`AppError`, `NotFoundError`, `ValidationError`)
- `kebab-case` for file and directory names (`ad-categories/`, `identity-document-types/`)
- `dot.separated` for permission and error codes (`users.read`, `TOKEN_EXPIRED`)

### Database

- `snake_case` for column names, table names, and JSON keys (`first_name`, `email_verified_at`, `refresh_token_hash`)
- Tables are plural: `users`, `roles`, `permissions`, `user_sessions`
- Junction tables use singular: `user_roles`, `role_permissions`
- Foreign key columns match referenced table: `user_id`, `role_id`, `permission_id`
- Binary ID columns named `id` with `BINARY(16)` type
- Timestamps: `created_at`, `updated_at`, `deleted_at` (soft delete)
- Indexes: `idx_<table>_<column>`, unique: `uk_<table>_<column>`, foreign: `fk_<table>_<parent>`

### API

- Routes use `kebab-case`: `/api/v1/ad-categories`, `/api/v1/identity/documents`
- Query parameters use `camelCase`
- Response body uses `snake_case` for data keys (matches DB columns)

## Dependency Injection Pattern

**Not used.** The codebase uses direct imports throughout:

- Controllers import services directly
- Services import repositories and shared utilities directly
- Repositories import `query`/`queryOne`/`transaction` from `connection.js`

No DI container, no constructor injection, no IoC. To mock in tests, modules would need to be patched at the import level.

## Error Handling

### Error Class Hierarchy

```
Error
└── AppError (statusCode, code, message)
    ├── NotFoundError      → 404 NOT_FOUND
    ├── AuthError          → 401 AUTH_FAILED / TOKEN_EXPIRED / TOKEN_INVALID
    ├── ForbiddenError     → 403 FORBIDDEN
    ├── ValidationError    → 422 VALIDATION_ERROR (carries .errors array)
    ├── ConflictError      → 409 CONFLICT
    └── MethodMismatchError → 401 AUTH_METHOD_MISMATCH
```

### Error Codes (string constants in `shared/errors/errorCodes.js`)

`NOT_FOUND`, `AUTH_FAILED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `FORBIDDEN`, `VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`, `ACCOUNT_BLOCKED`, `ACCOUNT_INACTIVE`, `ACCOUNT_LOCKED`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `AUTH_METHOD_MISMATCH`, `CONTENT_POLICY_VIOLATION`, `INSUFFICIENT_COINS`, `AI_GENERATION_BLOCKED`

### Error Handling Rules

1. Always throw custom `AppError` subclasses from service layer — never raw `Error`
2. Never catch errors in controllers — pass them to `next(error)` for the global handler
3. The global `errorHandler` in `shared/middleware/error.middleware.js` handles: `AppError`, `ZodError`, `JsonWebTokenError`, `TokenExpiredError`, `entity.too.large`
4. Internal server errors (5xx) hide details in production mode — return "Internal server error"
5. All errors are logged as structured JSON with level, timestamp, method, URL, status code, code, message
6. Stack traces are included only in development mode

## Logging

- **HTTP request logging** via Morgan (`morgan('dev')`) — only in non-production environments
- **Error logging** via the `logError` function in `error.middleware.js` — writes structured JSON to console
  - Errors ≥500 → `console.error` (level: `error`)
  - Errors <500 → `console.warn` (level: `warn`)
- **Application startup/shutdown** logged via `console.log`
- **No structured logging library** (no Winston, Pino, etc.)
- **No audit log suppression** — all error and warning entries are always logged

## Validation

- **Zod schemas** defined in `<module>.validation.js` files
- Applied via `validate(schema, source)` middleware where `source` is `'body'` (default) or `'query'`
- Middleware replaces `req.body` or `req.query` with parsed/transformed data
- Validation errors return 422 with format: `{ field: "path.to.field", message: "..." }`
- Async parsing using `schema.parseAsync()` for compatibility with Zod 4
- Some schemas defined inline in model files (`ai.model.js`, `auth.model.js`, `user.model.js`) when closely tied to constants

## Authentication & Authorization

### Authentication

- **JWT access tokens** in `Authorization: Bearer <token>` header
- **Refresh tokens** in httpOnly cookie named `refresh_token`, path-scoped to `/api/v1/auth/refresh`
- Access token contains: `sub` (user ID), `email`, `roles[]`, `permissions[]`
- Refresh token contains: `sub` (user ID), `sid` (session ID)
- Refresh tokens are hashed (SHA-256) and stored in `user_sessions` table
- Access expiry: 2 minutes (`JWT_ACCESS_EXPIRY`), Refresh expiry: 30 days (`JWT_REFRESH_EXPIRY`)

### Middleware Functions (from `shared/middleware/auth.middleware.js`)

| Middleware | Purpose |
|-----------|---------|
| `authenticate` | Requires valid JWT; sets `req.user` with id, email, roles, permissions |
| `optionalAuth` | Tries JWT; sets `req.user` or null, `req.tokenProvided` boolean |
| `requireRole(...roles)` | Checks `req.user.roles` includes at least one listed role |
| `requirePermission(...permissions)` | Checks `req.user.permissions` includes at least one listed permission; `super_admin` always passes |

### Role-Based Access

- Roles: `super_admin`, `admin`, `publisher`, `client`, `support_agent`
- Roles are assigned via `user_roles` junction table
- `super_admin` role has `is_super_admin = 1` in DB, which triggers bypass in `requirePermission`
- Permission codes follow `<module>.<action>` pattern (e.g., `users.read`, `ai.admin`, `platform_accounts.verify`)

## Database & ORM

### Connection

- **MySQL 8** with `mysql2/promise` (promise-based)
- Connection pool singleton via `getPool()` in `shared/database/connection.js`
- Pool config from environment variables with sensible defaults
- Timezone set to `+00:00` (UTC) per connection
- Three helper functions: `query(sql, params)` → rows[], `queryOne(sql, params)` → row|null, `transaction(callback)` → result

### Migrations

- Umzug-based with custom MySQL storage (tracks in `_migrations` table)
- Migration files in `shared/database/migrations/` — numbered prefix (`001_`, `002_`, etc.)
- Each file exports `up({ context })` and `down({ context })` where context is the pool connection
- SQL statements split on `;` and executed individually
- `ensureDatabase()` creates the database if it does not exist (with `utf8mb4_unicode_ci` charset)
- Commands: `migrate:up`, `migrate:down`, `migrate:list`, `schema:sync`, `db:cleanup`

### Schema Conventions

- All tables use `InnoDB` engine, `utf8mb4` charset, `utf8mb4_unicode_ci` collation
- All primary keys are `BINARY(16)` for UUID v7 storage
- Timestamps use `TIMESTAMP` type (not `DATETIME`)
- Soft deletes via nullable `deleted_at TIMESTAMP NULL`
- JSON columns for flexible metadata (`JSON NOT NULL DEFAULT (JSON_OBJECT())`)
- Foreign keys explicitly named and defined

### UUID Handling

- UUIDs generated as UUID v7 via the `uuid` package
- Converted to/from BINARY(16) using `uuidToBuffer(uuid)` / `bufferToUuid(buffer)` from `shared/utils/uuid.utils.js`
- All repository functions convert both directions (input params via `uuidToBuffer`, result rows via `bufferToUuid`)
- Row mapping functions at top of each repository handle UUID conversion (e.g., `rowToUser`, `rowToSession`)

## API Design Guidelines

### Route Structure

All routes are mounted under `/api/v1` in `src/routes/index.js`:

```
/api/v1
  /config
  /auth
  /users
  /roles
  /permissions
  /publisher/accounts
  /publisher/accounts/oauth
  /admin/platform-accounts
  /ad-categories
  /identity/documents
  /admin/identity-documents
  /admin/identity-document-types
  /ai
  /admin/ai
  /admin/analytics
  /docs              (Swagger UI)
  /health
```

### Response Format

Success:
```json
{ "success": true, "message": "Success", "data": { ... } }
```

Created:
```json
{ "success": true, "message": "Created successfully", "data": { ... } }
```

Paginated:
```json
{ "success": true, "message": "Success", "data": [...], "pagination": { "page": 1, "limit": 20, "total": 100 } }
```

Error:
```json
{ "success": false, "message": "Error message", "code": "ERROR_CODE" }
```

Validation Error:
```json
{ "success": false, "message": "Validation failed", "errors": [{ "field": "email", "message": "Invalid email" }] }
```

### Response Status Code Rules

- `GET` → 200 (OK)
- `POST` → 201 (Created)
- No content responses → 204 (No Content)
- Paginated → 200 always (not 206)
- Client errors → 400s (401, 403, 404, 409, 422, 429)
- Server errors → 500

### Route Definition Pattern

```js
router.METHOD('/path', middleware1, middleware2, ..., controller.handler);
```

Middleware order: `authenticate` → `requirePermission(...)` → `validate(schema, source)` → `controller.handler`

## Business Logic Guidelines

- Business logic lives exclusively in **service files**, never in controllers or repositories
- Services call repositories and throw `AppError` subclasses on failure
- Services orchestrate cross-cutting concerns (e.g., auth service creates user + profile + password + wallet + audit log in a transaction)
- Repositories handle raw SQL and UUID conversion only — no business rules
- Controllers parse request params, delegate to service, and use `sendSuccess`/`sendCreated`/`sendError` helpers
- Cross-module calls are rare — when needed, import the other module's service directly (e.g., `user.routes.js` imports `ad-category.controller.js` for `/me/categories` endpoints)
- The `config` module is a special case — it reads from `app_config` table and serves different responses based on auth state

## File Organization Rules

1. **One concern per file** — each layer (controller, service, repository, validation, routes) gets its own file
2. **Co-located modules** — all related files live under `src/modules/<name>/`
3. **Shared code** lives in `shared/` — database, middleware, errors, utils, constants, mailer, services, ai
4. **Static files** in `public/`
5. **Uploaded files** in `public/uploads/identity/`
6. **Job scripts** in `src/jobs/` — standalone scripts (not part of the web server)
7. **API docs** in `src/docs/` (Swagger UI setup) with spec file in `docs/openapi.yaml`
8. **Migration files** in `shared/database/migrations/` — numbered sequentially

## Configuration Management

- Environment variables via `.env` file and `dotenv` package
- `dotenv` is loaded at the very top of `app.js` (before any other imports that read env)
- Some scripts (`jobs/refresh-tokens.js`) call `dotenv.config()` independently
- No configuration validation at startup — missing env vars may produce runtime errors
- AI configuration is stored in the `app_config` database table and cached in memory via `ai.config.js` (with `invalidate*Cache` functions)
- Fallback defaults are used throughout (e.g., `|| 'fallback-secret'`, `|| 3000`, `|| 'localhost'`)

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `development` / `production` — controls error verbosity, morgan, cookie Secure flag |
| `PORT` | Server port (default: 3000) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_LIMIT` | MySQL connection |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_FROM_NAME` | Email transport |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Signing keys |
| `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_EXPIRY` | Token lifetimes |
| `ENCRYPTION_KEY` | AES-256-CBC key (64 hex chars) for token encryption |
| `SALT` | bcrypt salt rounds |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` | Meta/Instagram OAuth |
| `FRONTEND_URL` | CORS + email link base URL |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Seed credentials |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_TEMPERATURE`, `AI_MAX_TOKENS`, `AI_MAX_PROMPT_LENGTH`, `AI_RATE_LIMIT_RPM` | LLM configuration |
| `AI_MODERATION_ENABLED`, `AI_MODERATION_PROVIDER`, `AI_SAFETY_POLICY_PATH` | Content moderation |
| `OPENAI_BASE_URL` | Custom OpenAI-compatible endpoint (OpenRouter) |
| `AI_IMAGE_PROVIDER`, `AI_IMAGE_API_KEY`, `AI_IMAGE_MODEL` | Image generation |
| `TZ` | Server timezone |
| `NGROK_AUTH_TOKEN`, `NGROK_FORWARDING_URL` | Ngrok tunnel (Meta OAuth callback) |

## Testing Strategy

**No test framework is configured.** The `package.json` has no test dependencies, no test scripts, and there are no test files in the repository.

This is a significant gap — tests should be added for all service and repository layers before making changes.

## Build, Run, Lint and Test Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start with nodemon (auto-restart on changes) |
| `npm start` | Start in production mode |
| `npm run migrate:up` | Run pending migrations |
| `npm run migrate:down` | Roll back all migrations |
| `npm run migrate:list` | List executed and pending migrations |
| `npm run db:cleanup` | Purge expired sessions, OTPs, tokens, audit logs |
| `npm run schema:sync` | Compare schema and generate sync migration |
| `npm run tokens:refresh` | Run Meta token refresh job |

No lint, typecheck, format, or test commands exist.

## Security Best Practices

### Currently Implemented

- **httpOnly cookies** for refresh tokens (not accessible to JavaScript)
- **SameSite strict** on cookies
- **Secure flag** on cookies in production
- **bcrypt** for password hashing (configurable salt rounds)
- **AES-256-CBC encryption** for stored OAuth tokens
- **SHA-256 hashing** for refresh tokens and OTPs in database
- **Rate limiting** on AI generation endpoints (30 RPM configurable)
- **CORS** with explicit origin allowlist
- **Input validation** via Zod on all endpoints
- **Account lockout** after 5 failed login attempts (15-minute lock)
- **Disposable email blocking** during registration
- **Disposable email domains** check via `disposable-email-domains` package
- **Content moderation** with policy-based keyword/pattern filtering
- **No secrets in code** — all secrets from environment variables
- **Soft deletes** (`deleted_at`) instead of hard deletes for users

### Gaps to Address

- No HTTPS enforcement in code (relies on deployment environment)
- No helmet.js or other security headers
- No CSRF protection (though cookies are path-scoped to refresh endpoint)
- No input sanitization beyond Zod validation
- No request size limiting on all endpoints (only JSON body limit of 10MB)
- `.env` contains real secrets (should remain in `.gitignore`, which it is)
- No audit logging for admin operations (beyond auth events)

## Performance Guidelines

- Use `queryOne` instead of `query` when expecting a single row
- Use `transaction` for multi-step atomic operations
- Pool connections are reused — never create raw connections in application code
- File uploads stored on disk (not in database) — only file paths stored in DB
- AI configuration cached in memory with explicit cache invalidation
- Migrations run independently (not during server startup)
- Pagination defaults: page 1, limit 20, max 100 (`PAGINATION` constant)
- No N+1 query issues observed — repositories return joined data where needed
- JSON columns for flexible metadata reduce schema migrations

## Code Review Checklist

- [ ] Follows layered pattern: Controller → Service → Repository
- [ ] Uses ES Modules (`import`/`export`), no `require()`
- [ ] No semicolons
- [ ] No try/catch in controllers — errors passed to `next(error)`
- [ ] Service methods throw `AppError` subclasses, not raw errors
- [ ] Repository methods convert UUIDs via `uuidToBuffer`/`bufferToUuid`
- [ ] Repository methods have row mapping functions for result sets
- [ ] Zod schemas validate all user input (body and/or query)
- [ ] Route middleware order: `authenticate` → `requirePermission/requireRole` → `validate` → controller
- [ ] `super_admin` bypass handled via `requirePermission` (not manually checked)
- [ ] Responses use `sendSuccess`, `sendCreated`, `sendPaginated`, `sendError` helpers
- [ ] No secrets or hardcoded values — use environment variables
- [ ] Constants use `UPPER_SNAKE_CASE`, exports use named exports
- [ ] File names use `kebab-case`, match module name
- [ ] No `.env` files committed (they are in `.gitignore`)
- [ ] Rate limiting applied on expensive/abuse-prone endpoints
- [ ] No console.log in production code path (only in error logging and startup)
- [ ] File uploads validated for type and size
- [ ] Transaction wraps multi-step writes in services
- [ ] No ORM methods — raw SQL with parameterized queries only

## Common Pitfalls

1. **Forgetting UUID conversion** — always convert IDs in repository functions. Missing `uuidToBuffer` on input or `bufferToUuid` on output causes silent failures
2. **Bypassing the service layer** — controllers should never call repositories or shared utilities directly
3. **Catching in controllers** — controllers should pass errors to `next()`, never catch them
4. **Synchronous Zod parsing** — use `schema.parseAsync()` for Zod v4 compatibility (the codebase uses Zod 4.x)
5. **Missing transaction on multi-table writes** — always wrap CREATE/UPDATE operations affecting multiple tables in `transaction()`
6. **Direct SQL string concatenation** — always use `?` placeholders with parameter arrays
7. **Incorrect import paths** — use `.js` extensions in all imports (required for ESM)
8. **`.env` as configuration** — the `.env` file is gitignored but the committed file contains real credentials that should not be there
9. **Auth middleware without `authenticate`** — `requireRole` and `requirePermission` check `req.user`, which is only set by `authenticate` or `optionalAuth`
10. **Missing module in route index** — new module routes must be added to `src/routes/index.js`

## Definition of Done

A feature is complete when:

1. Controller, service, repository, validation, and route files created/updated following the established patterns
2. All interactions pass through the proper layered architecture
3. Zod schemas validate all input (body and query params where applicable)
4. Error states return appropriate HTTP status codes with structured error responses
5. UUID conversion is correct in all repository functions
6. Multi-table writes use transactions
7. Route is registered in `src/routes/index.js`
8. Permissions/role checks are applied where appropriate
9. Rate limiting is added for abuse-prone endpoints
10. No secrets or hardcoded values introduced
11. Code follows existing naming conventions and file structure
12. `.env.example` is updated if new environment variables are added
13. OpenAPI spec (`docs/openapi.yaml`) is updated for new endpoints

## AI Agent Instructions

### Before Writing Code

1. **Always analyze existing code before implementing** — read at least the relevant module's controller, service, repository, validation, and routes
2. **Understand the pattern before extending it** — look at how similar features are implemented in other modules
3. **Check the shared utilities** — the problem may already be solved in `shared/utils/`, `shared/middleware/`, or `shared/services/`
4. **Check constants and error codes** before defining new ones — they may already exist in `shared/constants/` or `shared/errors/`

### During Implementation

5. **Follow the existing layered architecture** — Controller → Service → Repository → Database
6. **Reuse existing services and utilities** — use `query`/`queryOne`/`transaction` from `connection.js`, error classes from `AppError.js`, response helpers from `response.utils.js`
7. **Keep changes minimal and localized** — don't refactor unrelated code when adding a feature
8. **Avoid duplicate code** — extract shared logic to `shared/` utilities or service functions
9. **Maintain backward compatibility** unless explicitly instructed otherwise
10. **Prefer consistency** with the current codebase over introducing new patterns, libraries, or tools
11. **Use the same file structure** as existing modules — one file per concern (controller, service, repository, validation, routes)

### After Implementation

12. **Never delete or refactor large areas of code** without explicit instruction
13. **Update `.env.example`** when adding new environment variables
14. **Update the OpenAPI spec** in `docs/openapi.yaml` for new or modified endpoints
15. **Update this AGENTS.md** when introducing significant new patterns or conventions

### General Rules

16. **Think about security** — validate input, sanitize output, use parameterized queries, respect the permission model
17. **Think about error states** — every failure path should produce a meaningful error response
18. **Think about the permission model** — who can access this endpoint? Should `super_admin` bypass it?
19. **No semicolons** — the codebase uses none
20. **No TypeScript** — the codebase is plain JavaScript with ESM
21. **No new dependencies without justification** — prefer solving problems with existing libraries
