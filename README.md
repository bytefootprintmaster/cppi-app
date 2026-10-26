# CPPI — Construction Project Portfolio Intelligence

A portal for managing multiple building projects (real-estate developments, houses, apartments)
across roles, with S3-backed files and a customisable KPI dashboard.

Built as a single deployable Node app: an Express API plus a React SPA served from the same
process, so it fits a Hostinger Node.js application with one startup file.

---

## 1. What it does

| Area | Capability |
| --- | --- |
| **Projects** | Admins create building sites (name, code, location, status, dates, budget, description). |
| **Development framework** | Admins define stages and the milestones inside each stage, and move their status forward. |
| **Files** | Photos and documents upload straight to a private S3 bucket via presigned URLs. Downloads use short-lived signed links. |
| **Remarks** | Admin and contractor users post project remarks; they can optionally be tied to a stage. |
| **Dashboard** | Admin (and any user) sees a portfolio tracker with **customisable KPIs** — pick which metrics headline the view. |
| **Access** | Google sign-in. Admins invite people by generating a link, assign a role, and scope which projects they can open. |
| **Progress** | Completion is driven by completed milestones, falling back to completed stages when no milestones exist. |

### Roles

| Role | Can do |
| --- | --- |
| `admin` | Everything: create/edit/delete projects, define stages & milestones, manage users and invitations, upload, remark. |
| `contractor` | Upload photos and documents, post remarks, on the projects they are granted. |
| `viewer` | Read-only access to granted projects. |

The **first account that ever signs in** becomes an admin. Emails listed in `ADMIN_EMAILS` are
always granted admin on login.

---

## 2. Architecture

```
Browser (React SPA)  ──►  Express API  ──►  DynamoDB (metadata)
        │                      │
        └── presigned PUT ─────┴──►  S3 (photos & documents, private)
```

- **Frontend** — React 18 + Vite + TypeScript, hand-written CSS design system (deep greens on white).
- **Backend** — Express + TypeScript, bundled by esbuild into a single CommonJS file.
- **Data** — DynamoDB, 8 tables on `PAY_PER_REQUEST`, all in `us-east-2`.
- **Storage** — one private S3 bucket; the browser never sees AWS credentials.

### DynamoDB tables (default prefix `cppi_`)

| Table | Partition key | Sort key | Notes |
| --- | --- | --- | --- |
| `cppi_users` | `userId` | — | GSI `email-index` on `email` |
| `cppi_invites` | `token` | — | GSI `email-index` on `email` |
| `cppi_sites` | `siteId` | — | projects |
| `cppi_stages` | `siteId` | `stageId` | per-project |
| `cppi_milestones` | `siteId` | `milestoneId` | per-project |
| `cppi_assets` | `siteId` | `assetId` | file metadata (S3 key) |
| `cppi_remarks` | `siteId` | `remarkId` | per-project |
| `cppi_kpis` | `userId` | — | dashboard KPI selection per user |

S3 object layout: `sites/{siteId}/{image|document}/{uuid}-{filename}`

---

## 3. Local development

```bash
npm install
cp .env.example .env     # then fill in the values
npm run dev              # API on :8787, Vite dev server on :5173
```

Vite proxies `/api` to the API, so open <http://localhost:5173>.

| Script | Purpose |
| --- | --- |
| `npm run dev` | API + web together |
| `npm run build` | Builds the SPA **and** `dist/server.cjs` |
| `npm start` | Runs the production bundle |
| `npm run setup:infra` | Creates the DynamoDB tables and the S3 bucket (idempotent) |
| `npm run typecheck` | TypeScript check |

---

## 4. Environment variables

Copy `.env.example` to `.env` locally. **Never commit `.env`** — it is gitignored.

| Variable | Required | Example | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | `production` | |
| `PORT` | no | `8787` | Hostinger injects its own; the app reads whatever is set. |
| `APP_URL` | yes | `http://cppimi.com` | Used for invitation links and S3 CORS. Switch to `https://` once SSL is active. |
| `JWT_SECRET` | yes | long random string | Signs session tokens. Generate: `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID` | yes | `…apps.googleusercontent.com` | From Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | yes | `GOCSPX-…` | Only needed if you later add server-side OAuth flows. |
| `AWS_REGION` | yes | `us-east-2` | **Must stay `us-east-2`** — `us-east-1` is blocked by the organisation SCP. |
| `AWS_ACCESS_KEY_ID` | yes | `AKIA…` | IAM user with `AmazonDynamoDBFullAccess` + S3 access to the bucket. |
| `AWS_SECRET_ACCESS_KEY` | yes | — | |
| `S3_BUCKET` | yes | `cppi-portal-files` | Created by `npm run setup:infra`. |
| `ADMIN_EMAILS` | no | `you@company.com,pm@company.com` | Comma-separated; always granted admin. |
| `TABLE_PREFIX` | no | `cppi_` | DynamoDB table name prefix. |

---

## 5. One-time setup

### 5.1 AWS

The IAM user already has `AmazonDynamoDBFullAccess` and S3 access, so provisioning is one command:

```bash
# with AWS keys present in .env
npm run setup:infra
```

It creates the 8 tables and the private bucket, applies a public-access block, and sets CORS for
`APP_URL`, `http://localhost:5173` and `http://localhost:8787`. Safe to re-run.

> If you change `APP_URL` (for example from `http://` to `https://`), re-run `npm run setup:infra`
> so the bucket CORS is updated.

### 5.2 Google sign-in

1. Go to <https://console.cloud.google.com/apis/credentials> and create an **OAuth client ID** of
   type **Web application**.
2. **Authorized JavaScript origins** — add all that apply:
   - `http://cppimi.com`
   - `https://cppimi.com` (once SSL is on)
   - `http://localhost:5173`
3. Copy the client ID into `GOOGLE_CLIENT_ID`.
4. No redirect URI is needed — the app uses Google Identity Services in popup mode and verifies the
   ID token server-side with `google-auth-library`.

### 5.3 First admin

Start the app and sign in with Google once — the first account becomes an admin automatically.
Alternatively list yourself in `ADMIN_EMAILS` before the first login.

---

## 6. Deploying to Hostinger

### 6.1 Application settings

Use exactly these values in **hPanel → Advanced → Node.js**:

| Field | Value |
| --- | --- |
| **Node.js Version** | `25.9.0` |
| **Package Manager** | `npm` |
| **Document Root** | `/httpdocs/dist` |
| **Application Mode** | `production` |
| **Application URL** | `http://cppimi.com` |
| **Application Root** | `/httpdocs` |
| **Application Startup File** | `dist/server.cjs` |
| **Custom environment variables** | see 6.3 |

Why this works: `npm run build` emits `dist/index.html`, `dist/assets/*` (the SPA) and
`dist/server.cjs` (the API bundle). `dist/server.cjs` serves the API under `/api` **and** the SPA
from its own directory, with a catch-all so client-side routes such as `/sites/:id` resolve. The
document root therefore points at `dist`.

### 6.2 Deploy steps

1. In hPanel, create the Node.js application with the settings above (this creates `/httpdocs`).
2. Get the code into `/httpdocs`. Either connect the GitHub repo
   (`https://github.com/bytefootprintmaster/cppi-app`) or push via SSH from your machine:
   ```bash
   cd /httpdocs
   git init
   git remote add origin https://github.com/bytefootprintmaster/cppi-app.git
   git fetch --all && git checkout -f main
   ```
3. Install and build (Hostinger's Node.js panel runs `npm install`; run the build explicitly):
   ```bash
   cd /httpdocs
   npm install
   npm run build
   ```
   If your panel exposes a build command, set it to `npm run build` so every deploy rebuilds.
4. Provision AWS once, from the server (so it uses the production `.env`):
   ```bash
   npm run setup:infra
   ```
5. Restart the application from the panel (**Restart**).

### 6.3 Custom environment variables to add in the panel

Add each of these under **Custom environment variables** (same names as `.env`):

```
NODE_ENV=production
APP_URL=http://cppimi.com
JWT_SECRET=<run: openssl rand -hex 32>
GOOGLE_CLIENT_ID=<your Google web client id>
GOOGLE_CLIENT_SECRET=<your Google web client secret>
AWS_REGION=us-east-2
AWS_ACCESS_KEY_ID=<your access key id>
AWS_SECRET_ACCESS_KEY=<your secret access key>
S3_BUCKET=cppi-portal-files
ADMIN_EMAILS=<your email>,<optional second admin>
TABLE_PREFIX=cppi_
```

Do **not** set `PORT` — Hostinger assigns it and the app reads it automatically.

Alternatively, drop a `.env` file at `/httpdocs/.env` with the same keys; the app loads
`<cwd>/.env` first, then `../.env`.

### 6.4 Verify

- `http://cppimi.com/api/health` → `{"ok":true,"service":"cppi-app","region":"us-east-2"}`
- `http://cppimi.com/` → the login screen
- A deep link such as `http://cppimi.com/sites` → still the SPA (not a 404)

### 6.5 Go-live checklist

- [ ] `JWT_SECRET` is a fresh random value (not the development default).
- [ ] Enable SSL in hPanel, then change `APP_URL` to `https://cppimi.com`.
- [ ] Re-run `npm run setup:infra` after changing `APP_URL` (updates S3 CORS).
- [ ] Add `https://cppimi.com` to Google's **Authorized JavaScript origins**.
- [ ] Confirm `AWS_REGION=us-east-2`.
- [ ] Sign in once to create the first admin.

---

## 7. API reference

All endpoints are under `/api`. Authenticated calls send `Authorization: Bearer <session token>`.

| Method & path | Access | Purpose |
| --- | --- | --- |
| `GET /api/config` | public | App name, Google client ID, app URL |
| `GET /api/health` | public | Liveness + region |
| `POST /api/auth/google` | public | Exchange a Google ID token for a session token |
| `GET /api/auth/me` | auth | Current user |
| `GET /api/dashboard` | auth | Portfolio rows, totals, KPI selection |
| `GET /api/dashboard/kpis` · `PUT /api/dashboard/kpis` | auth | Read / save KPI selection |
| `GET /api/sites` · `POST /api/sites` | auth / admin | List / create projects |
| `GET /api/sites/:id` | auth | Site + stages + milestones + progress |
| `PATCH /api/sites/:id` · `DELETE /api/sites/:id` | admin | Update / delete (cascades files and children) |
| `…/stages` `…/milestones` (GET/POST/PATCH/DELETE) | admin writes | Development framework |
| `POST /api/sites/:id/assets/presign` | admin, contractor | Get a presigned S3 PUT URL |
| `POST /api/sites/:id/assets` | admin, contractor | Register the uploaded object |
| `GET /api/sites/:id/assets/:assetId/url` | auth | Presigned download URL |
| `DELETE /api/sites/:id/assets/:assetId` | uploader or admin | Delete file + S3 object |
| `…/remarks` (GET/POST/DELETE) | admin, contractor write | Project remarks |
| `GET /api/invites/:token` | public | Invitation preview |
| `POST /api/invites/:token/accept` | auth | Accept invitation |
| `/api/admin/users` (GET/PATCH/DELETE) | admin | Manage users, roles, project access |
| `/api/admin/invites` (GET/POST/DELETE) | admin | Create / list / revoke invitations |
| `GET /api/admin/overview` | admin | Counts + runtime config diagnostics |

---

## 8. Roadmap

- **Next phase:** an AI agent that watches S3 for newly added files and updates the dashboard
  automatically (progress extraction from photos/documents and reports).
- Email delivery of invitation links (currently links are copied and shared manually).
