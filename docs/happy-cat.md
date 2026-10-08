# Happy cat demo

Issue: <https://github.com/takahirox/sandbox/issues/6>
Speech feedback: <https://github.com/takahirox/sandbox/issues/22>

`projects/happy-cat/index.html` is a standalone HTML/CSS/JavaScript demo.
The cat starts with a calm expression. Click or tap its image to show the same
cat with smiling eyes, a smile, and rosy cheeks. Activate it again to switch
back. The image is inside a native button, so Tab followed by Enter or Space
also works. The image description and live status reflect the current mood.

Switching to happy also says `がんばったにゃー` through the browser's Web Speech
API, directly from the activation. It requests Japanese (`ja-JP`), prefers an
available Japanese voice, and uses a slightly higher pitch. Voices and their
sound depend on the browser and OS; if no Japanese voice is listed, the browser
chooses a voice for the requested language. Nothing speaks on page load.
Returning to normal cancels speech, and each happy activation cancels older
speech before starting, so rapid taps do not build up a queue. The image toggle
still works when speech is unsupported or fails.

`playHappyCatAudio(happy)` contains both playback and cancellation. Replace that
helper to use a future local audio file without changing the toggle interaction.
No voice file or external service is used.

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
and switching back on a second activation. Verify the Japanese line only plays
when becoming happy, rapid activations stop obsolete speech, and the toggle works
without speech support. Check keyboard activation and a narrow mobile viewport
as well.
