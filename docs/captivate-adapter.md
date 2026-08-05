# Captivate adapter contract

## Why the MVP does not write `.cptx` directly

An editable Captivate project is not equivalent to a ZIP of images or a renamed archive.
Captivate's project format and authoring internals are proprietary and version-sensitive.
Writing those internals directly would be fragile and could create files that appear to
work until reopened or published.

The safe implementation boundary is a Windows authoring adapter that uses an installed,
explicitly supported Captivate version to build a project from a neutral migration job.

## Supported authoring baseline

The first adapter is pinned to Adobe Captivate Classic builds `11.8.3.8` and
`11.8.4.21`. Detection must verify all of the following before an automation run:

- the Classic product, not the newer CPT-based Captivate application;
- an exact supported four-component file or product version;
- a valid Adobe Authenticode signature; and
- an absolute regular-file path to the executable.

A supported installation means the machine is eligible for adapter testing. It does
not mean native CPTX export is ready, so the product option remains disabled until the
create/save/reopen/publish acceptance sequence passes.

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

Live inspection of Captivate Classic `11.8.4.21` established these initial constraints:

- standard UI Automation exposes the top-level window but not its useful descendants;
- the legacy MSAA accessibility tree exposes stable menu items and named workspace tabs;
- menus and dialogs are transient and must be reacquired after they open;
- window handles are ephemeral and coordinate selectors are not acceptable;
- launching the verified executable with one absolute CPTX argument opens that project;
- Captivate may leave a zero-byte hidden `.cpl` marker after a clean exit, so marker
  existence alone is not proof that a project is still locked.

The first implemented smoke layer copies a fixture byte-for-byte into a unique disposable
directory, compares SHA-256 before launching, invokes the exact executable without a
shell, and requires explicit proof that Captivate released the disposable project before
cleanup. A remaining `.cpl` marker requires a separate stale/unlocked confirmation. The
canonical fixture and all user projects stay read-only. A live `11.8.4.21` smoke test has
confirmed launch, document open, responsive-window, lock-marker, and clean-exit evidence.

Save As and native object creation remain separate interactive milestones. They must use
MSAA menu/dialog selectors and verify the resulting project by closing and reopening it.

Direct binary `.cptx` mutation is outside this contract.
