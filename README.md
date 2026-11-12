# Scheduler

Multi-tenant staff scheduling application with React/Vite frontend and Python API.

## Local development

Run `npm ci --ignore-scripts`, `npm run build`, then `npm start`. Run `npm run typecheck`, `npm run lint`, and `npm test` for validation. Production Firebase dependencies are pinned in requirements.production.txt; tests requiring the Firebase SDK or browser tooling may skip without those optional local dependencies.

The Team plan is LKR 3,990 per month, up to three branches and 50 active staff, with a seven-day no-card trial. Live checkout and production activation are disabled.

See [publication scope and shipping gates](docs/PUBLICATION-2026-11-12.md). Owner-specific private cloud-operation scripts and their tests are intentionally not part of this public snapshot. Deployment templates remain disabled examples, not activation instructions or hosted acceptance evidence.
