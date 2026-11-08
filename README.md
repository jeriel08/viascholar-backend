# ViaScholar Backend API

> An intelligent, automated scholarship management and academic verification platform built with NestJS, Prisma ORM, PostgreSQL (Supabase), and Parseur Vision AI.

---

## 📌 About the Project

**ViaScholar** streamlines and automates the end-to-end scholarship lifecycle for foundations, educational grantors, and academic coordinators.

The platform eliminates manual grade encoding and eligibility verification bottlenecks through:

- **Zero-Template Vision AI Document Parsing:** Automated ingestion of multi-page transcripts (College Transcripts of Records and Senior High DepEd Form 137/138).
- **Adaptive Multi-School Grading Engine:** Dynamic evaluation supporting diverse university scales (e.g., University of Mindanao's 1.0–4.0 scale, special institutional status codes like `7.1`, `7.2`, `9.0`, and standard 100-point percentage systems).
- **Transparent Academic Auditability:** System-wide audit trails, role-based governance, and real-time retention threshold tracking (default: 90.00% GWA).

---

## 🛠️ Technology Stack

- **Framework:** [NestJS](https://nestjs.com/) (Node.js / TypeScript)
- **Database & ORM:** PostgreSQL on [Supabase](https://supabase.com/) via [Prisma ORM](https://www.prisma.io/)
- **Authentication & Security:** Passport.js, JWT (JSON Web Tokens), `bcrypt`, Role-Based Access Control (RBAC)
- **Media & Cloud Storage:** [Cloudinary SDK](https://cloudinary.com/) (Streaming buffers)
- **Document Processing & OCR:** [Parseur Vision AI](https://parseur.com/) (Zero-template OCR Webhooks) & `pdf-lib` (multi-page image-to-PDF compilation)
- **API Documentation:** OpenAPI / Swagger
- **Testing:** [Vitest](https://vitest.dev/) with `@swc/core` for NestJS decorator metadata

---

## 🏗️ Architecture & Modules Overview

### 1. Authentication & RBAC (`/auth`)

- Secure registration and authentication with JWT access tokens.
- Granular 4-tier Role-Based Access Control: `ADMIN`, `GRANTOR`, `COORDINATOR`, and `SCHOLAR`.
- Self-service profile management, avatar uploads, and cover banner asset management.

### 2. User Management & Admin Governance (`/users`)

- Administrative user lookups, filtering by role, and case-insensitive keyword search.
- Account status activation/deactivation toggle (`is_active`).
- Administrative password reset utility with automatic audit trail creation.

### 3. Centralized Audit Engine (`/audit`)

- Global event logging capturing mutations: `action`, `user_id`, `details`, and ISO timestamps.
- Review historical changes to user statuses, policy settings, application milestones, and document validations.

### 4. Settings & Adaptive Grading Engine (`/settings`)

- Global system settings with configurable mandatory retention threshold (default: **90.00%**).
- Dynamic school grading system manager storing passing/highest/lowest boundaries and JSON-mapped special status codes (`DROPPED`, `LACKING_REQUIREMENTS`, `UNPAID`).
- Built-in grade evaluation helper reconciling varying school scales.

### 5. Scholarship Applications Pipeline (`/applications`)

- Scholar track selection, personal information submission, and status monitoring.
- Multi-stage pipeline tracker: `Submitted` ➔ `Under Review` ➔ `Interview Scheduled` ➔ `Approved` / `Rejected`.
- Coordinator and Grantor review workflow with rejection reasoning and provider notes.

### 6. Document Ingestion & AI Verification (`/documents`, `/webhooks`)

- Multi-file image and PDF upload handler with automated in-memory PDF stitching (`pdf-lib`).
- Cloudinary media dispatch and asynchronous offloading to Parseur Vision AI.
- Automated webhook listener (`POST /webhooks/parseur`) handling:
  - Document pre-check validation (`PASSED_PRECHECK` vs `NEEDS_REUPLOAD`).
  - Student identity, degree program, and registrar signature verification.
- Side-by-side Coordinator review and confirmation workflow (`PATCH /documents/:id/verify`) triggering weighted GWA computation and `GradeReport` generation.

---

## 🚦 Development Status & Roadmap

| Module                         |    Status     | Description                                                                        |
| :----------------------------- | :-----------: | :--------------------------------------------------------------------------------- |
| **Auth & Security**            |  `Completed`  | JWT auth, password hashing, role guards, user profile API.                         |
| **Cloudinary Integration**     |  `Completed`  | Modular file upload streaming for avatars and documents.                           |
| **Audit Logging Engine**       |  `Completed`  | Global audit logger tracking platform mutations.                                   |
| **Settings & School Grading**  |  `Completed`  | Threshold settings and school-specific scale configuration with JSON status codes. |
| **Applications Module**        |  `Completed`  | Application submission, stage progression, and filtering.                          |
| **Documents & Parseur AI**     |  `Completed`  | Multi-image merging, Parseur webhook receiver, and grade verification.             |
| **Contracts & E-Signatures**   | `In Progress` | Scholarship agreement generation and digital scholar acceptance.                   |
| **Disbursements & Accounting** |   `Pending`   | Stipend tranches, release dates, and official receipt (OR) uploads.                |
| **Analytics & Reports**        |   `Pending`   | Grantor visual dashboards, GWA trendline tracking, and at-risk scholar alerts.     |
| **In-App Notifications**       |   `Pending`   | Real-time deficiency notices, event reminders, and review alerts.                  |

---

## 🧪 Testing

Unit tests live next to the code they cover as `*.spec.ts` files. Test names are
written as behavior sentences inside nested `describe` blocks, so the terminal
output reads like a specification:

```text
✓ src/auth/auth.service.spec.ts (33 tests)
  ✓ AuthService (33)
    ✓ registerScholar (4)
      ✓ rejects an email that is already registered
      ✓ creates an applicant account with a hashed password and returns a token
    ✓ login (5)
      ✓ rejects a disabled account
      ✓ updates the last login, audits the login, and returns a token
```

```bash
# Run every unit test once (tree output shows every scenario)
npm test

# Compact summary only (one line per spec file)
npm run test:summary

# Flat list of every test name
npm run test:verbose

# Re-run tests on file changes
npm run test:watch

# Run coverage (HTML report is written to coverage/)
npm run test:cov

# Run a single module/folder (e.g. auth or academic-baseline)
npm run test:module -- src/auth
npm run test:module -- src/academic-baseline

# Run end-to-end tests
npm run test:e2e
```

Tests import their APIs explicitly from `vitest` (no Jest globals), and NestJS
dependency injection continues to work because SWC emits decorator metadata.

When adding a test, put the class or function under test in the outer
`describe`, the method/scenario in a nested `describe`, and the expected
behavior in `it(...)`:

```ts
describe('AuthService', () => {
  describe('login', () => {
    it('rejects a disabled account', async () => {
      // ...
    });
  });
});
```

---

## ⚙️ Environment Configuration

Create a `.env` file in the root directory and configure the following parameters:

```env
# Server
PORT=3000
NODE_ENV=development

# Database (Supabase PostgreSQL)
DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION][.pooler.supabase.com:6543/postgres?pgbouncer=true](https://.pooler.supabase.com:6543/postgres?pgbouncer=true)"
DIRECT_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION][.pooler.supabase.com:5432/postgres](https://.pooler.supabase.com:5432/postgres)"

# JWT Authentication
JWT_SECRET="your_secure_jwt_secret_key"
JWT_EXPIRES_IN="7d"

# Cloudinary Storage
CLOUDINARY_CLOUD_NAME="your_cloudinary_cloud_name"
CLOUDINARY_API_KEY="your_cloudinary_api_key"
CLOUDINARY_API_SECRET="your_cloudinary_api_secret"

# Parseur AI OCR Engine
PARSEUR_API_KEY="your_parseur_api_key"
PARSEUR_MAILBOX_ID="your_parseur_mailbox_id"
```
