# sandbox

A lightweight playground for independent web experiments, published at
<https://takahirox.github.io/sandbox/>. The home page discovers projects
automatically; there is no project registry to maintain.

## Add a project

1. Create `projects/<project-name>/index.html`. Prefer a lowercase name with
   hyphens, such as `happy-cat`, for a readable, stable URL.
2. Put any CSS, JavaScript, images, and other static assets in that directory.
   Use relative asset links (for example, `./style.css`), since the site lives
   under `/sandbox/` rather than the domain root.
3. Commit the files and merge them to `main` through the development flow below.

Every immediate directory under `projects/` with an `index.html` file is listed
on the home page and published at
`https://takahirox.github.io/sandbox/projects/<project-name>/`. The directory
name supplies a readable card title; no metadata, framework, package manifest, or
per-project deployment configuration is required. Renaming the directory changes
the URL. Directories without an entry point are not published.

See [Happy cat](projects/happy-cat/index.html) for a standalone static example.
The [Persistent Counter](docs/persistent-counter.md) adds a small Cloudflare
Worker, Durable Object, WebSocket, and D1 backend while keeping its frontend in
this static project layout.
The [online rock-paper-scissors game](docs/rock-paper-scissors.md) uses the same
Worker deployment with a separate Durable Object for five public rooms,
anonymous players, and live spectators.
All files within a discovered project are public, so keep source-only or private
files outside it. Use ordinary files and directories; symbolic links are rejected
by the build. Projects that need build tools can generate static files into this
same layout before the site build; automatic per-project builds are not included.

## Build and preview locally

Use Python 3.9 or newer and Node.js 22 or newer. Screenshot capture reuses the
existing pinned Playwright dependency. From the repository root:

```sh
npm ci --prefix workers/persistent-counter
# On Linux/CI, add --with-deps to install Chromium's system dependencies too.
npm exec --prefix workers/persistent-counter -- playwright install chromium
python3 -m unittest discover -s tests -v
node --test tests/pokemon-coin-flip.test.cjs tests/gallery.test.mjs
python3 scripts/build_site.py
python3 -m http.server 8000 --directory _site
```

Open <http://localhost:8000/> and follow the project links. The build recreates
`_site/` from all current projects, preserving their assets and generating the
home page and real 1280×720 JPEG covers under `_site/covers/`. Every discovered
project is captured automatically, including newly added directories. Covers
use a fixed viewport, locale, timezone, date, random seed, reduced motion, and a
short settling period; animations are disabled for capture. No project registry
or uploaded images are needed. Generated output is ignored by Git and never
written into project source folders. Stop the server with Ctrl-C.

Capture runs in fresh browser contexts against a temporary, read-only loopback
server at `/sandbox/`. Only GETs within the current local project are allowed;
external traffic, other methods, WebSockets, and service workers are blocked.
`api-config.json` is replaced **in the capture browser only** with an empty API
URL. Persistent Counter and online rock-paper-scissors therefore show their
actual unavailable/offline UI, with no simulated live counts or players. No
production credentials or backend runtime are needed, and deployed project
files retain their original API configuration. Remote fonts, images, scripts,
and other required external assets cause a visible unavailable cover rather
than a misleading partial screenshot; keep preview assets local.

Each project has a 12-second capture limit. Failed captures leave a clickable
card labeled “Screenshot unavailable,” log a bounded reason, and record the
project's status in `_site/capture-report.json`. The build continues for other
projects; missing Playwright/Chromium or broken tooling fails the build with
setup guidance. Missing covers in an already published gallery also get a
visible fallback. The homepage loads only covers and a small image-error
handler, never the project apps. Use
`python3 scripts/build_site.py --skip-screenshots` for a Python-only preview
with explicit cover placeholders.

## GitHub Pages deployment

The [Pages workflow](.github/workflows/pages.yml) tests and builds on pull
requests, and automatically publishes `_site/` on every push to `main` (including
merges). It can also be run manually from the Actions tab on `main`. Each build
includes all discovered projects, so adding one preserves the existing projects.
Pull requests only validate the build; deployment runs on `main`.
The workflow also tests the Persistent Counter and rock-paper-scissors backends,
browser integrations, and screenshot safety and responsive gallery behavior.
On `main`, it provisions D1, applies migrations, and deploys the Worker and
Durable Object configuration before building the Pages artifact with its public
API URL. The final build captures local screenshots on both pull requests and
deployments, after any production API configuration has been generated, without
contacting that API. See the
[counter deployment and local checks](docs/persistent-counter.md) for Node.js
prerequisites, token permissions, and required post-merge verification.

One-time repository setup: in **Settings → Pages → Build and deployment**, select
**GitHub Actions** as the source. Ensure GitHub Actions is enabled and any
`github-pages` environment protection rules allow deployment from `main`.
See [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
After merging, check the **Deploy playground to Pages** workflow in the Actions
tab and visit the site and follow its project links to verify publication.
No repository setting or workflow edit is needed when adding subsequent projects.

## Development

For AI-assisted development and review, see the [development flow](docs/development-flow.md) and [review guidelines](docs/review-guidelines.md).
