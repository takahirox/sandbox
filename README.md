# sandbox

A lightweight playground for independent web experiments, published at
<https://takahirox.github.io/sandbox/>. The home page discovers projects
automatically; there is no project registry to maintain.

## Add a project

1. Create `projects/<project-name>/index.html`. Prefer a lowercase name with
   hyphens, such as `hello-world`, for a readable, stable URL.
2. Put any CSS, JavaScript, images, and other static assets in that directory.
   Use relative asset links (for example, `./style.css`), since the site lives
   under `/sandbox/` rather than the domain root.
3. Commit the files and merge them to `main` through the development flow below.

Every immediate directory under `projects/` with an `index.html` file is listed
on the home page and published at
`https://takahirox.github.io/sandbox/projects/<project-name>/`. The directory
name supplies the link title; no metadata, framework, package manifest, or
per-project deployment configuration is required. Renaming the directory changes
the URL. Directories without an entry point are not published.

See [hello-world](projects/hello-world/index.html) for a minimal example.
All files within a discovered project are public, so keep source-only or private
files outside it. Use ordinary files and directories; symbolic links are rejected
by the build. Projects that need build tools can generate static files into this
same layout before the site build; automatic per-project builds are not included.

## Build and preview locally

Python 3.9 or newer is the only local prerequisite; there are no dependencies to
install. From the repository root:

```sh
python3 -m unittest discover -s tests -v
python3 scripts/build_site.py
python3 -m http.server 8000 --directory _site
```

Open <http://localhost:8000/> and follow the project links. The build recreates
`_site/` from all current projects, preserving their assets and generating the
home page. Generated output is ignored by Git. Stop the server with Ctrl-C.

## GitHub Pages deployment

The [Pages workflow](.github/workflows/pages.yml) tests and builds on pull
requests, and automatically publishes `_site/` on every push to `main` (including
merges). It can also be run manually from the Actions tab on `main`. Each build
includes all discovered projects, so adding one preserves the existing projects.
Pull requests only validate the build; deployment runs on `main`.

One-time repository setup: in **Settings → Pages → Build and deployment**, select
**GitHub Actions** as the source. Ensure GitHub Actions is enabled and any
`github-pages` environment protection rules allow deployment from `main`.
See [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
After merging, check the **Deploy playground to Pages** workflow in the Actions
tab and visit the site and `/sandbox/projects/hello-world/` to verify publication.
No repository setting or workflow edit is needed when adding subsequent projects.

## Development

For AI-assisted development and review, see the [development flow](docs/development-flow.md) and [review guidelines](docs/review-guidelines.md).
