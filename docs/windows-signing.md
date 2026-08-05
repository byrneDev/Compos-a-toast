# Windows application signing

## Why an unpacked build can be blocked

Electron-builder changes the upstream Electron executable to add this application's
name, resources, and archive. That resulting executable is a new binary and is unsigned
unless a code-signing identity is supplied during packaging.

Windows Smart App Control and many organization-managed App Control policies block
unknown unsigned executables. A missing signature is different from the browser
download mark: copying the file, using `Unblock-File`, or rebuilding it in another local
folder does not establish a trusted publisher.

Do not turn off Smart App Control or weaken an organization policy to distribute this
application. Use the local development workflow until signing credentials are available.

## Local development

These commands use the Electron dependency's development runtime instead of the
rebranded unpacked executable:

```powershell
npm.cmd run dev
npm.cmd start
```

`dev` provides Vite hot reload. `start` builds the production assets, verifies that the
sandboxed preload is CommonJS, and then opens them with the development runtime.

## Creating a distributable Windows build

Use an RSA code-signing certificate from a certificate authority in Microsoft's Trusted
Root Program, Microsoft Trusted Signing, or an internal publisher certificate already
allowed by the target organization's App Control policy. A newly generated self-signed
certificate is not a Smart App Control distribution solution.

Electron-builder accepts a PFX path, URL, or encoded certificate through
`WIN_CSC_LINK`, with its password in `WIN_CSC_KEY_PASSWORD`. Set them using an approved
secret store or CI secret, then run:

```powershell
npm.cmd run package:win
```

The `package` and `package:win` commands enable electron-builder's `forceCodeSigning`
option and fail if they cannot sign. `package:win` produces the configured installer
and portable targets only after the application executable has a signing identity.

Verify the result before distributing it:

```powershell
Get-AuthenticodeSignature '.\release\win-unpacked\Compos-a-toast.exe' |
  Format-List Status, StatusMessage, SignerCertificate
```

`Status` must be `Valid`, and the signer must be the expected publisher. Also test every
installer, executable, uninstaller, and update path on a Smart App Control or equivalent
App Control test machine.

`package:unsigned` and `package:win:unsigned` remain available only for isolated
packaging inspection. Their output should be expected to fail on machines that require
trusted signatures.

## References

- [Microsoft: Smart App Control overview](https://learn.microsoft.com/windows/apps/develop/smart-app-control/overview)
- [Microsoft: signing for Smart App Control](https://learn.microsoft.com/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)
- [electron-builder: code signing](https://www.electron.build/docs/features/code-signing/)
