# Captivate adapter contract

## Why the MVP does not write `.cptx` directly

An editable Captivate project is not equivalent to a ZIP of images or a renamed archive.
Captivate's project format and authoring internals are proprietary and version-sensitive.
Writing those internals directly would be fragile and could create files that appear to
work until reopened or published.

The safe implementation boundary is a Windows authoring adapter that uses an installed,
explicitly supported Captivate version to build a project from a neutral migration job.

## Adapter input

Each migration bundle contains a `captivate-job.json` with:

- target stage dimensions and course metadata;
- ordered slides and stable proposed object names;
- text, geometry, z-order, styles, and media references;
- native interaction and question requirements;
- answer keys, scoring, attempts, and feedback;
- navigation and accessibility data where recoverable;
- confidence and unsupported-feature diagnostics.

## Required adapter behavior

The adapter must:

1. Verify the exact Captivate product/version and a version-pinned starter project.
2. Create real slides and native editable text, shapes, media, controls, and quiz objects.
3. Use stable object names so a failed run can be diagnosed and safely retried.
4. Preserve source geometry while applying documented coordinate conversions.
5. Save to a new `.cptx`; never overwrite a user's existing project.
6. Close and reopen the generated project.
7. Verify slide/object counts and key quiz settings after reopening.
8. Publish an HTML5 review build and capture failures in a machine-readable report.

## Unsupported mappings

An adapter should stop or create an explicit placeholder when a source interaction has
no reliable native equivalent. It must not flatten a whole slide to a screenshot merely
to claim success. A screenshot may be included as a visual reference, while editable
text and individual assets remain separate.

## Potential automation strategies

The first adapter is expected to use constrained Windows UI automation because
Captivate does not expose a general public project-authoring API. It should run in a
dedicated user session with deterministic display scaling and a documented Captivate
workspace. Every UI action should be paired with a state assertion and timeout.

Direct binary `.cptx` mutation is outside this contract.
