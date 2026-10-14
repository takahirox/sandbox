"""Publish discovered projects and build a gallery of safe local screenshots."""

import argparse
import hashlib
import html
import json
from pathlib import Path
import shutil
import subprocess
from urllib.parse import quote

SCRIPTS = Path(__file__).resolve().parent


def render_gallery(output: Path, projects: list[Path], captures: dict) -> None:
    cards = []
    for index, project in enumerate(projects):
        name = project.name
        title = html.escape(name.replace("-", " ").replace("_", " ").title())
        cover = hashlib.sha256(name.encode()).hexdigest()[:16] + ".jpg"
        captured = captures.get(name, {}).get("status") == "ok" and (output / "covers" / cover).is_file()
        hidden = ' aria-hidden="true"' if captured else ""
        fallback = (
            f'<span class="fallback"{hidden}>'
            'Screenshot unavailable<small>Open the experiment to explore</small></span>'
        )
        image = (
            f'<img src="./covers/{cover}" width="1280" height="720" '
            f'alt="Screenshot of the {title} web experiment in a local preview." '
            f'loading="{"eager" if index < 2 else "lazy"}" decoding="async">'
            if captured else ""
        )
        cards.append(f"""      <li>
        <a class="card" href="./projects/{quote(name, safe='')}/">
          <div class="cover">{fallback}{image}</div>
          <div class="caption"><h2>{title}</h2><span aria-hidden="true">↗</span></div>
        </a>
      </li>""")
    listing = '<ul class="gallery">\n' + "\n".join(cards) + "\n    </ul>" if cards else '<p class="empty">No projects yet. A little curiosity is on its way.</p>'
    template = (SCRIPTS / "gallery.html").read_text(encoding="utf-8")
    (output / "index.html").write_text(template.replace("{{gallery}}", listing), encoding="utf-8")
    for asset in ["gallery.css", "gallery.js"]:
        shutil.copyfile(SCRIPTS / asset, output / asset)


def build_site(root: Path, *, screenshots: bool = True) -> Path:
    projects_dir = root / "projects"
    if projects_dir.is_symlink():
        raise ValueError(f"Symbolic links are not supported: {projects_dir}")
    projects = (
        sorted(
            project
            for project in projects_dir.iterdir()
            if project.is_dir() and (project / "index.html").is_file()
        )
        if projects_dir.exists() else []
    )

    # Do not follow links that could publish files outside a project.
    for project in projects:
        for path in [project, *project.rglob("*")]:
            if path.is_symlink():
                raise ValueError(f"Symbolic links are not supported: {path}")

    output = root / "_site"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir()

    for project in projects:
        shutil.copytree(project, output / "projects" / project.name)

    # Write a usable gallery even when capture tooling fails. Missing tooling is
    # still a build error; individual project failures are reported as fallbacks.
    render_gallery(output, projects, {})
    if screenshots and projects:
        try:
            subprocess.run(
                ["node", str(SCRIPTS / "capture_screenshots.mjs"), str(output)],
                input=json.dumps([project.name for project in projects]),
                text=True, check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise RuntimeError(
                "Screenshot tooling failed. Run npm ci --prefix workers/persistent-counter "
                "and install Chromium with that package's Playwright. "
                "Use --skip-screenshots for a static-only preview."
            ) from error
        captures = json.loads((output / "capture-report.json").read_text(encoding="utf-8"))
        render_gallery(output, projects, captures)
    (output / ".nojekyll").touch()
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-screenshots", action="store_true", help="Build a static preview with visible cover placeholders")
    args = parser.parse_args()
    output = build_site(SCRIPTS.parent, screenshots=not args.skip_screenshots)
    print(f"Built playground in {output}")
