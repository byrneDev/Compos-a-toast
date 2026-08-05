# Contributing

Compos-a-toast is an early migration tool. Small, evidence-backed changes are easier to
review than broad guesses about legacy behavior.

## Setup

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run dev
```

Keep proprietary or customer course material outside Git. Add only newly authored,
minimal synthetic fixtures that demonstrate the format behavior under test.

## Pull requests

- Explain the recovered source behavior and how it was verified.
- Add or update focused tests.
- Preserve the static-extraction trust boundary.
- Do not add code that launches HTA, ActiveX, old Flash Player, or recovered scripts.
- Record unsupported behavior as a diagnostic rather than silently approximating it.
- For SCORM changes, test both standalone mode and an LMS API mock.
- For future Captivate changes, include save/reopen/publish verification evidence.
