# Persistent Counter

The [demo](https://takahirox.github.io/sandbox/projects/persistent-counter/)
is plain HTML/JavaScript served by the existing GitHub Pages build. It calls
`GET /api/counter` to load the shared value and
`POST /api/counter/increment` to atomically increment it in Cloudflare D1.
The Worker never holds the counter in memory. Responses disable caching and
reads go to the D1 primary, so a reload or another browser reads persisted state.

## Deployment

The existing [Pages workflow](../.github/workflows/pages.yml) validates every
pull request without Cloudflare secrets or production writes. On pushes to
`main` (and manual runs on `main`), it then:

1. Discovers the account's workers.dev subdomain. If none exists, it registers
   `sandbox-<hash of account ID>` through the Cloudflare API. An existing
   subdomain is always preserved.
2. Finds the D1 database named `sandbox-persistent-counter`, or creates it if
   missing. Its discovered ID is written into ignored `wrangler.generated.json`.
3. Applies unapplied versioned migrations through Wrangler, then deploys the
   Worker using that generated configuration.
4. Rebuilds the Pages artifact with the public Worker URL in `api-config.json`,
   then publishes it through the existing Pages deployment.

The workflow serializes runs on `main`, including the Pages publication, so
deployments and migrations do not overlap. A failed backend deployment stops
the new Pages publication. Repeated runs reuse the database and migration
history; they do not reset its value. Add schema changes as new numbered SQL
files in `workers/persistent-counter/migrations/`; do not edit an applied
migration or the production schema manually. Keep future migrations compatible
with the currently deployed Worker because migrations run before deployment.

Configuration lives in `workers/persistent-counter/wrangler.json`. The only
allowed production browser origin is `https://takahirox.github.io` (CORS origins
cannot include the `/sandbox/` path). Only GET and POST on their respective
endpoints are supported, with narrow OPTIONS preflight handling and no extra
request headers or credentials. Foreign and missing origins cannot increment.
The counter is intentionally public and shared; CORS does not authenticate
callers.

The already configured Actions secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are read only in the provisioning/deployment steps.
The token needs **Account / Workers Scripts / Edit** and **Account / D1 / Edit**
for that account. Account onboarding and token permissions are the only setup
prerequisites; no manual D1 creation, binding ID, endpoint variable, or schema
editing is required. Cloudflare API failures stop provisioning without automatic
retries. If permissions are insufficient, an account owner must correct the
token permissions; CI cannot grant itself access.

The generated Wrangler configuration is never published. Only the public API
URL goes into the Pages artifact. The committed empty URL shows an explanatory
message during an unconfigured static preview instead of calling production.

API references: [D1 creation](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/),
[workers.dev registration](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/),
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## Local development and pre-merge checks

Python 3.9+ still suffices for the static build. Worker development and the full
integration checks also require Node.js 22+ (CI uses Node.js 24).

From the repository root:

```sh
python3 -m unittest discover -s tests -v
python3 scripts/build_site.py
cd workers/persistent-counter
npm ci
npm test
npm run build
npm run migrate:local
npm run migrate:local
npx playwright install chromium
npm run test:browser
```

`npm test` uses the Workers runtime and real local D1 to check the migration,
concurrent atomic increments, persistence across Worker restarts, routing, and
CORS. It also checks provisioning with mocked Cloudflare API responses, including
first creation, reuse, pagination, and failures. The dry run validates the
Wrangler configuration and bundle. Applying local migrations twice validates
Wrangler's migration history and verifies the second application is a no-op.
The browser check serves the built site under `/sandbox/`, opens the project
from its index, and checks loading, incrementing, reloading, another independent
browser context, and useful network error handling. No check calls production.

For an interactive preview, apply the local migration and run `npm run dev` in
the Worker directory. From the repository root, build the site and set the
**generated local artifact's** config (leave the tracked source config empty):

```sh
python3 scripts/build_site.py
python3 -c 'import json; from pathlib import Path; Path("_site/projects/persistent-counter/api-config.json").write_text(json.dumps({"apiUrl": "http://localhost:8787"}))'
python3 -m http.server 8000 --directory _site
```

Open `http://localhost:8000/projects/persistent-counter/`. The development
command permits exactly `http://localhost:8000`; use that hostname rather than
`127.0.0.1`. Local D1 state is saved under ignored `.wrangler/` and is separate
from production.

## Required post-merge verification (pending)

These checks require the main-branch deployment and remain pending until it runs:

1. Confirm the Pages workflow successfully provisions/reuses D1, applies remote
   migrations, deploys the Worker, and publishes Pages.
2. Open the published demo from the sandbox index, increment it, reload, and
   confirm the saved value. Open another browser/device and confirm the same
   shared value (assuming no other visitor increments between checks).
3. Confirm the document comes from GitHub Pages and the API requests go to the
   discovered `sandbox-persistent-counter.<subdomain>.workers.dev` endpoint.
4. Confirm the Cloudflare Worker has its `DB` binding and the D1 `counter` row
   agrees with the API. A read-only SQL query is sufficient:
   `SELECT value FROM counter WHERE id = 1`.
5. Run the workflow again on `main` and confirm the database is reused, applied
   migrations are skipped, and the value survives redeployment.
