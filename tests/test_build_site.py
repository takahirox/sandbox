from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from urllib.request import urlopen

from scripts.build_site import build_site


class ProjectLinks(HTMLParser):
    def __init__(self, document):
        super().__init__()
        self.links = []
        self.feed(document)

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.links.append(dict(attrs)["href"])


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class BuildSiteTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)

    def add_project(self, name):
        project = self.root / "projects" / name
        project.mkdir(parents=True)
        (project / "index.html").write_text(f"<h1>{name}</h1>", encoding="utf-8")
        return project

    def links(self, output):
        return ProjectLinks((output / "index.html").read_text(encoding="utf-8")).links

    def test_new_project_is_listed_without_registration_and_preserves_existing(self):
        self.add_project("first")
        build_site(self.root)
        second = self.add_project("second")
        (second / "assets").mkdir()
        (second / "assets" / "image.bin").write_bytes(b"\x00\xff")
        output = build_site(self.root)
        self.assertEqual(self.links(output), ["./projects/first/", "./projects/second/"])
        self.assertEqual((output / "projects/first/index.html").read_text(), "<h1>first</h1>")
        self.assertEqual((output / "projects/second/assets/image.bin").read_bytes(), b"\x00\xff")

    def test_unpublishable_directories_and_repository_files_are_excluded(self):
        (self.root / "projects/draft/nested").mkdir(parents=True)
        (self.root / "projects/draft/nested/index.html").write_text("nested")
        (self.root / "README.md").write_text("repository documentation")
        self.add_project("ready")
        output = build_site(self.root)
        self.assertEqual(self.links(output), ["./projects/ready/"])
        self.assertFalse((output / "projects/draft").exists())
        self.assertFalse((output / "README.md").exists())

    def test_deleted_project_and_assets_are_removed_on_rebuild(self):
        project = self.add_project("temporary")
        (project / "old.js").write_text("old asset")
        build_site(self.root)
        (project / "old.js").unlink()
        output = build_site(self.root)
        self.assertFalse((output / "projects/temporary/old.js").exists())
        shutil.rmtree(project)
        output = build_site(self.root)
        self.assertEqual(self.links(output), [])
        self.assertFalse((output / "projects/temporary").exists())

    def test_empty_repository_has_a_valid_home_page(self):
        output = build_site(self.root)
        self.assertEqual(self.links(output), [])
        self.assertIn("No projects yet.", (output / "index.html").read_text())

    def test_names_are_html_escaped_and_urls_are_encoded(self):
        self.add_project('a & "<demo>" #日本語')
        output = build_site(self.root)
        document = (output / "index.html").read_text(encoding="utf-8")
        self.assertIn("a &amp; &quot;&lt;demo&gt;&quot; #日本語", document)
        self.assertEqual(self.links(output), [
            "./projects/a%20%26%20%22%3Cdemo%3E%22%20%23%E6%97%A5%E6%9C%AC%E8%AA%9E/"
        ])

    def test_symbolic_links_cannot_publish_outside_files(self):
        project = self.add_project("linked")
        outside = self.root / "private.txt"
        outside.write_text("not a project asset")
        (project / "asset.txt").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Symbolic links"):
            build_site(self.root)

    def test_projects_directory_cannot_link_outside_the_repository(self):
        outside = self.root / "outside"
        (outside / "project").mkdir(parents=True)
        (outside / "project/index.html").write_text("outside project")
        (self.root / "projects").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symbolic links"):
            build_site(self.root)

    def test_generated_links_and_assets_work_under_repository_base_path(self):
        project = self.add_project("hello-world")
        (project / "style.css").write_text("body { color: blue; }")
        output = build_site(self.root)
        public = self.root / "public"
        shutil.copytree(output, public / "sandbox")
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(public))
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}/sandbox/"
            with urlopen(base, timeout=5) as response:
                links = ProjectLinks(response.read().decode()).links
            self.assertEqual(links, ["./projects/hello-world/"])
            with urlopen(base + links[0], timeout=5) as response:
                self.assertIn(b"<h1>hello-world</h1>", response.read())
            with urlopen(base + links[0] + "style.css", timeout=5) as response:
                self.assertEqual(response.read(), b"body { color: blue; }")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
