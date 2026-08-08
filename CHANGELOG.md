# Changelog

All notable changes to Compos-a-toast will be documented here. The project follows
[Semantic Versioning](https://semver.org/) once public releases begin.

## 0.1.0 - Unreleased

### Added

- Electron, Vite, and TypeScript desktop application with a framework-free renderer.
- Static Composica published-course detection and neutral course-model extraction.
- Legacy encoding support, recursive outlines, object geometry, interactions, feedback,
  asset hashing, and inert Flash inventory.
- Editable per-slide migration bundle with source evidence, reconstruction instructions,
  Captivate assembly jobs, inventories, diagnostics, and checksums.
- HTML5 single-SCO SCORM 1.2 exporter with navigation, basic native interactions,
  learner state, scoring, resume support, and standalone fallback.
- Sandboxed Electron renderer with a narrow typed preload bridge.
- Windows 11 native caption controls, Mica backdrop support, and Windows 10,
  high-contrast, dark-theme, and reduced-transparency fallbacks.
- Smart App Control-safe local launch workflow and fail-closed signed Windows packaging.
- Signed, exact-build Captivate Classic detection and a hash-verified disposable CPTX
  launch/open smoke-test foundation.
- Captivate availability reporting that distinguishes an installed, verified Classic
  build from the separate native CPTX exporter readiness state.
- Version-pinned Captivate Classic `11.8.4.21` authoring adapter that creates native
  slides and editable title text, then saves, closes, reopens, and XML-verifies a new
  CPTX while preserving the qualified starter project.
- Live Captivate progress streaming, guarded trial-reminder handoff, fail-closed native
  menu/dialog profiles, physical cursor target attestation, a 150%-display qualification,
  and a disposable four-slide end-to-end integration test.
- SHA-256 verification for the bundled Captivate driver, bounded cross-process Win32
  messaging, and atomic no-overwrite CPTX promotion.
- Windows continuous integration, Dependabot configuration, structured issue forms,
  pull-request safety checks, support guidance, and third-party notices.
- Synthetic unit fixtures and an optional read-only seven-course local integration suite.

### Known limitations

- Native CPTX output currently covers slides and editable title text only. Images,
  interactions, detailed geometry/styling, and unsupported text require migration-bundle review.
- Native CPTX export is a developer-local beta: the qualified seed is not redistributed,
  and a fresh public install remains disabled until a public seed-qualification flow exists.
- The only live-qualified desktop profile currently uses a 150% primary display and an
  exact `1280x696` DPI-virtualized Captivate authoring window.
- Complex drag-and-drop, dynamic games, scripted states, and some media timing require
  manual reconstruction or additional native HTML5 renderers.
- Generated courses require visual, accessibility, interaction, and target-LMS acceptance testing.
