# P2P Pong

`projects/p2p-pong/` is an account-free, two-player, first-to-five Pong
experiment. Create a match, share its private invitation URL, and have the other
player press **Join match**. The creator controls the left paddle and hosts the
simulation. Focus the court for arrow/W/S controls, drag on touch screens, or use
the large up/down buttons. Leaving or losing the host ends the match. Retry by
creating a new match and sharing its fresh link; invitations cannot be reused.

The court and score stay visible throughout. The landing screen offers **Create
match**; invitation links offer **Join match**. Hosts get **Copy invitation link**
while waiting, with the raw link and five-minute expiry in a collapsed disclosure
(automatically opened and selected if clipboard access fails). Setup actions and
disclosures disappear during play, leaving the score, court, compact controls,
and a quiet leave action. Results offer **Play again**, which creates a fresh
invitation. Keyboard focus follows actions as they are replaced, and score/status
updates are announced without repeating every animation frame.

The **Before you play** disclosure is available before creating or joining and
explains network-information exposure and connection limitations. Normal status
messages are brief; technical troubleshooting stays in the opt-in diagnostics.
The static offline preview uses the same court without creating a live match.

Only share with someone you trust. Direct WebRTC reveals network information
(potentially public/local addresses) to the other participant. STUN-only
connections can fail across strict NATs, firewalls, VPNs, and mobile networks.
There is deliberately **no TURN**, paid relay credential, or relay fallback:
this experiment measures direct connectivity without relay bandwidth charges.
The peer host can cheat; this is a sandbox demonstration, not a competitive or
cheat-proof service.

## Transport and synchronization

The existing Cloudflare Worker adds `/api/pong/ws`, routed to an independent
SQLite-backed `PongSignaling` Durable Object. The browser connects only after an
explicit Create/Join action. WebSockets exchange create/join, SDP offer/answer,
ICE candidates, and readiness messages. They accept no gameplay message types.
After both DataChannels open, the lobby deletes the invitation/session, sends
`released`, and closes both signaling sockets. Gameplay continues with no
Cloudflare connection, HTTP polling, or server forwarding of inputs/state.

`RTCPeerConnection` uses only `stun:stun.cloudflare.com:3478`. Both channels must
open before the UI reports connected; selected relay candidates are rejected
defensively. Negotiation times out after 35 seconds. A failed connection, a
five-second disconnected ICE/connection state, a closed DataChannel, or 15
seconds without a peer heartbeat ends play with a retry action. Background tab
suspension can therefore end a match; keep both game tabs active.

The creator runs fixed-step physics at 120 Hz. Both clients send paddle targets
at up to 30 Hz on `motion` (`ordered: false, maxRetransmits: 0`); the creator
also sends small authoritative snapshots there at up to 30 Hz. The host clamps
movement speed and owns collisions, scoring, and victory. The opponent predicts
its own paddle immediately and interpolates the host's paddle/ball. The ordered,
reliable `events` channel carries start, score, end, and two-second heartbeat
messages. Score revisions and monotonic ticks prevent late/lost/reordered motion
snapshots from reverting reliable score/end events. Queues and message sizes are
bounded; old motion is skipped under congestion.

Add `?debug=1` before the invitation fragment to opt into ICE/connection states,
DataChannel readiness, and application round-trip time. Debug text never includes
raw SDP, candidate addresses, invitation capabilities, or credentials. There is
no application logging of these values.

## Signaling limits and privacy

- Each invitation uses a random 128-bit session ID and separate random 256-bit
  one-use join capability. The capability lives in the URL fragment, is removed
  on page load, and is sent in the first WebSocket message rather than the URL.
  A no-referrer policy also prevents link leakage. Nothing is put in browser
  persistent storage. Possession of a link authorizes its first joining browser;
  keep it private. A third browser cannot acquire or replace either seat.
- Only the configured frontend Origin may upgrade. Methods, upgrades, exact
  message fields, sender roles, SDP sizes, and ICE fields are validated. Game
  payloads, duplicate SDP, malformed, binary, and oversized messages are rejected.
- The lobby allows 24 pending sessions, 64 signaling sockets, and 3,000 accepted
  connections per UTC day. The daily counter persists across runtime restarts.
  Soft per-IP buckets allow 20 connection attempts, refilling at one per three
  seconds, and 200 signaling messages, refilling at 10/second. Each socket has
  an absolute 160-message limit and 20,000-character message limit. A shared IP
  may hit limits even with legitimate users.
- Unauthenticated sockets expire after 10 seconds, waiting invitations after
  five minutes, and paired negotiations after 60 seconds. Storage alarms clean
  up without requiring incoming traffic. Either peer leaving signaling removes
  the pending match. Successful connections release all session state. Only the
  bounded daily counter remains; no match history or gameplay is stored.

These are application resource controls, not protection against arbitrary edge
request floods. Rejected HTTP requests still consume Workers request quota, and
the other projects share account quotas. When capacity/quotas are exhausted,
the game reports signaling unavailable instead of purchasing allowance.

## Build and deployment

The existing main-branch Actions deployment reuses `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, writes Pong's public `api-config.json` alongside the other
projects, and deploys the additive `v4` SQLite Durable Object migration. No new
secret, D1 schema, paid Cloudflare service, or provider is required. SQLite
Durable Objects are available on Workers Free; this implementation uses that
supported configuration and hibernating WebSockets. Quotas are shared and zero
cost depends on remaining within the Free plan, not on a guarantee of unlimited
traffic. See Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and
[public STUN documentation](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/).

As checked in, `api-config.json` has an empty endpoint for a harmless static
preview. No WebSocket or WebRTC peer is created on load. The gallery's existing
capture sandbox replaces even a generated production endpoint with an empty
one and blocks external traffic/WebSockets. Pong automatically appears in the
gallery and gets a real local offline-preview cover.

For live local play, install tools as described in the repository README, run
`npm run dev --prefix workers/persistent-counter`, and temporarily set Pong's
`api-config.json` to `{"apiUrl":"http://localhost:8787"}`. Build the site and serve
`_site` on `http://localhost:8000` (the dev Worker's allowed Origin). Open
`http://localhost:8000/projects/p2p-pong/` in two browsers and share the invite.
Restore the empty source config before committing. WebRTC requires HTTPS or
localhost; two physical devices need an HTTPS-served frontend and an allowed
Origin/backend reachable from both devices.

## Validation

Pre-merge checks:

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
npm test --prefix workers/persistent-counter
npm run build --prefix workers/persistent-counter
npm run migrate:local --prefix workers/persistent-counter
python3 -m unittest discover -s tests -v
node --test tests/pokemon-coin-flip.test.cjs
python3 scripts/build_site.py --skip-screenshots
npm run test:browser --prefix workers/persistent-counter
node --test tests/gallery.test.mjs tests/walk-to-hospital.test.mjs
python3 scripts/build_site.py
```

Pong's Miniflare tests cover authorization, two seats, private capabilities,
role-checked signaling, no game relay, expiry/cleanup, durable budgets, and
rate/size limits. Rules tests cover collision, movement, score, victory, and stale
state rejection. Browser tests run real WebRTC between isolated Chromium browser
contexts against a local Cloudflare runtime: direct non-relay candidate pairs,
closed signaling during live play, touch/keyboard, a complete first-to-five match,
consistent outcomes, host loss, invitation reuse denial, timeout/retry, safe
diagnostics, and a static preview. Gallery tests exercise production-configured
preview capture with a network trap and preserve the published API config.
An additional native-browser test waits for an actual storage alarm to close an
unused signaling socket without incoming traffic.

Issue #40 adds browser coverage for the contextual landing/invitation/play/result
actions, hidden setup details during play, clipboard copy and manual fallback,
cancel/expiry/retry, fresh invitations after a result, keyboard focus and privacy
disclosure access, touch target sizes, 320/390/1280-pixel layouts, and reduced
motion. The real first-to-five integration continues to exercise actual physics
and DataChannels rather than a simulated connection.

UI refinement validation on 2026-10-18 passed all 50 backend/rules tests, 24 browser
integration tests, 11 Python build tests, five coin-flip tests, and six
gallery/walking tests. Worker dry-run and both local migration runs passed. The
normal build captured all seven projects; Pong reported zero blocked requests
and zero attempted WebSockets. Desktop waiting and 320-pixel live-play screens
were also inspected using a local signaling runtime. No shared Worker code,
production config, transport settings, or game rules changed. Physical-device,
cross-network, and post-merge deployment checks remain pending as described
below.

Implementation validation on 2026-10-18 used Node.js 24.12.0, the pinned
Playwright 1.63.0 Chromium, and the local workerd/Miniflare runtime. Two isolated
browser contexts selected direct `host` candidate routes (no relay), played a
complete first-to-five match with matching outcomes, and kept playing after
both signaling sockets closed. All 50 backend tests, 23 browser integration
tests, 11 Python build tests, five coin-flip tests, and six gallery/walking
browser tests passed. Wrangler's Worker dry-run and idempotent local D1
migrations passed. The normal screenshot build captured all seven projects;
Pong's capture reported zero blocked requests and zero attempted WebSockets.

The available automated environment tests two browser contexts on the same host,
not two physical devices on distinct networks. Same-LAN two-device and
separate-network/mobile NAT outcomes remain unverified because a second device
and independently routed network are unavailable here. For each feasible manual
check, record the date, browser versions, network types (without IPs), direct
connect success/failure, diagnostic RTT, and whether a complete game agrees on
both screens. An honest connection-failed result on a restrictive network is
expected; never add a TURN fallback to make this test pass.

Required post-merge verification (pending): check the main-branch Actions Worker
and Pages deployment, confirm the account remains on Free with the new SQLite
binding, open Pong from the public gallery, complete a direct game across
available devices/networks, and verify Counter, Bingo, and rock-paper-scissors
still operate. The implementation node does not deploy, push, open a PR, merge,
or claim these production checks passed.
