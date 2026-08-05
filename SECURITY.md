# Security

## Supported versions

Compos-a-toast is pre-1.0 software. Security fixes are applied to the latest development
branch; no older release line is currently supported.

## Reporting a vulnerability

Do not attach a customer, proprietary, or copyrighted course to a public issue. Report
the smallest synthetic reproduction possible and describe the affected version,
operating system, source path/layout, observed behavior, and expected safe behavior.

Particularly important findings include:

- execution of code recovered from an input course;
- destination or source path traversal;
- writes outside the chosen export directory;
- Electron renderer access to unrestricted Node.js or filesystem APIs;
- unsafe extraction of archive entries;
- generated HTML that allows source scripts or event handlers to execute.

Until a private security contact is configured for the public repository, open a public
issue containing no exploit payload or sensitive course data and request a private
maintainer contact.
