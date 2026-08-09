import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWindowsPowerShellEnvironment } from '../src/core/captivate/adapter'

interface DriverProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface HelperProcessStartInfoProbeResult extends DriverProcessResult {
  contained: boolean
}

function uniqueCatNativeCalls(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/\[CatNative\]::([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1])
    )
  ].sort()
}

function uniqueDriverHelperCalls(
  driverSource: string,
  functionSource: string,
  currentFunction: string
): string[] {
  const functionNames = [
    ...driverSource.matchAll(/^function\s+([A-Za-z_][\w-]*)\s*\{/gm)
  ].map((match) => match[1])
  return functionNames
    .filter((name) => name !== currentFunction)
    .filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?:^|[^\\w-])${escaped}(?=[\\s();|}])`, 'm').test(functionSource)
    })
    .sort()
}

function runDriverWithInvalidJob(): Promise<DriverProcessResult> {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const powerShell = resolve(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const driver = resolve('src/core/captivate/classic-11.8.4-driver.ps1')
  const syntacticallyValidButWrongSchemaJob = resolve('package.json')

  return new Promise((resolvePromise) => {
    execFile(
      powerShell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        driver,
        '-JobPath',
        syntacticallyValidButWrongSchemaJob
      ],
      {
        encoding: 'utf8',
        env: createWindowsPowerShellEnvironment(powerShell),
        windowsHide: true,
        timeout: 15_000
      },
      (error, stdout, stderr) => {
        const processError = error as (Error & { code?: string | number }) | null
        const exitCode =
          typeof processError?.code === 'number'
            ? processError.code
            : error
              ? 1
              : 0
        resolvePromise({ exitCode, stdout, stderr })
      }
    )
  })
}

function runHelperJobInheritanceProbe(): Promise<DriverProcessResult> {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const powerShell = resolve(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const driver = resolve('src/core/captivate/classic-11.8.4-driver.ps1')
  const escapedDriver = driver.replaceAll("'", "''")
  const escapedPowerShell = powerShell.replaceAll("'", "''")
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$source = Get-Content -LiteralPath '${escapedDriver}' -Raw
$nativeMatch = [regex]::Match($source, "Add-Type -TypeDefinition @'\\r?\\n([\\s\\S]+?)\\r?\\n'@ \\| Out-Null")
if (-not $nativeMatch.Success) { throw 'Main native source was not found.' }
Add-Type -TypeDefinition $nativeMatch.Groups[1].Value
if (-not [CatNative]::EnsureHelperKillOnParentCloseJob()) { throw 'Helper job setup failed.' }
$helper = New-Object Diagnostics.Process
$helper.StartInfo.FileName = '${escapedPowerShell}'
$helper.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
$helper.StartInfo.UseShellExecute = $false
$helper.StartInfo.CreateNoWindow = $true
try {
  if (-not $helper.Start()) { throw 'Probe helper did not start.' }
  if (-not [CatNative]::IsProcessInHelperJob($helper.Handle)) {
    try { $helper.Kill() } catch { }
    throw 'Probe helper did not inherit the job.'
  }
  [Console]::Out.WriteLine([string]$helper.Id)
  [Console]::Out.Flush()
} finally {
  $helper.Dispose()
}
`
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')

  return new Promise((resolvePromise) => {
    execFile(
      powerShell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand
      ],
      {
        encoding: 'utf8',
        env: createWindowsPowerShellEnvironment(powerShell),
        windowsHide: true,
        timeout: 20_000
      },
      (error, stdout, stderr) => {
        const processError = error as (Error & { code?: string | number }) | null
        const exitCode =
          typeof processError?.code === 'number'
            ? processError.code
            : error
              ? 1
              : 0
        resolvePromise({ exitCode, stdout, stderr })
      }
    )
  })
}

async function waitForExactProcessExit(processId: number, timeoutMilliseconds: number) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  return false
}

async function runAccessibilityHelperWithInvalidWindow(
  expectedDriverSha256Override?: string
): Promise<DriverProcessResult> {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const powerShell = resolve(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const driver = resolve('src/core/captivate/classic-11.8.4-driver.ps1')
  const expectedDriverSha256 = createHash('sha256')
    .update(await readFile(driver))
    .digest('hex')
  const payload = Buffer.from(
    JSON.stringify({
      Mode: 'evidence',
      ProcessId: 1,
      DialogHwnd: 1,
      OwnerHwnd: 1,
      EditHwnd: 1,
      EditControlId: 1001,
      SaveHwnd: 0,
      Left: 0,
      Top: 0,
      Width: 1200,
      Height: 720,
      ExpectedName: '',
      ExpectedValue: '',
      ExpectedRole: 0,
      ExpectedState: 0,
      TargetPath: ''
    }),
    'utf8'
  ).toString('base64')

  return new Promise((resolvePromise) => {
    execFile(
      powerShell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        driver,
        '-AccessibilityHelperMode',
        'evidence',
        '-AccessibilityPayload',
        payload,
        '-AccessibilityExpectedDriverSha256',
        expectedDriverSha256Override ?? expectedDriverSha256
      ],
      {
        encoding: 'utf8',
        env: createWindowsPowerShellEnvironment(powerShell),
        windowsHide: true,
        timeout: 15_000
      },
      (error, stdout, stderr) => {
        const processError = error as (Error & { code?: string | number }) | null
        const exitCode =
          typeof processError?.code === 'number'
            ? processError.code
            : error
              ? 1
              : 0
        resolvePromise({ exitCode, stdout, stderr })
      }
    )
  })
}

async function runAccessibilityHelperThroughProcessStartInfo(
  driver: string
): Promise<{
  launcher: DriverProcessResult
  helper?: HelperProcessStartInfoProbeResult
}> {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const powerShell = resolve(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const expectedDriverSha256 = createHash('sha256')
    .update(await readFile(driver))
    .digest('hex')
  const payload = Buffer.from(
    JSON.stringify({
      Mode: 'evidence',
      ProcessId: 1,
      DialogHwnd: 1,
      OwnerHwnd: 1,
      EditHwnd: 1,
      EditControlId: 1001,
      SaveHwnd: 0,
      Left: 0,
      Top: 0,
      Width: 1200,
      Height: 720,
      ExpectedName: '',
      ExpectedValue: '',
      ExpectedRole: 0,
      ExpectedState: 0,
      TargetPath: ''
    }),
    'utf8'
  ).toString('base64')
  const escapedDriver = driver.replaceAll("'", "''")
  const escapedPowerShell = powerShell.replaceAll("'", "''")
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$source = Get-Content -LiteralPath '${escapedDriver}' -Raw
$nativeMatch = [regex]::Match($source, "Add-Type -TypeDefinition @'\\r?\\n([\\s\\S]+?)\\r?\\n'@ \\| Out-Null")
if (-not $nativeMatch.Success) { throw 'Main native source was not found.' }
Add-Type -TypeDefinition $nativeMatch.Groups[1].Value
if (-not [CatNative]::EnsureHelperKillOnParentCloseJob()) { throw 'Helper job setup failed.' }
$quoteMatch = [regex]::Match($source, '(?ms)^(function ConvertTo-WindowsProcessArgument \\{.*?^\\})\\r?\\n\\r?\\nfunction Invoke-BoundedAccessibilityHelper')
if (-not $quoteMatch.Success) { throw 'Production argument-quoting function was not found.' }
Invoke-Expression $quoteMatch.Groups[1].Value
$helperArguments = @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', '${escapedDriver}',
  '-AccessibilityHelperMode', 'evidence',
  '-AccessibilityPayload', '${payload}',
  '-AccessibilityExpectedDriverSha256', '${expectedDriverSha256}'
)
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = '${escapedPowerShell}'
$startInfo.Arguments = (($helperArguments | ForEach-Object { ConvertTo-WindowsProcessArgument -Value ([string]$_) }) -join ' ')
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$helper = New-Object Diagnostics.Process
$helper.StartInfo = $startInfo
try {
  if (-not $helper.Start()) { throw 'Actual helper did not start.' }
  $contained = [CatNative]::IsProcessInHelperJob($helper.Handle)
  if (-not $contained) { throw 'Actual helper did not inherit the helper job.' }
  $stdoutTask = $helper.StandardOutput.ReadToEndAsync()
  $stderrTask = $helper.StandardError.ReadToEndAsync()
  if (-not $helper.WaitForExit(15000)) {
    try { $helper.Kill() } catch { }
    [void]$helper.WaitForExit(2000)
    throw 'Actual helper timed out.'
  }
  $helper.WaitForExit()
  $result = [ordered]@{
    exitCode = [int]$helper.ExitCode
    stdout = $stdoutTask.GetAwaiter().GetResult()
    stderr = $stderrTask.GetAwaiter().GetResult()
    contained = $contained
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
} finally {
  try {
    if (-not $helper.HasExited) {
      $helper.Kill()
      [void]$helper.WaitForExit(2000)
    }
  } catch { }
  $helper.Dispose()
}
`
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')

  const launcher = await new Promise<DriverProcessResult>((resolvePromise) => {
    execFile(
      powerShell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand
      ],
      {
        encoding: 'utf8',
        env: createWindowsPowerShellEnvironment(powerShell),
        windowsHide: true,
        timeout: 25_000
      },
      (error, stdout, stderr) => {
        const processError = error as (Error & { code?: string | number }) | null
        const exitCode =
          typeof processError?.code === 'number'
            ? processError.code
            : error
              ? 1
              : 0
        resolvePromise({ exitCode, stdout, stderr })
      }
    )
  })
  if (launcher.exitCode !== 0 || launcher.stdout.trim().length === 0) return { launcher }
  return {
    launcher,
    helper: JSON.parse(launcher.stdout.trim()) as HelperProcessStartInfoProbeResult
  }
}

describe('Captivate Classic PowerShell driver protocol', () => {
  it('uses the Windows PowerShell 5.1-compatible New-Item path parameter', async () => {
    const source = await readFile(
      resolve('src/core/captivate/classic-11.8.4-driver.ps1'),
      'utf8'
    )
    const accessibilityHelperSource = source.match(
      /\$script:AccessibilityHelperSource = @'\r?\n([\s\S]+?)\r?\n'@/
    )?.[1]
    const mainNativeSource = source.match(
      /Add-Type -TypeDefinition @'\r?\n([\s\S]+?)\r?\n'@ \| Out-Null/
    )?.[1]
    expect(accessibilityHelperSource).toBeDefined()
    expect(mainNativeSource).toBeDefined()

    expect(source).not.toMatch(/New-Item[^\r\n]*-LiteralPath/i)
    expect(source).toMatch(/New-Item -ItemType Directory -Path \$script:StagingRoot/)
    expect(source).toMatch(/\$captivateProcess\.MainWindowHandle/)
    expect(source).toMatch(/DescribeWindowWithoutText/)
    expect(source).toMatch(
      /\$candidate\.ClassName -ne 'Adobe Captivate Classic'/
    )
    expect(source).toMatch(/\$startInfo\.UseShellExecute = \$true/)
    expect(source).toMatch(/SendMessageTimeoutText/)
    expect(source).not.toMatch(/extern IntPtr SendMessage\(/)
    expect(source).toMatch(/GetScaleFactorForMonitor/)
    expect(source).toMatch(/ExpectedPrimaryScalePercent = 150/)
    expect(source).toMatch(/primary150-unaware-1280x696-v4/)
    expect(source).toMatch(/GetPhysicalCursorPos/)
    expect(source).toMatch(/WindowFromPhysicalPoint/)
    expect(source).toMatch(/GetGUIThreadInfo/)
    expect(source).toMatch(/\[CatNative\]::KeyPress\(0x12\)/)
    expect(source).toMatch(/Start-Sleep -Milliseconds 250/)
    expect(source).toMatch(/RootWindow\(\$settledForeground\.ToInt64\(\)\) -eq \$MainHwnd/)
    expect(mainNativeSource).not.toMatch(/Accessibility|AccessibleObjectFromWindow|get_acc/)
    expect(source).not.toMatch(/\[CatNative\]::(?:Accessible|InvokeUnique)/)
    expect(source).not.toMatch(/ClickExactSaveAsButton/)
    expect(source).toMatch(/Read-ImageTextWithWindowsOcr/)
    const boundedAccessibilityHelper = source.match(
      /function Invoke-BoundedAccessibilityHelper[\s\S]+?\r?\n}\r?\n\r?\nfunction Set-CaptivateForegroundOrFail/
    )?.[0]
    expect(boundedAccessibilityHelper).toBeDefined()
    expect(source).toMatch(/ParameterSetName = 'AccessibilityHelper'/)
    expect(source).toMatch(/ValidateSet\('evidence', 'save', 'strings'\)/)
    expect(source).toMatch(/AccessibilityExpectedDriverSha256/)
    expect(source).toMatch(/DriverStartupSha256/)
    expect(source).toMatch(/ACCESSIBILITY_HELPER_DRIVER_HASH_CHANGED/)
    expect(source).toMatch(/script bytes did not match the parent driver startup hash/)
    expect(mainNativeSource).toMatch(/JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000/)
    expect(mainNativeSource).toMatch(/SetInformationJobObject/)
    expect(mainNativeSource).toMatch(
      /AssignProcessToJobObject\(job, GetCurrentProcess\(\)\)/
    )
    expect(mainNativeSource).toMatch(/IsProcessInJob\(process, HelperJob/)
    expect(boundedAccessibilityHelper).toMatch(/\$script:DriverScriptPath/)
    expect(boundedAccessibilityHelper).toMatch(/MainModule\.FileName/)
    expect(boundedAccessibilityHelper).toMatch(/'-File'/)
    expect(boundedAccessibilityHelper).toMatch(/ConvertTo-WindowsProcessArgument/)
    expect(boundedAccessibilityHelper).not.toMatch(/EncodedCommand/)
    expect(boundedAccessibilityHelper).toMatch(
      /\$helperArgumentLine\.Length -gt 0 -and \$helperArgumentLine\.Length -le 30000/
    )
    expect(boundedAccessibilityHelper).toMatch(
      /ACCESSIBILITY_HELPER_COMMAND_LINE_TOO_LARGE/
    )
    expect(
      boundedAccessibilityHelper?.indexOf('$helperArgumentLine.Length -le 30000') ?? -1
    ).toBeLessThan(boundedAccessibilityHelper?.indexOf('$helper.Start()') ?? -1)
    expect(boundedAccessibilityHelper).toMatch(/UseShellExecute = \$false/)
    expect(boundedAccessibilityHelper).toMatch(/CreateNoWindow = \$true/)
    expect(boundedAccessibilityHelper).not.toMatch(/CREATE_BREAKAWAY_FROM_JOB|Breakaway/i)
    expect(boundedAccessibilityHelper).toMatch(/RedirectStandardOutput = \$true/)
    expect(boundedAccessibilityHelper).toMatch(/RedirectStandardError = \$true/)
    expect(boundedAccessibilityHelper).toMatch(/EnsureHelperKillOnParentCloseJob/)
    expect(boundedAccessibilityHelper).toMatch(/IsProcessInHelperJob\(\$helper\.Handle\)/)
    expect(boundedAccessibilityHelper).toMatch(/ACCESSIBILITY_HELPER_CONTAINMENT_FAILED/)
    expect(
      boundedAccessibilityHelper?.indexOf('EnsureHelperKillOnParentCloseJob') ?? -1
    ).toBeLessThan(boundedAccessibilityHelper?.indexOf('$helper.Start()') ?? -1)
    expect(
      boundedAccessibilityHelper?.indexOf('IsProcessInHelperJob($helper.Handle)') ?? -1
    ).toBeLessThan(
      boundedAccessibilityHelper?.indexOf('$helper.StandardOutput.ReadToEndAsync()') ?? -1
    )
    expect(boundedAccessibilityHelper).toMatch(/WaitForExit\(\$TimeoutMilliseconds\)/)
    expect(boundedAccessibilityHelper).toMatch(/\$helper\.Kill\(\)/)
    expect(boundedAccessibilityHelper).toMatch(/ACCESSIBILITY_HELPER_TERMINATION_UNCONFIRMED/)
    expect(boundedAccessibilityHelper).toMatch(/\$helperTerminationConfirmed/)
    expect(boundedAccessibilityHelper).toMatch(/finally \{[\s\S]+?\$helper\.HasExited/)
    expect(boundedAccessibilityHelper).toMatch(
      /finally \{[\s\S]+?\$helper\.Kill\(\)[\s\S]+?\$helper\.WaitForExit\(2000\)/
    )
    expect(boundedAccessibilityHelper).toMatch(/\$finallyTerminationFailure/)
    expect(boundedAccessibilityHelper).toMatch(/exceptional-path cleanup/)
    expect(boundedAccessibilityHelper).toMatch(/ACCESSIBILITY_HELPER_TIMEOUT/)
    expect(boundedAccessibilityHelper).toMatch(/only that helper process was terminated/)
    expect(boundedAccessibilityHelper).toMatch(
      /\$helperProcessContext = "exitCode=\$helperExitCode; stderr=\$normalizedHelperStderr"/
    )
    expect(boundedAccessibilityHelper).toMatch(
      /did not return exactly one JSON response \(\$helperProcessContext\)/
    )
    expect(boundedAccessibilityHelper).toMatch(
      /returned malformed JSON \(\$helperProcessContext\)/
    )
    expect(boundedAccessibilityHelper).toMatch(
      /response did not match the exact schema and mode \(\$helperProcessContext\)/
    )
    expect(boundedAccessibilityHelper).toMatch(/HELPER_PROCESS_REJECTED/)
    expect(boundedAccessibilityHelper).toMatch(/did not include an error message/)
    expect(boundedAccessibilityHelper).not.toMatch(/taskkill|Stop-Process|Kill\(.*Captivate/i)
    expect(accessibilityHelperSource).toMatch(/AccessibleObjectFromWindow/)
    expect(accessibilityHelperSource).toMatch(/AccessibleChildren/)
    expect(accessibilityHelperSource).toMatch(/ReadEvidence/)
    expect(accessibilityHelperSource).toMatch(/ExecuteStrings/)
    expect(accessibilityHelperSource).toMatch(/MaxStrings = 128/)
    const trialReminderHandler = source.match(
      /function Wait-ForExactTrialReminder[\s\S]+?\r?\n}\r?\n\r?\nfunction Start-OwnedCaptivate/
    )?.[0]
    expect(trialReminderHandler).toBeDefined()
    expect(uniqueCatNativeCalls(trialReminderHandler ?? '')).toEqual([
      'IsWindow',
      'IsWindowVisible'
    ])
    expect(
      uniqueDriverHelperCalls(source, trialReminderHandler ?? '', 'Wait-ForExactTrialReminder')
    ).toEqual([
      'Add-AuditRecord',
      'Assert-Condition',
      'Assert-NoUnexpectedTopWindow',
      'Get-NormalizedWhitespace',
      'Get-VisibleAdobeLicensingWindows',
      'Get-WindowInfo',
      'Get-WindowInfoWithoutText',
      'Read-ImageTextWithWindowsOcr',
      'Set-DriverStage',
      'Stop-Driver',
      'Wait-CaptivateLicensingHandoff',
      'Wait-Until'
    ])
    expect(trialReminderHandler).toMatch(/Continue Trial/)
    expect(trialReminderHandler).toMatch(/CONTINUE_TRIAL_USER_ACTION_TIMEOUT/)
    expect(trialReminderHandler).toMatch(/Read-ImageTextWithWindowsOcr/)
    expect(trialReminderHandler).not.toMatch(/NGL EmbeddedWB/)
    expect(trialReminderHandler).toMatch(/TimeoutMilliseconds 20000/)
    expect(trialReminderHandler).toMatch(/stableNoReminderSamples -ge 40/)
    expect(trialReminderHandler).toMatch(/TimeoutMilliseconds 30000/)
    expect(trialReminderHandler).toMatch(/TimeoutMilliseconds 300000/)
    expect(trialReminderHandler).toMatch(/Continue Offline/)
    expect(trialReminderHandler).toMatch(/Never choose Try Again/)
    const licensingHandoff = source.match(
      /function Wait-CaptivateLicensingHandoff[\s\S]+?\r?\n}\r?\n\r?\nfunction Wait-ForExactTrialReminder/
    )?.[0]
    expect(licensingHandoff).toBeDefined()
    expect(uniqueCatNativeCalls(licensingHandoff ?? '')).toEqual([
      'IsWindow',
      'IsWindowVisible'
    ])
    expect(
      uniqueDriverHelperCalls(source, licensingHandoff ?? '', 'Wait-CaptivateLicensingHandoff')
    ).toEqual([
      'Get-VisibleAdobeLicensingWindows',
      'Get-VisibleTopWindows',
      'Get-WindowInfoWithoutText',
      'Stop-Driver',
      'Wait-Until'
    ])
    expect(licensingHandoff).toMatch(/\$captivateProcess\.Responding/)
    expect(licensingHandoff).toMatch(
      /\$_\.ClassName -ne 'tooltips_class32'/
    )
    expect(licensingHandoff).toMatch(
      /\$licensingProcessExited -and \$remainingLicensingProcesses\.Count -eq 0 -and -not \$rootVisible -and \$visibleLicensing\.Count -eq 0/
    )
    expect(licensingHandoff).not.toMatch(
      /\$licensingProcessExited\s+-or/
    )
    expect(source).toMatch(
      /ClassName -eq 'DroverLord - Window Class'.+Text -eq 'OS_PopupWindow'/
    )
    const addContentSlide = source.match(
      /function Add-ContentSlide[\s\S]+?\r?\n}\r?\n\r?\nfunction Assert-ExactMenuItem/
    )?.[0]
    expect(addContentSlide).toBeDefined()
    expect(addContentSlide).toMatch(
      /IsWindow\(\[IntPtr\]\$popup\.Hwnd\).+IsWindowVisible\(\[IntPtr\]\$popup\.Hwnd\)/s
    )
    expect(addContentSlide).toMatch(/Assert-NoUnexpectedTopWindow/)
    expect(addContentSlide).toMatch(/UNEXPECTED_WINDOW_WHILE_OPENING_SLIDES/)
    expect(addContentSlide).toMatch(/Text -eq 'OS_ViewContainer'/)
    expect(addContentSlide).toMatch(/AMBIGUOUS_SLIDES_POPUP_TRANSITION/)
    expect(addContentSlide).toMatch(
      /\$transitionHandles = @\(\$transitionalHosts \| ForEach-Object \{ \[long\]\$_\.Hwnd \}\)/
    )
    expect(addContentSlide).not.toMatch(/\$transitionalHosts\.Hwnd/)
    expect(addContentSlide).toMatch(/SLIDES_POPUP_TRANSITION_IDENTITY_MISMATCH/)
    expect(addContentSlide).toMatch(/\$_\.Visible -and \$_\.Enabled/)
    expect(addContentSlide).toMatch(/\$_\.Owner -in @\(0, \$MainHwnd\)/)
    expect(addContentSlide).toMatch(/\$_\.Width -eq 200 -and \$_\.Height -eq 370/)
    expect(addContentSlide).toMatch(/\$currentPopup = Get-WindowInfo -Hwnd \$popup\.Hwnd/)
    expect(addContentSlide).toMatch(/SLIDES_POPUP_CHANGED_BEFORE_CLICK/)
    expect(addContentSlide).toMatch(/ClickWithinExactWindowProfile/)
    expect(addContentSlide?.indexOf('$popupUnchanged')).toBeLessThan(
      addContentSlide?.indexOf('[CatNative]::ClickWithinExactWindowProfile') ?? -1
    )
    expect(addContentSlide?.indexOf("Text -eq 'OS_ViewContainer'")).toBeLessThan(
      addContentSlide?.indexOf('SLIDES_POPUP_TIMEOUT') ?? -1
    )
    const nativeText = source.match(
      /function Set-NativeTextAtProfilePoint[\s\S]+?\r?\n}\r?\n\r?\nfunction Add-ContentSlide/
    )?.[0]
    expect(nativeText).toBeDefined()
    expect(nativeText).toMatch(/ExpectedHitClass 'DocumentContainerWindowClass'/)
    expect(nativeText).toMatch(/Confirm-TextEditContextAndSelectAll/)
    expect(nativeText).not.toMatch(/positionPIPalette/)
    expect(nativeText).not.toMatch(/\[CatNative]::CtrlKey/)
    expect(nativeText?.indexOf('Confirm-TextEditContextAndSelectAll')).toBeLessThan(
      nativeText?.indexOf('[CatNative]::TypeUnicode') ?? -1
    )
    expect(nativeText?.lastIndexOf('Assert-NoUnexpectedTopWindow')).toBeGreaterThan(
      nativeText?.indexOf('[CatNative]::TypeUnicode') ?? Number.MAX_SAFE_INTEGER
    )
    const textEditAttestation = source.match(
      /function Confirm-TextEditContextAndSelectAll[\s\S]+?\r?\n}\r?\n\r?\nfunction Set-NativeTextAtProfilePoint/
    )?.[0]
    expect(textEditAttestation).toBeDefined()
    expect(textEditAttestation).toMatch(/RightClickWithinRootAndClass/)
    expect(textEditAttestation).toMatch(/DocumentContainerWindowClass/)
    expect(textEditAttestation).toMatch(/ClassName -eq '#32768'/)
    expect(textEditAttestation).toMatch(/Width -eq 227.+Height -in @\(156, 178\)/s)
    expect(textEditAttestation).not.toMatch(/\$_\.Height\s+-(?:gt|ge|lt|le)\b/)
    expect(textEditAttestation).toMatch(/Position = 0; Id = -1; Text = "Cu&t`tCtrl\+X"/)
    expect(textEditAttestation).toMatch(/\$expectedWithoutPaste = @\(/)
    expect(textEditAttestation).toMatch(/\$expectedWithPaste = @\(/)
    expect(textEditAttestation).toMatch(/Position = 2; Id = -1; Text = "&Paste`tCtrl\+V"/)
    expect(textEditAttestation).toMatch(/Position = 6; Id = -1; Text = "S&elect All`tCtrl\+A"/)
    expect(textEditAttestation).toMatch(/Position = 7; Id = -1; Text = 'Insert Hyperlink'/)
    expect(textEditAttestation).toMatch(/Position = 8; Id = -1; Text = 'Insert Hyperlink'/)
    expect(textEditAttestation).toMatch(/conditionally exposes an enabled Paste row/)
    expect(textEditAttestation).toMatch(/\$pasteProfile = \$popup\.Height -eq 178/)
    expect(textEditAttestation).toMatch(/\$separatorPositions = if \(\$pasteProfile\) \{ @\(5, 7\) \} else \{ @\(4, 6\) \}/)
    expect(textEditAttestation).toMatch(/\$selectAllPosition = if \(\$pasteProfile\) \{ 6 \} else \{ 5 \}/)
    expect(textEditAttestation).toMatch(/\$expectedLeafCount = if \(\$pasteProfile\) \{ 7 \} else \{ 6 \}/)
    expect(textEditAttestation).toMatch(/distinctLeafIds\.Count -eq \$expectedLeafCount/)
    expect(textEditAttestation).toMatch(/\$revalidatedItems = @\(\[CatNative\]::MenuItemsForPopup\(\$popup\.Hwnd\)\)/)
    expect(textEditAttestation).toMatch(/TEXT_EDIT_CONTEXT_MENU_CHANGED_BEFORE_SELECT_ALL/)
    expect(textEditAttestation).toMatch(/ClickPopupMenuPosition\(\$popup\.Hwnd, \$ProcessId, \$selectAllPosition, \$expected\.Count/)
    const semanticGate = textEditAttestation?.indexOf(
      '$distinctLeafIds.Count -eq $expectedLeafCount'
    )
    expect(semanticGate).toBeGreaterThan(-1)
    expect(semanticGate).toBeLessThan(
      textEditAttestation?.indexOf('$revalidatedItems = @([CatNative]::MenuItemsForPopup') ?? -1
    )
    expect(textEditAttestation?.indexOf('$revalidatedItems = @([CatNative]::MenuItemsForPopup')).toBeLessThan(
      textEditAttestation?.indexOf('[CatNative]::ClickPopupMenuPosition') ?? -1
    )
    const clickPopupMenuPosition = source.match(
      /public static bool ClickPopupMenuPosition[\s\S]+?\r?\n    }\r?\n\r?\n    private static void SendVirtualKey/
    )?.[0]
    expect(clickPopupMenuPosition).toBeDefined()
    expect(clickPopupMenuPosition).toMatch(/expectedHeight != 156 && expectedHeight != 178/)
    expect(clickPopupMenuPosition).toMatch(/current\.ProcessId != expectedProcessId/)
    expect(clickPopupMenuPosition).toMatch(/current\.Width != 227 \|\| current\.Height != expectedHeight \|\| current\.Owner != 0/)
    expect(clickPopupMenuPosition).toMatch(/count != expectedCount/)
    expect(clickPopupMenuPosition).toMatch(/GetMenuItemID\(menu, position\) != expectedId/)
    expect(clickPopupMenuPosition).toMatch(/String\.Equals\(text\.ToString\(\), expectedText, StringComparison\.Ordinal\)/)
    expect(clickPopupMenuPosition).toMatch(/GetMenuState\(menu, \(uint\)position, MF_BYPOSITION\) != expectedState/)
    expect(clickPopupMenuPosition).toMatch(/GetSubMenu\(menu, position\) != IntPtr\.Zero/)
    expect(textEditAttestation).toMatch(/FocusedWindowForThread/)
    expect(textEditAttestation).toMatch(/ClassName -eq 'OWL\.Document'/)
    expect(textEditAttestation).toMatch(/TimeoutMilliseconds 3000/)
    expect(textEditAttestation).toMatch(/TEXT_EDIT_FOCUS_NOT_CONFIRMED/)
    expect(textEditAttestation).not.toMatch(/TypeUnicode|CtrlKey/)
    expect(source).not.toMatch(/positionPIPalette/)
    expect(source).toMatch(/GetMenuItemRect/)
    expect(source).toMatch(/PositionCursorWithinRoot\(x, y, hwnd\)/)
    const failureCleanup = source.match(
      /function Request-BoundedNormalCloseAfterFailure[\s\S]+?\r?\n}\r?\n\r?\nfunction Get-ExactXmlSuccessDialog/
    )?.[0]
    expect(failureCleanup).toBeDefined()
    expect(failureCleanup).toMatch(/AccessibilityHelperTerminationUnconfirmed/)
    expect(failureCleanup).toMatch(/no Captivate close or other UI action was sent/)
    expect(failureCleanup?.indexOf('AccessibilityHelperTerminationUnconfirmed')).toBeLessThan(
      failureCleanup?.indexOf('[CatNative]::CloseWindow') ?? -1
    )
    expect(failureCleanup).toMatch(/\$script:LicensingHandoffActive/)
    expect(failureCleanup).toMatch(/\$script:Stage -eq 'await-continue-trial'/)
    expect(failureCleanup).toMatch(/LICENSING\|TRIAL_REMINDER\|CONTINUE_TRIAL/)
    expect(failureCleanup?.indexOf('$licensingFailure')).toBeLessThan(
      failureCleanup?.indexOf('[CatNative]::CloseWindow') ?? -1
    )
    expect(failureCleanup).toMatch(/Text\.TrimEnd\(\)\.EndsWith\('\*'\)/)
    expect(failureCleanup).toMatch(/Get-VisibleAdobeLicensingWindows/)
    expect(failureCleanup).toMatch(/mainWithText\.Enabled/)
    expect(failureCleanup?.indexOf("EndsWith('*')")).toBeLessThan(
      failureCleanup?.indexOf('[CatNative]::CloseWindow') ?? -1
    )
    const xmlSuccessDialog = source.match(
      /function Get-ExactXmlSuccessDialog[\s\S]+?\r?\n}\r?\n\r?\nfunction Read-SafeXmlDocument/
    )?.[0]
    expect(xmlSuccessDialog).toBeDefined()
    expect(xmlSuccessDialog).toMatch(/Invoke-BoundedAccessibilityHelper -Mode 'strings'/)
    expect(xmlSuccessDialog).not.toMatch(/\[CatNative\]::Accessible/)
    const normalClose = source.match(
      /function Close-OwnedCaptivateNormally[\s\S]+?\r?\n}\r?\n\r?\nfunction Request-BoundedNormalCloseAfterFailure/
    )?.[0]
    expect(normalClose).toBeDefined()
    expect(normalClose).toMatch(/\$Process\.CloseMainWindow\(\)/)
    expect(normalClose).toMatch(/CAPTIVATE_DIRTY_DURING_CLOSE/)
    expect(normalClose).not.toMatch(/Invoke-UniqueMsaaMenuItem/)
    expect(normalClose).not.toMatch(/Wait-AndInvokeMsaaMenuItem/)
    const xmlMenu = source.match(
      /function Open-ExactXmlExportDialog[\s\S]+?\r?\n}\r?\n\r?\nfunction Get-XmlFileDialogControls/
    )?.[0]
    expect(xmlMenu).toBeDefined()
    expect(xmlMenu).toMatch(/MenuItemsForPopup/)
    expect(xmlMenu).toMatch(/\[CatNative\]::MoveCursorWithinRoot\(185, 324, \$filePopup\.Hwnd\)/)
    expect(xmlMenu).toMatch(/\[CatNative\]::MoveCursorWithinRoot\(476, 368, \$exportPopup\.Hwnd\)/)
    expect(xmlMenu).toMatch(/\[CatNative\]::ClickWithinRoot\(476, 368, 1, \$exportPopup\.Hwnd\)/)
    expect(xmlMenu).toMatch(/Position 14 -Id 4294967295 -Text '&Export'/)
    expect(xmlMenu).toMatch(/Position 2 -Text '&To XML\.\.\.'/)
    expect(xmlMenu).toMatch(/assigns these leaf command IDs dynamically/)
    expect(xmlMenu).toMatch(/Left -eq 323.+Top -eq 310.+Width -eq 306.+Height -eq 94/s)
    expect(xmlMenu).not.toMatch(/InvokeUniqueAccessible/)
    expect(xmlMenu).not.toMatch(/WM_COMMAND/)
    expect(source).toMatch(/MN_GETHMENU.+SMTO_ABORTIFHUNG \| SMTO_ERRORONEXIT.+2000/s)
    expect(source).toMatch(/call == IntPtr\.Zero \|\| menu == IntPtr\.Zero \|\| !IsMenu\(menu\)/)
    expect(source).toMatch(/BM_CLICK.+SMTO_ABORTIFHUNG \| SMTO_ERRORONEXIT.+return call != IntPtr\.Zero/s)
    expect(source).toMatch(/if \(\$matches\.Count -ne 1\)[\s\S]+?\$item = \$matches\[0\]/)
    const xmlDialog = source.match(
      /function Get-StandardXmlFileDialog[\s\S]+?\r?\n}\r?\n\r?\nfunction Enter-XmlExportPath/
    )?.[0]
    expect(xmlDialog).toBeDefined()
    expect(xmlDialog).toMatch(/Text -eq 'Save As'/)
    expect(xmlDialog).toMatch(/Width -eq 1200.+Height -eq 720/)
    expect(source).toMatch(/DialogControlId\(\$_.Hwnd\) -in @\(1001, 1148\)/)
    expect(source).toMatch(/DialogControlId\(\$_.Hwnd\) -eq 1/)
    const enterXmlPath = source.match(
      /function Enter-XmlExportPath[\s\S]+?\r?\n}\r?\n\r?\nfunction Wait-FileStable/
    )?.[0]
    expect(enterXmlPath).toBeDefined()
    expect(enterXmlPath).toMatch(/Invoke-BoundedAccessibilityHelper -Mode 'evidence'/)
    expect(enterXmlPath).toMatch(/Invoke-BoundedAccessibilityHelper -Mode 'save'/)
    expect(enterXmlPath).toMatch(/\$qualifiedFileNameState = \[uint32\]0x00100004/)
    expect(enterXmlPath).toMatch(
      /\$candidate\.Name -ceq 'File name:' -and \$candidate\.Role -eq 42 -and \$candidate\.State -eq \$qualifiedFileNameState -and \$candidate\.Value -ceq \$XmlPath/
    )
    expect(enterXmlPath).toMatch(/XML_FILE_DIALOG_CONTROLS_CHANGED_BEFORE_SAVE/)
    expect(enterXmlPath).toMatch(/XML_FILE_DIALOG_CONTROL_ROOT_CHANGED_BEFORE_SAVE/)
    expect(enterXmlPath).toMatch(/ExpectedName = 'File name:'/)
    expect(enterXmlPath).toMatch(/ExpectedValue = \$XmlPath/)
    expect(enterXmlPath).toMatch(/ExpectedRole = 42/)
    expect(enterXmlPath).toMatch(/ExpectedState = \$qualifiedFileNameState/)
    expect(enterXmlPath).toMatch(/TargetPath = \$XmlPath/)
    expect(enterXmlPath).not.toMatch(/Test-Path -LiteralPath \$XmlPath/)
    const focusIndex = enterXmlPath?.indexOf('[CatNative]::FocusControl') ?? -1
    const typeIndex = enterXmlPath?.indexOf('[CatNative]::TypeUnicode') ?? -1
    const evidencePollIndex =
      enterXmlPath?.indexOf("Invoke-BoundedAccessibilityHelper -Mode 'evidence'") ?? -1
    const finalWindowCheckIndex =
      enterXmlPath?.lastIndexOf('Assert-NoUnexpectedTopWindow') ?? -1
    const finalDialogIndex = enterXmlPath?.lastIndexOf('Get-StandardXmlFileDialog') ?? -1
    const finalControlsIndex = enterXmlPath?.lastIndexOf('Get-XmlFileDialogControls') ?? -1
    const saveRequestIndex = enterXmlPath?.indexOf('$saveRequest = [PSCustomObject]') ?? -1
    const saveClickIndex =
      enterXmlPath?.indexOf("Invoke-BoundedAccessibilityHelper -Mode 'save'") ?? -1
    expect(focusIndex).toBeGreaterThanOrEqual(0)
    expect(focusIndex).toBeLessThan(typeIndex)
    expect(typeIndex).toBeLessThan(evidencePollIndex)
    expect(evidencePollIndex).toBeLessThan(finalWindowCheckIndex)
    expect(finalWindowCheckIndex).toBeLessThan(finalDialogIndex)
    expect(finalDialogIndex).toBeLessThan(finalControlsIndex)
    expect(finalControlsIndex).toBeLessThan(saveRequestIndex)
    expect(saveRequestIndex).toBeLessThan(saveClickIndex)
    expect(accessibilityHelperSource).toMatch(
      /ExecuteSave[\s\S]+?ValidateSaveDialog[\s\S]+?ValidateEdit[\s\S]+?ValidateSaveButton[\s\S]+?ReadEvidence[\s\S]+?ExpectedName[\s\S]+?ExpectedValue[\s\S]+?ExpectedRole[\s\S]+?ExpectedState[\s\S]+?File\.Exists[\s\S]+?Directory\.Exists[\s\S]+?SendMessageTimeout/
    )
    expect(accessibilityHelperSource).toMatch(/SAVE_DIALOG_CHANGED_AFTER_EVIDENCE/)
    expect(accessibilityHelperSource).toMatch(/SAVE_EDIT_CHANGED_AFTER_EVIDENCE/)
    expect(accessibilityHelperSource).toMatch(/SAVE_BUTTON_CHANGED_AFTER_EVIDENCE/)
    expect(accessibilityHelperSource).toMatch(/get_accName\(0\)/)
    expect(accessibilityHelperSource).toMatch(/get_accValue\(0\)/)
    expect(accessibilityHelperSource).toMatch(/get_accRole\(0\)/)
    expect(accessibilityHelperSource).toMatch(/get_accState\(0\)/)
    expect(source).not.toMatch(/\$entered = \[CatNative\]::TextForWindow/)
    expect(source).toMatch(
      /\$hashBeforeReopen = Get-Sha256 -LiteralPath \$script:StagingCptxPath\r?\n\s*Assert-Condition -Condition \(\$hashBeforeReopen -eq \$savedHash\) -Code 'SAVED_PROJECT_HASH_CHANGED_BEFORE_REOPEN'/
    )
    expect(source).toMatch(
      /\$hashAfterVerification = Get-Sha256 -LiteralPath \$script:StagingCptxPath\r?\n\s*Assert-Condition -Condition \(\$hashAfterVerification -eq \$savedHash\) -Code 'VERIFIED_PROJECT_HASH_CHANGED_AFTER_REOPEN'/
    )
    expect(source).toMatch(
      /\$hashImmediatelyBeforePromotion = Get-Sha256 -LiteralPath \$script:StagingCptxPath\r?\n\s*Assert-Condition -Condition \(\$hashImmediatelyBeforePromotion -eq \$savedHash -and \$hashImmediatelyBeforePromotion -eq \$hashAfterVerification\) -Code 'VERIFIED_PROJECT_HASH_CHANGED_BEFORE_PROMOTION'/
    )
    expect(source).toMatch(
      /\$outputHash = Get-Sha256 -LiteralPath \$outputPath\r?\n\s*Assert-Condition -Condition \(\$outputHash -eq \$savedHash -and \$outputHash -eq \$hashImmediatelyBeforePromotion\) -Code 'PROMOTED_PROJECT_HASH_MISMATCH'/
    )
    const firstCloseHashIndex = source.indexOf('$hashBeforeReopen = Get-Sha256')
    const reopenIndex = source.indexOf("Set-DriverStage -Name 'reopen-project'")
    const verifiedCloseHashIndex = source.indexOf('$hashAfterVerification = Get-Sha256')
    const promotionHashIndex = source.indexOf('$hashImmediatelyBeforePromotion = Get-Sha256')
    const moveIndex = source.indexOf('[IO.File]::Move($script:StagingCptxPath, $outputPath)')
    const outputHashIndex = source.indexOf('$outputHash = Get-Sha256 -LiteralPath $outputPath')
    const outputPromotedIndex = source.lastIndexOf('$script:OutputPromoted = $true')
    expect(firstCloseHashIndex).toBeGreaterThanOrEqual(0)
    expect(firstCloseHashIndex).toBeLessThan(reopenIndex)
    expect(reopenIndex).toBeLessThan(verifiedCloseHashIndex)
    expect(verifiedCloseHashIndex).toBeLessThan(promotionHashIndex)
    expect(promotionHashIndex).toBeLessThan(moveIndex)
    expect(moveIndex).toBeLessThan(outputHashIndex)
    expect(outputHashIndex).toBeLessThan(outputPromotedIndex)
    expect(source).toMatch(/\$xmlSize = \[long\]\$xmlItem\.Length/)
    expect(source).toMatch(/verificationXml = \[ordered\]@\{ sha256 = \$xmlHash; size = \$xmlSize \}/)
  })

  it.runIf(process.platform === 'win32')(
    'loads under Windows PowerShell 5.1 and fails closed with one terminal JSON result',
    async () => {
      const execution = await runDriverWithInvalidJob()
      const records = execution.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const results = records.filter((record) => record.type === 'result')

      expect(execution.exitCode).toBe(1)
      expect(execution.stderr).toBe('')
      expect(records.some((record) => record.type === 'progress')).toBe(true)
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        schemaVersion: 1,
        ok: false,
        stage: 'read-job',
        error: { code: 'UNSUPPORTED_JOB_SCHEMA' },
        attestation: {
          processExitConfirmed: true,
          outputPromoted: false
        }
      })
    },
    20_000
  )

  it.runIf(process.platform === 'win32')(
    'loads the private accessibility helper without entering the Captivate driver path',
    async () => {
      const execution = await runAccessibilityHelperWithInvalidWindow()
      const lines = execution.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      expect(execution.exitCode).toBe(0)
      expect(execution.stderr).toBe('')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        SchemaVersion: 1,
        Mode: 'evidence',
        Ok: false,
        Code: 'EVIDENCE_DIALOG_REJECTED',
        Clicked: false
      })
    },
    20_000
  )

  it.runIf(process.platform === 'win32')(
    'launches the actual helper through the production ProcessStartInfo -File path without stderr',
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'compos a toast helper '))
      const copiedDriver = join(temporaryRoot, 'classic helper driver.ps1')
      try {
        await copyFile(
          resolve('src/core/captivate/classic-11.8.4-driver.ps1'),
          copiedDriver
        )
        const probe = await runAccessibilityHelperThroughProcessStartInfo(copiedDriver)

        expect(probe.launcher.exitCode).toBe(0)
        expect(probe.launcher.stderr).toBe('')
        expect(probe.helper).toBeDefined()
        expect(probe.helper).toMatchObject({ exitCode: 0, stderr: '', contained: true })
        const responseLines = probe.helper!.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        expect(responseLines).toHaveLength(1)
        expect(JSON.parse(responseLines[0]!)).toMatchObject({
          SchemaVersion: 1,
          Mode: 'evidence',
          Ok: false,
          Code: 'EVIDENCE_DIALOG_REJECTED',
          Clicked: false
        })
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.runIf(process.platform === 'win32')(
    'atomically contains helper descendants in the kill-on-parent-close Windows job',
    async () => {
      const execution = await runHelperJobInheritanceProbe()

      expect(execution.exitCode).toBe(0)
      expect(execution.stderr).toBe('')
      const helperProcessId = Number(execution.stdout.trim())
      expect(Number.isSafeInteger(helperProcessId) && helperProcessId > 0).toBe(true)
      expect(await waitForExactProcessExit(helperProcessId, 2_000)).toBe(true)
    },
    30_000
  )

  it.runIf(process.platform === 'win32')(
    'rejects a private accessibility invocation whose parent driver hash does not match',
    async () => {
      const execution = await runAccessibilityHelperWithInvalidWindow('0'.repeat(64))
      const response = JSON.parse(execution.stdout.trim()) as Record<string, unknown>

      expect(execution.exitCode).toBe(1)
      expect(execution.stderr).toBe('')
      expect(response).toMatchObject({
        SchemaVersion: 1,
        Mode: 'evidence',
        Ok: false,
        Code: 'HELPER_BOOTSTRAP_FAILED',
        Clicked: false
      })
      expect(response.Error).toMatch(/did not match the parent driver startup hash/i)
    },
    20_000
  )
})
