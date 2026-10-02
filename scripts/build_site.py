"""Publish static projects and generate their index without third-party tools."""

import html
from pathlib import Path
import shutil
from urllib.parse import quote


def build_site(root: Path) -> Path:
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

    links = "\n".join(
        f'      <li><a href="./projects/{quote(project.name, safe="")}/">'
        f"{html.escape(project.name)}</a></li>"
        for project in projects
    )
    listing = f"<ul>\n{links}\n    </ul>" if projects else "<p>No projects yet.</p>"
    (output / "index.html").write_text(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sandbox playground</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }}
    li {{ margin: .5rem 0; }}
  </style>
</head>
<body>
  <main>
    <h1>Sandbox playground</h1>
    <p>Independent web experiments. Choose a project to explore.</p>
    {listing}
  </main>
</body>
</html>
""",
        encoding="utf-8",
    )
    (output / ".nojekyll").touch()
    return output


if __name__ == "__main__":
    output = build_site(Path(__file__).resolve().parents[1])
    print(f"Built playground in {output}")
