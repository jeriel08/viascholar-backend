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
