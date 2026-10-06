# Persistent Counter

The [demo](https://takahirox.github.io/sandbox/projects/persistent-counter/)
is plain HTML/JavaScript served by the existing GitHub Pages build. Every open
page subscribes to `GET /api/counter/ws` using a WebSocket. A single named
Durable Object (`shared-counter` in the `COUNTER` binding) coordinates all
subscriptions, reads, and increments. Pressing **PUSH** immediately adds one to
the local display and queues one `POST /api/counter/increment`. Each POST carries
a unique UUID in its plain-text body; after D1 commits, the object broadcasts
`{ value, intentId }` to every connected browser. Snapshots and increments from
legacy API clients with empty POST bodies still use `{ value }`. No reload or
polling is needed to see another visitor's increment. `GET /api/counter` remains available for one-off API reads;
the frontend never uses it.

## Shared game interface

The default page fills the screen with one shared, formatted number, a large
**PUSH** button, a small **LIVE** indicator, and “counted together.” A press has
immediate tactile and numeric feedback; each changed displayed value briefly
lifts the number and sends a restrained ring around the button, including remote
updates. The button stays enabled during writes, including keyboard input.
The initial snapshot and unchanged snapshots do not animate. Reduced-motion
preferences suppress these effects, including cancelling active effects if the
preference changes. The native button supports keyboard and touch input with a
visible keyboard focus ring. Large values scale down to fit mobile screens.

Append `?debug=1` to the existing counter URL to show a collapsible diagnostic
overlay. It reports WebSocket transport and synchronization state, cumulative
reconnect attempts, scheduled retry delay, API origin, the last authoritative
value and receipt time, pending optimistic presses, unsent queued presses,
write-request state, persistence confirmation, last socket close, and the last
error. Optimistic renders do not overwrite the authoritative diagnostic value
or its receipt time. This information stays out of the normal layout. A minimal
**Reconnecting…**, **Offline · reconnecting…**, or **Unavailable** indicator
replaces **LIVE** when appropriate. An uncertain push gets a short notice;
technical error details are retained in debug mode.

## State and connection model

D1's existing `counter` row is the **only source of truth**. The Durable Object
does not cache the value or duplicate it in object storage. It gates each D1
read/update and the resulting snapshot/broadcast with
[`blockConcurrencyWhile`](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)
so asynchronous database work cannot reorder pushed values. Increments use
`UPDATE … RETURNING value`, and every operation uses a `first-primary` D1
session. All API access goes through the same object, including existing HTTP
endpoints. Existing D1 data needs no new schema migration and is preserved.

The object uses `ctx.acceptWebSocket`, `ctx.getWebSockets`, and the
`webSocketMessage`/`webSocketClose`/`webSocketError` handlers from Cloudflare's
[WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
It has no timers or in-memory socket list that would prevent hibernation.
Hibernation can discard its JavaScript instance while Cloudflare retains live
sockets. A new instance reads D1 again on the next request. Browser reloads,
all clients disconnecting, object eviction, and Worker redeployments therefore
preserve the counter. The SQLite-backed object class configuration enables
hibernation-compatible coordination without using a second counter database.
The tradeoff is one D1 primary operation per read or increment and serialization
through one object, appropriate for this shared demo. Database writes outside
the object (for example, manual SQL) cannot broadcast to subscribers.

Each connection receives a current D1 snapshot before the UI reports
**LIVE** and enables **PUSH**. Unexpected closure triggers reconnection with
bounded exponential backoff and jitter; offline clients show **Offline · reconnecting…**.
Every reconnection waits for a fresh authoritative snapshot. The last value
remains visible with the reconnecting indicator while reconnecting. Reconnection
timers only establish WebSockets; they never fetch the counter periodically.

WebSockets remain push-only. The browser tracks a map of pending optimistic
intents and a FIFO queue of unsent intents. Displayed state is the latest
ordered authoritative value plus the number of pending intents (bounded by the
largest safe integer). Each accepted press adds its own UUID to both structures
and renders synchronously before network work. One POST runs at a time; further
presses remain enabled and queue immediately. A pending write retains keyboard
focus. Neither remote broadcasts nor network latency discard queued presses.

A committed broadcast carrying a local `intentId` acknowledges that intent and
removes its optimistic contribution in the same render that applies the new
authoritative value. Remote increments change the authoritative portion while
preserving remaining local optimism. HTTP responses acknowledge acceptance too:
if the stream has already reached the response's value, its optimistic intent
is removed; otherwise it remains pending until the ordered stream catches up.
A delayed HTTP response never overwrites a newer streamed value. Thus either
HTTP/broadcast ordering avoids double-counting. Identifiers correlate acceptance;
they are **not** server-side idempotency keys and must never be resubmitted.

A failed or timed-out POST is never retried. If its matching committed broadcast
already arrived, acceptance is confirmed despite the HTTP failure. Otherwise,
the browser shows “Couldn’t confirm that push,” retains technical details only
in debug mode, and reconnects for a fresh authoritative snapshot. After a
subscription interruption, that snapshot replaces optimism for already-sent
intents, with a notice for any unconfirmed intent; unsent intents are retained
and drain once synchronization and the current POST finish. Already-sent
intents are never placed back in the queue, including after reconnect or a
back/forward cache restore. Late responses from a superseded connection cannot
close a newer healthy subscription. A sent request may still commit after a
snapshot; its later broadcast applies as authoritative state without replay.
Queue state lives in the current page and does not survive a full page reload.

An interrupted sent press cannot be guaranteed without persistent backend
deduplication: it may have committed even if both its acknowledgement and
broadcast were lost. This design makes uncertainty visible and reconciles from
D1 instead of silently resubmitting and risking duplicate increments. There are
no periodic HTTP reads or mutation retry timers.

## Deployment

The existing [Pages workflow](../.github/workflows/pages.yml) validates every
pull request without Cloudflare secrets or production writes. On pushes to
`main` (and manual runs on `main`), it then:

1. Discovers the account's workers.dev subdomain. If none exists, it registers
   `sandbox-<hash of account ID>` through the Cloudflare API. An existing
   subdomain is always preserved.
2. Finds the D1 database named `sandbox-persistent-counter`, or creates it if
   missing. Its discovered ID is written into ignored `wrangler.generated.json`.
3. Applies unapplied D1 migrations through Wrangler, then deploys the Worker
   and its Durable Object binding/class migration using that generated
   configuration. Wrangler creates the object namespace automatically.
4. Rebuilds the Pages artifact with the public Worker URL in `api-config.json`,
   then publishes it through the existing Pages deployment.

The workflow serializes runs on `main`, including the Pages publication, so
deployments and migrations do not overlap. A failed backend deployment stops
the new Pages publication. Repeated runs reuse the database and migration
history; they do not reset its value. Add schema changes as new numbered SQL
files in `workers/persistent-counter/migrations/`; do not edit an applied
migration or the production schema manually. Keep future migrations compatible
with the currently deployed Worker because migrations run before deployment.
Durable Object class migrations live separately in Wrangler's `migrations`
array; preserve existing tags and add a new tag for future class changes.
Keep the class name and shared object name stable across deployments.

Configuration lives in `workers/persistent-counter/wrangler.json`. The only
allowed production browser origin is `https://takahirox.github.io` (CORS origins
cannot include the `/sandbox/` path). Only GET and POST on their respective
endpoints are supported, with narrow OPTIONS preflight handling and no extra
request headers or credentials. The WebSocket endpoint requires GET, an upgrade,
and the allowed browser origin. Foreign and missing origins cannot increment
or subscribe; the existing origin-less HTTP read remains available.
The counter is intentionally public and shared; CORS does not authenticate
callers.

The already configured Actions secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are read only in the provisioning/deployment steps.
The token needs **Account / Workers Scripts / Edit** and **Account / D1 / Edit**
for that account; Durable Objects deploy with the Workers Scripts permission.
Account onboarding and token permissions are the only setup
prerequisites; no manual D1 or Durable Object creation, binding ID, endpoint
variable, or schema editing is required. Cloudflare API failures stop provisioning
without automatic retries. If permissions are insufficient, an account owner must correct the
token permissions; CI cannot grant itself access.

The generated Wrangler configuration is never published. Only the public API
URL goes into the Pages artifact. The committed empty URL shows **Unavailable**
during an unconfigured static preview instead of calling production; debug mode
explains the missing configuration.

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
concurrent atomic increments, ordered WebSocket broadcasts to multiple clients,
initial/reconnected snapshots, intent-correlated acknowledgements to every
listener, invalid intent rejection before writes, closed listeners, read-only
socket messages, persistence across Worker/object reinitialization, routing,
and origin checks.
It also checks provisioning with mocked Cloudflare API responses, including
first creation, reuse, pagination, and failures. The dry run validates the
Wrangler configuration and bundle. Applying local migrations twice validates
Wrangler's migration history and verifies the second application is a no-op.
The browser checks serve the built site under `/sandbox/` and use two independent
browser contexts connected simultaneously to a real local Worker. They verify
push in both directions without reload, concurrent clicks, reload persistence,
reconnection with a delayed authoritative snapshot, disabled writes before
synchronization, a committed increment with both acknowledgements lost, a delayed
POST response after a newer broadcast, synchronous feedback on eight rapid
presses, distinct queued intents, interleaved remote updates without
double-counting,
HTTP acceptance before its broadcast, lost HTTP responses confirmed through
broadcasts, preservation of unsent presses after committed and uncommitted
uncertain writes, late success/failure responses after reconnect, no repeated
mutations or periodic HTTP reads, D1 agreement, backend recovery, and
unconfigured preview behavior. They also check local/remote animation feedback, keyboard focus and Enter/Space input,
mobile touch and landscape layout, formatting through the largest safe integer,
reduced motion (including remote updates and preference changes), a minimal
normal layout, and debug diagnostics for reconnects and errors. No check
calls production. Local reinitialization verifies persistence; production
hibernation and deployment are covered by the post-merge checks below.

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
   migrations, deploys the Worker and Durable Object migration, and publishes Pages.
2. Open the published demo in two independent browsers/devices. Confirm both
   report LIVE and the same value. Increment from each and confirm the
   other updates immediately without reload. Reload and confirm persistence.
   Disconnect one browser, increment from the other, reconnect, and confirm
   the first resynchronizes before reporting LIVE.
3. Press eight times rapidly and confirm eight immediate local increments and
   eventual agreement between both clients and D1. Confirm the button remains
   responsive during network delay and reconnects never replay sent presses.
   Confirm the document comes from GitHub Pages and the WebSocket and POST
   requests go to the discovered
   `sandbox-persistent-counter.<subdomain>.workers.dev` endpoint. Confirm an
   idle page has no periodic HTTP counter requests in the network panel.
4. Confirm the Cloudflare Worker has `DB` and `COUNTER` bindings, the
   `Counter` class uses the Hibernation API, and the D1 `counter` row
   agrees with the API. A read-only SQL query is sufficient:
   `SELECT value FROM counter WHERE id = 1`.
5. Run the workflow again on `main` and confirm the database is reused, applied
   migrations are skipped, and the value survives redeployment. Leave clients
   idle to allow object hibernation, then increment and confirm broadcasts
   continue with the saved value. Disconnect all clients and reconnect later
   to confirm persistence.
6. Confirm the published page has the minimal number/PUSH layout and that both
   local and remote increments visibly react. Check keyboard focus, a mobile
   viewport, and reduced motion. Open `?debug=1` and confirm live diagnostics
   appear, then return to the normal URL and confirm they are hidden.
