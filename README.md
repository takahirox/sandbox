# sandbox

A lightweight repository for quickly turning small ideas into web-accessible experiments.

The repository is intended to host many independent sandbox projects rather than one application. Each project should live in its own directory and, once merged to `main`, be published automatically with GitHub Pages.

## Direction

The target workflow is:

1. Create a new directory for an experiment under `projects/`.
2. Add the experiment files.
3. Open a Pull Request following the repository's development flow.
4. Merge to `main`.
5. GitHub Pages deploys the repository automatically.
6. The sandbox top page discovers the new project automatically and links to it.

The intended site layout is:

- Sandbox index: `https://takahirox.github.io/sandbox/`
- Project: `https://takahirox.github.io/sandbox/projects/<project-name>/`

Adding a project should not require manually registering its link on the top page or adding project-specific deployment configuration.

A minimal project should be able to consist of only a directory with a publishable entry point such as `index.html`. Optional metadata such as a title or description may be supported, but should not be required for basic publication.

## Planned structure

```text
sandbox/
├── projects/
│   ├── example-a/
│   │   └── index.html
│   └── example-b/
│       └── index.html
├── scripts/
│   └── ...
└── ...
```

The initial implementation is tracked in [Issue #3](https://github.com/takahirox/sandbox/issues/3).

## Development

For AI-assisted development and review, see the [development flow](docs/development-flow.md) and [review guidelines](docs/review-guidelines.md).
