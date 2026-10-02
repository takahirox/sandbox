# Happy cat demo

Issue: <https://github.com/takahirox/sandbox/issues/6>

`projects/happy-cat/index.html` is a standalone HTML/CSS/JavaScript demo.
The cat starts with a calm expression. Click or tap its image to show the same
cat with smiling eyes, a smile, and rosy cheeks. Activate it again to switch
back. The image is inside a native button, so Tab followed by Enter or Space
also works. The image description and live status reflect the current mood.

Both SVG illustrations (`cat-normal.svg` and `cat-happy.svg`) were created
specifically for this project using SVG shapes. They are original local assets,
not web-sourced images; no external asset services or attribution are required.
The demo has no dependencies or backend and can be opened directly from disk.

To preview the deployment output, follow the build and preview commands in the
repository README and open `/projects/happy-cat/`. The existing build discovers
the project and includes both images automatically. After merge and deployment,
the project will be listed on the sandbox home page and available at
<https://takahirox.github.io/sandbox/projects/happy-cat/>.

Verify the calm image on initial load, the happier image after a click or tap,
and switching back on a second activation. Check keyboard activation and a
narrow mobile viewport as well.
