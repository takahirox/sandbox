# Persistent Counter

The [demo](https://takahirox.github.io/sandbox/projects/persistent-counter/)
is plain HTML/JavaScript served by GitHub Pages. Every open page subscribes to
`GET /api/counter/ws?clientId=<UUID>` using a WebSocket. One named Durable Object
(`shared-counter` in the `COUNTER` binding) coordinates reads, presses, and
subscriptions. **PUSH** immediately increments the local display and sends
`{ type: "increment", intentId: "<UUID>" }` on that connection. Every accepted
press is saved to Durable Object SQLite storage before its result is broadcast
to all connected browsers. D1 receives periodic checkpoints. There are no
per-click frontend HTTP requests, counter polling, or mutation retries.

## Traffic policy and protocol

The browser saves an anonymous client UUID in local storage and reuses it across
reloads and tabs. If storage is unavailable, it uses a UUID for the current page.
Each press has a separate UUID to correlate its acknowledgement. Neither
identifier authenticates a caller or acts as a server-side idempotency key.

The object applies two token buckets before accepting a press:

| Key | Sustained refill | Burst capacity |
| --- | --- | --- |
| Anonymous client | 15 presses/second | 30 presses |
| IP, secondary control | 150 presses/second | 300 presses |

Ten clients can each sustain 15 presses/second on one shared IP. Rotating client
IDs still consumes the shared IP bucket. The address comes from Cloudflare's
`CF-Connecting-IP` header at connection creation, never a WebSocket message or
forwarded header. Only its SHA-256 hash is retained. Socket attachments preserve
the identity across hibernation. These are soft abuse controls; shared networks
are intentionally given considerably more headroom than one client.

Rate buckets live in memory to avoid extra persistent writes for every press.
Both refill completely within two seconds. Normal idle
[hibernation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
outlasts that refill window; an unexpected runtime restart or redeployment may
grant a fresh burst. Only accepted intents create bucket entries, and checkpoint
alarms remove fully refilled entries. The persistent daily cap remains effective
through every kind of restart.

At most **20,000 increments per UTC day** are accepted. Count and usage are
updated in one storage transaction under `blockConcurrencyWhile`, along with
the durable checkpoint alarm. Parallel HTTP and WebSocket clients share this
same decision. The day and usage are persisted; recreating an object does not
reset them. The next UTC day resets usage without resetting the lifetime count.
When the budget is exhausted, an alarm pushes the midnight reset to subscribed
pages so **PUSH** becomes available again without a reload or polling. Reads and
subscriptions remain available at the limit.

An initial/reconnected snapshot and checkpoint updates have this shape:

```json
{
  "type": "snapshot",
  "value": 123,
  "budget": { "day": "2026-10-06", "used": 10, "limit": 20000, "resetAt": 1791331200000 },
  "checkpoint": 120,
  "checkpointPending": true,
  "checkpointFailures": 0
}
```

Each accepted intent broadcasts the same fields with `type: "incrementResult"`,
`outcome: "accepted"`, and its `intentId`. Rejections go only to the initiating
socket with `outcome: "rejected"`, the same authoritative state, a `reason`
(`client_rate_limit`, `ip_rate_limit`, `daily_limit`, or `counter_full`), and
`retryAfterMs`. Invalid/binary/oversized messages close the connection with code
1008 before writing. A persistence error closes it with code 1011 so the browser
resynchronizes; it must never assume an uncertain intent is safe to replay.

`GET /api/counter` remains available for one-off reads; the frontend does not use
it. Legacy `POST /api/counter/increment` is also retained, with the same budget,
limits, immediate DO persistence, and broadcasts. Its plain-text body can be an
intent UUID or empty. An optional `clientId` query parameter supplies anonymous
identity. Without it, legacy callers share a client bucket derived from their
IP hash, so changing intent IDs cannot bypass the primary limit. Acceptance
returns HTTP 200; rejection returns HTTP 429 with the structured result and
`Retry-After` when applicable. Existing callers reading `value`/`intentId` keep
working. The frontend sends all intents through WebSockets.

## Persistent state and D1 checkpoints

Durable Object SQLite is the **authoritative source of truth**. Its single
`authoritative_counter` row contains the count, UTC day, budget usage, completed
D1 checkpoint, pending flush time, and checkpoint failure count. Each accepted
press updates one row and awaits `storage.sync()` before acknowledgement or
broadcast. This survives hibernation, all clients disconnecting, eviction, and
Worker redeployment. The existing SQLite-backed class migration and shared
object name remain unchanged.

On first use, the object imports the existing D1 `counter` row. D1 has no historic
click timestamps, so the imported total (capped at 20,000) is conservatively
charged to the rollout day's budget. This avoids granting another daily allowance
on migration; the next UTC day starts with zero usage. Subsequent initialization
always uses DO storage, even when D1 is stale or unavailable. No D1 schema change
or manual provisioning is needed. Once imported, manual D1 updates do not change
the live authoritative count and are unsupported.

A persisted alarm flushes pending state **after five seconds or 100 accepted
increments**, whichever comes first. Threshold flushes advance the existing
alarm instead of writing D1 inside the increment path. Real-time broadcasts
still occur once per accepted press. Quiet tails flush even with no connected
clients or new requests. The
[Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/)
can wake a hibernated/recreated object; delivery may be delayed by the runtime.
There are no DO JavaScript timers or shutdown hooks.

Flushes use an absolute `UPDATE counter SET value = MAX(value, ?) … RETURNING
value` in a `first-primary` D1 session. Re-execution after a crash between D1
success and recording completion cannot duplicate increments or regress D1.
The object then persists checkpoint completion. Failed D1 flushes leave the
acknowledged count intact, increment the diagnostic failure count, and persist
another alarm with backoff from 30 seconds up to one hour. New presses do not
bypass that backoff. Flushes resume when D1 recovers. D1 is useful for queryable,
eventually consistent checkpoints; it can lag the live API.

This bounds normal accepted-click storage work to one DO row per press plus
alarm/checkpoint bookkeeping, with no rate-bucket storage writes. Even the
unbatched quiet case has roughly 60,000 DO row/alarm writes for 20,000 clicks;
bursts require far fewer checkpoint writes. The 100-click test records only two
D1 writes for 110 accepted clicks, including its quiet tail. See Cloudflare's
[storage/request accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/).
The click cap bounds successful mutations; rejected traffic, subscriptions,
checkpoint failures, and other projects still consume shared infrastructure
resources. These controls do not replace authentication or guarantee unlimited
read/subscription traffic within the free allocation.

## Interface and optimistic reconciliation

The default page fills the screen with one formatted number, a large **PUSH**
button, a small **LIVE** indicator, and “counted together.” Each press renders
synchronously before sending. Displayed state is the ordered authoritative value
plus the number of pending local intents, bounded by the largest safe integer.
A matching accepted or rejected result removes that intent's optimistic
contribution in the same render that applies the authoritative value. Remote
increments preserve remaining local optimism. Acceptance and rejection therefore
both reconcile without double-counting.

The button remains responsive while acknowledgements are pending and retains
keyboard focus. An excessive burst shows **Too fast**. Exhausting the budget
shows **Daily limit reached** and disables **PUSH** while keeping **LIVE** reads
and subscriptions. Default UI contains no infrastructure logs. Each changed
displayed value briefly lifts the number and adds a restrained button ring,
including remote updates; unchanged snapshots do not animate. Reduced motion
suppresses effects and cancels active ones when preferences change. Keyboard,
touch, focus rings, and mobile formatting remain supported.

The initial authoritative snapshot must arrive before **LIVE** or enabled
presses. Disconnections trigger bounded exponential backoff with jitter, showing
**Reconnecting…** or **Offline · reconnecting…**. Already-sent intents are never
resent. A snapshot replaces their optimism and shows “Couldn’t confirm that
push” if acknowledgements were lost. Remaining unsent intents can then drain.
An acknowledgement timeout (10 seconds) reconnects the subscription without
replaying mutations. Page reload discards pending page-local state. This makes
uncertainty visible when a click committed but its acknowledgement was lost.

Append `?debug=1` to show a collapsible diagnostic overlay: WebSocket and
synchronization state, reconnect count and delay, anonymous client, API origin,
last authoritative value/time, pending/queued intents, DO persistence confirmation,
D1 checkpoint and failure count, daily usage/reset time, accepted/rejected local
presses, last rejection reason, server retry delay, socket close, and errors.
Optimistic renders do not overwrite the authoritative diagnostic value/time.
Technical diagnostics remain hidden in the normal layout.

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

`npm test` exercises the production class in workerd with real local D1 and
Durable Object SQLite. It covers 15 presses/sec, excessive bursts, ten clients
sharing an IP, rotated IDs, private socket rejections, HTTP compatibility,
concurrent HTTP/socket budget-boundary races, midnight resets, ordered per-click
broadcasts, malformed messages, origin/method checks, initial D1 import, and
recreation with unflushed clicks and an exhausted budget. Test-only subclass
controls provide deterministic time and boundary state; no test routes ship in
the Worker. A D1 trigger counts checkpoint writes, and DO row accounting checks
that rate controls add no per-click persistent writes. Failure/recovery and
repeated flushes check eventual, idempotent convergence. A separate real-alarm
test checkpoints with no readers or connected clients. Provisioning tests use
mocked Cloudflare responses, with no external writes.

The dry run validates the Wrangler configuration/bundle. Applying local migrations
twice verifies migration history and a no-op second application. Browser tests
serve the built site under `/sandbox/` and connect independent browser contexts
to a real local Worker. They cover synchronous eight-press optimism, interleaved
remote updates, burst rejection rollback, daily-limit UI and pushed reset,
uncommitted/committed lost acknowledgements without replay, reconnect snapshot
gating, reload persistence, and eventual D1 agreement. They assert the frontend
makes no HTTP backend reads or mutations and introduces no polling. Keyboard,
focus, touch, responsive layouts, extreme value formatting, local/remote effects,
reduced motion, debug visibility, unconfigured preview, and backend recovery
remain covered. Local tests do not call production. Production lifecycle and
publication checks remain pending below until deployment.

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

These checks require the main-branch deployment and remain pending until it runs.
If importing D1 exhausts the rollout day's budget, verify read/subscription state
immediately and perform press checks after the next UTC reset.

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
   Confirm the document comes from GitHub Pages and the WebSocket handshake and
   increment messages go to the discovered
   `sandbox-persistent-counter.<subdomain>.workers.dev` endpoint. Confirm an
   idle page has no periodic HTTP counter requests in the network panel.
4. Confirm the Cloudflare Worker has `DB` and `COUNTER` bindings, the
   `Counter` class uses the Hibernation API, and the D1 `counter` row
   converges to the API after a checkpoint flush (normally five seconds, with
   runtime alarm delays possible). A read-only SQL query is sufficient:
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
7. Confirm normal rapid presses remain responsive and `?debug=1` shows budget
   usage, UTC reset time, rejection details, and eventual D1 checkpoint completion.
   Verify the 20,000 boundary and automated/IP limits through the local tests; do
   not exhaust the production daily budget for verification. If the production
   budget is reached through normal use, confirm reads stay LIVE and the pushed
   midnight reset re-enables PUSH.
