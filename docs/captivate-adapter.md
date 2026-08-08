# Captivate adapter contract

## Why the app does not write `.cptx` directly

An editable Captivate project is not equivalent to a ZIP of images or a renamed archive.
Captivate's project format and authoring internals are proprietary and version-sensitive.
Writing those internals directly would be fragile and could create files that appear to
work until reopened or published.

The safe implementation boundary is a Windows authoring adapter that uses an installed,
explicitly supported Captivate version to build a project from a neutral migration job.

## Supported authoring baseline

Installation detection recognizes Adobe Captivate Classic builds `11.8.3.8` and
`11.8.4.21`, but the first implemented authoring adapter is qualified only for exact
build `11.8.4.21`. Detection must verify all of the following before an automation run:

- the Classic product, not the newer CPT-based Captivate application;
- an exact supported four-component file or product version;
- a valid Adobe Authenticode signature; and
- an absolute regular-file path to the executable.

A supported installation means the machine is eligible for adapter testing. It does
not mean native CPTX export is ready. Readiness additionally requires the packaged
driver and the exact SHA-256-qualified one-slide starter project. A changed seed or a
different build leaves the product option disabled.

The current `classic-11.8.4.21-primary150-unaware-1280x696-v3` profile creates one native
slide for each recovered source slide, editable title text on every slide, and a first-slide subtitle.
Images, interactions, detailed layout/styling, and remaining text stay in the migration
bundle as explicit manual-review work.

This is a developer-local beta. The repository does not redistribute the qualified seed,
so a fresh public installation remains disabled until a public seed-qualification workflow
exists. The live profile requires a DPI-unaware 96-DPI logical coordinate space on a 150%
primary display and an exact `0,0,1280,696` Captivate authoring window.

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

The mature adapter contract must eventually:

1. Verify the exact Captivate product/version and a version-pinned starter project.
2. Create real slides and native editable text, shapes, media, controls, and quiz objects.
3. Use stable object names so a failed run can be diagnosed and safely retried.
4. Preserve source geometry while applying documented coordinate conversions.
5. Save to a new `.cptx`; never overwrite a user's existing project.
6. Close and reopen the generated project.
7. Verify slide/object counts and key quiz settings after reopening.
8. Publish an HTML5 review build and capture failures in a machine-readable report.

The initial profile implements steps 1, 3, 5, 6, and native slide/title portions of
steps 2 and 7. It exports and hashes Captivate XML after reopening to verify native
marker titles. It does not yet claim media, controls, quizzes, or publish verification.

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

Live inspection of Captivate Classic `11.8.4.21` established these constraints:

- standard UI Automation exposes the top-level window but not its useful descendants;
- native Win32 menu popups expose stable positions and labels, while their leaf command
  IDs can change between launches and therefore cannot be used as identity;
- menus and dialogs are transient and must be reacquired and revalidated after they open;
- window handles are ephemeral; every fixed physical cursor point must hit-test against
  the expected exact window, in addition to asserted authoring/popup geometry;
- launching the verified executable with one absolute CPTX argument opens that project;
- Captivate may leave a zero-byte hidden `.cpl` marker after a clean exit, so marker
  existence alone is not proof that a project is still locked.

The implemented adapter copies the qualified seed byte-for-byte into a unique disposable
directory, compares SHA-256 before launching, verifies the packaged driver's SHA-256,
invokes the exact executable through Windows ShellExecute with one absolute CPTX argument,
and requires a clean Captivate exit plus exclusive access to the disposable project before
cleanup. Any `.cpl` marker remains confined to that disposable directory and is removed
with it only after those proofs. The canonical fixture and all user projects stay read-only.

The driver uses exact native Win32 popup profiles for File and Export, validates their
stable row positions, labels, enabled state, and submenu structure, then selects the
qualified To XML row by its asserted coordinates. It intentionally does not dispatch
Captivate's dynamic menu command IDs. Standard Win32 control IDs and descendant classes
qualify the XML Save As dialog. Exact geometry is used only where Captivate's Drover or
menu controls expose no dependable semantic action. The driver handles the known Adobe
trial reminder only after verifying its process path, class, title, visibility, and
launch phase, and it never sends automated input to Adobe licensing UI. It types real
keystrokes into the qualified file-name control, saves to a new path, closes normally,
reopens the result, exports XML, verifies slide markers, and returns an NDJSON
attestation. Stage failures may request a bounded normal close only when the project is
clean and no licensing UI is active; the driver never force-terminates Captivate.
Cross-process window and menu messages are bounded with timeouts. MSAA evidence and string
collection run only in a short-lived private invocation of the same hash-pinned driver; the
parent PowerShell process terminates only that helper if a query exceeds its per-operation
deadline. Before launching the first helper, the already-running driver joins a private Windows
Job Object configured with `KILL_ON_JOB_CLOSE`; helpers inherit that job atomically, while the
already-running Captivate process never joins it. Killing or losing the parent therefore cannot
orphan a helper. Each child is invoked directly through `powershell.exe -File` with Windows-native
argument quoting and a conservative 30,000-character command-line ceiling; stdout must contain one
JSON response and stderr must remain empty. The parent pins its startup script hash, rechecks the file before each invocation,
and requires the child to verify that same hash before loading MSAA. The final helper operation
revalidates the exact Save As dialog, filename Edit,
accessibility name/value/role/state, absent target, and Save button before bounded `BM_CLICK`.
The saved CPTX hash must remain identical before reopen, after XML verification, immediately
before promotion, and after promotion. The TypeScript caller then publishes the CPTX through
an atomic no-replace hard link so a file created during the long authoring run cannot be
overwritten.

An outer four-hour watchdog is deliberately broad enough for the supported 200-slide ceiling.
Electron directs it only at the spawned PowerShell driver; the helper-only job closes with that
driver and Captivate remains outside the job. On timeout, staging is retained and Electron's quit
guard uses read-only process polling until Captivate closes. If a
bounded accessibility helper cannot be confirmed terminated, its exact PID is also attested and
polled read-only before the quit guard is released.

Native Captivate exports are serialized before adapter preflight. A synchronous in-process
reservation rejects a second request before either request can launch another driver, and Windows
also binds a machine-wide named-pipe lease so a cooperating CLI, test runner, portable build, or
second executable instance cannot overlap Captivate automation. The pipe is a kernel-owned lease:
binding is atomic, `EADDRINUSE` means busy, and closing or crashing the owning process releases it
without stale lockfiles. Bundle-only and SCORM-only exports never enter this reservation path.

A live `11.8.4.21` four-slide integration test has confirmed native title authoring,
in-place save, clean close, reopen, XML export, exact marker-title verification, second
clean close, atomic output promotion, and an unchanged qualified seed.

The TypeScript caller rejects a run unless the attested executable, build, seed hash,
unchanged seed, output path, slide count, titles, file size, and output SHA-256 match the
request. It then independently requires a regular ZIP container with `info.cpi`,
`objects/objects.cpo`, and `text.cptd` before linking it into the selected destination
without replacement.

Direct binary `.cptx` mutation is outside this contract.

## Progress and the trial reminder

The PowerShell driver writes newline-delimited progress records as each automation
stage begins. Electron consumes stdout incrementally and forwards those records to the
renderer; it does not wait for the process to exit before updating the interface.

Most progress is informational and Captivate must be left untouched. When the verified
Adobe trial reminder requires manual confirmation, the driver enters the
`await-continue-trial` stage. Electron maps that stage to the semantic
`TRIAL_REMINDER_REQUIRES_USER_ACTION` UI event. The app shows **Action needed in Adobe
Captivate** and asks the user to choose **Continue Trial** in the verified Adobe trial
window, or **Continue Offline** if Adobe uses that label. The user must not choose
**Try Again**, close Captivate, or touch other controls while the driver continues. A
terminal driver failure still appears with the affected export artifact.
