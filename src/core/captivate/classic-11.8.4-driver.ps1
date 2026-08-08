#Requires -Version 5.1

<#
.SYNOPSIS
Version-pinned Adobe Captivate Classic 11.8.4.21 UI-automation driver.

.DESCRIPTION
Accepts one UTF-8 JSON job file and writes newline-delimited JSON (NDJSON) to stdout.
Progress records have type "progress" and exactly one terminal record has type "result".

This driver is intentionally narrow. It supports only the live-qualified 1280 x 696
DPI-unaware logical coordinate profile on a 150% primary display and Captivate Classic
build 11.8.4.21. It refuses unknown UI states instead of trying alternate coordinates,
dialog buttons, or keyboard sequences.

Job schema version 1:
{
  "schemaVersion": 1,
  "mode": "verify" | "export",
  "executablePath": "C:\\...\\AdobeCaptivateClassic.exe",
  "seedCptxPath": "C:\\...\\seed.cptx",
  "outputCptxPath": "C:\\...\\course.cptx",
  "expectedSeedSha256": "qualified 64-hex SHA-256",
  "slides": [
    { "title": "required", "subtitle": "required for the first slide" },
    { "title": "required" }
  ]
}

The caller must run this script in an unlocked, dedicated interactive desktop and must
not use the mouse or keyboard while export mode is active.
#>

[CmdletBinding(DefaultParameterSetName = 'Driver')]
param(
  [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Driver')]
  [ValidateNotNullOrEmpty()]
  [string]$JobPath,

  [Parameter(Mandatory = $true, ParameterSetName = 'AccessibilityHelper')]
  [ValidateSet('evidence', 'save', 'strings')]
  [string]$AccessibilityHelperMode,

  [Parameter(Mandatory = $true, ParameterSetName = 'AccessibilityHelper')]
  [ValidateNotNullOrEmpty()]
  [ValidateLength(1, 262144)]
  [string]$AccessibilityPayload,

  [Parameter(Mandatory = $true, ParameterSetName = 'AccessibilityHelper')]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$AccessibilityExpectedDriverSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:DriverScriptPath = [IO.Path]::GetFullPath($PSCommandPath)
$script:DriverStartupSha256 = (Get-FileHash -LiteralPath $script:DriverScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()

$script:DriverSchemaVersion = 1
$script:DriverProfile = 'classic-11.8.4.21-primary150-unaware-1280x696-v3'
$script:ExpectedCaptivateVersion = '11.8.4.21'
$script:QualifiedSeedSha256 = 'b7869c12cc6ea006d96a19592db69425bc3c51f18245f008aa1013c7949ce60b'
$script:ExpectedWorkingWidth = 1280
$script:ExpectedWorkingHeight = 696
$script:ExpectedPrimaryScalePercent = 150
$script:PrimaryScalePercent = $null
$script:Stage = 'startup'
$script:Mode = 'unknown'
$script:FailureCode = 'UNHANDLED_DRIVER_ERROR'
$script:StartedAt = [DateTimeOffset]::UtcNow
$script:Audit = New-Object 'System.Collections.Generic.List[object]'
$script:ProcessIds = New-Object 'System.Collections.Generic.List[int]'
$script:OwnedProcess = $null
$script:StagingRoot = $null
$script:StagingCptxPath = $null
$script:StagingXmlPath = $null
$script:OutputPromoted = $false
$script:ConfirmedProcessExit = $true
$script:SeedPath = $null
$script:SeedHashBefore = $null
$script:ExecutableAttestation = $null
$script:RequestedSlides = @()
$script:LicensingHandoffActive = $false
$script:AccessibilityEvidenceTimeoutMilliseconds = 4000
$script:AccessibilityStringsTimeoutMilliseconds = 6000
$script:AccessibilitySaveTimeoutMilliseconds = 7000
$script:AccessibilityHelperTerminationUnconfirmed = $false
$script:AccessibilityHelperProcessId = $null

function ConvertTo-DriverJson {
  param([Parameter(Mandatory = $true)]$Value)
  return ($Value | ConvertTo-Json -Depth 12 -Compress)
}

function Write-DriverEvent {
  param([Parameter(Mandatory = $true)]$Value)
  [Console]::Out.WriteLine((ConvertTo-DriverJson -Value $Value))
  [Console]::Out.Flush()
}

function Add-AuditRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $record = [ordered]@{
    stage = $Stage
    timestamp = [DateTimeOffset]::UtcNow.ToString('o')
    message = $Message
  }
  $script:Audit.Add($record)
}

function Set-DriverStage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $script:Stage = $Name
  Add-AuditRecord -Stage $Name -Message $Message
  Write-DriverEvent ([ordered]@{
      type = 'progress'
      schemaVersion = $script:DriverSchemaVersion
      mode = $script:Mode
      stage = $Name
      timestamp = [DateTimeOffset]::UtcNow.ToString('o')
      message = $Message
    })
}

function Stop-Driver {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $script:FailureCode = $Code
  throw [System.InvalidOperationException]::new($Message)
}

function Assert-Condition {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { Stop-Driver -Code $Code -Message $Message }
}

function Get-NormalizedWhitespace {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value) { return '' }
  return ([regex]::Replace($Value, '\s+', ' ')).Trim()
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-RegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-Condition -Condition ([IO.Path]::IsPathRooted($LiteralPath)) -Code $Code -Message "$Label must be an absolute path."
  Assert-Condition -Condition (Test-Path -LiteralPath $LiteralPath -PathType Leaf) -Code $Code -Message "$Label is not a regular file: $LiteralPath"
  $item = Get-Item -LiteralPath $LiteralPath -Force
  Assert-Condition -Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -Code $Code -Message "$Label may not be a symbolic link or reparse point."
  return $item.FullName
}

function Resolve-ExistingDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-Condition -Condition ([IO.Path]::IsPathRooted($LiteralPath)) -Code $Code -Message "$Label must be an absolute path."
  Assert-Condition -Condition (Test-Path -LiteralPath $LiteralPath -PathType Container) -Code $Code -Message "$Label does not exist: $LiteralPath"
  $item = Get-Item -LiteralPath $LiteralPath -Force
  Assert-Condition -Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -Code $Code -Message "$Label may not be a symbolic link or reparse point."
  return $item.FullName
}

function Get-PropertyValue {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    $Default = $null
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Assert-NoCaptivateProcess {
  $running = @(Get-Process -Name 'AdobeCaptivateClassic' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $identifiers = ($running | ForEach-Object { $_.Id }) -join ', '
    Stop-Driver -Code 'CAPTIVATE_ALREADY_RUNNING' -Message "Refusing to automate while AdobeCaptivateClassic is already running (PID: $identifiers)."
  }
}

function Test-ExpectedSeedHash {
  param([AllowNull()][string]$Expected, [Parameter(Mandatory = $true)][string]$Actual)
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($Expected)) -Code 'MISSING_SEED_HASH' -Message 'expectedSeedSha256 is required for the qualified seed profile.'
  Assert-Condition -Condition ($Expected -match '^[a-fA-F0-9]{64}$') -Code 'INVALID_SEED_HASH' -Message 'expectedSeedSha256 must contain exactly 64 hexadecimal characters.'
  Assert-Condition -Condition ($Expected.ToLowerInvariant() -eq $script:QualifiedSeedSha256) -Code 'UNQUALIFIED_SEED_HASH' -Message 'expectedSeedSha256 does not identify the one qualified Captivate Classic 11.8.4.21 seed.'
  Assert-Condition -Condition ($Expected.ToLowerInvariant() -eq $Actual) -Code 'SEED_HASH_MISMATCH' -Message 'The seed CPTX SHA-256 does not match expectedSeedSha256.'
}

function Get-CaptivateAttestation {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)
  $item = Get-Item -LiteralPath $ExecutablePath -Force
  Assert-Condition -Condition ($item.Name -ieq 'AdobeCaptivateClassic.exe') -Code 'UNEXPECTED_EXECUTABLE_NAME' -Message 'This driver accepts only AdobeCaptivateClassic.exe.'

  $versionCandidates = @($item.VersionInfo.FileVersion, $item.VersionInfo.ProductVersion)
  $version = $null
  foreach ($candidate in $versionCandidates) {
    if ($candidate -and $candidate -match '(?:^|[^\d.])(\d+(?:\.\d+){3})(?![\d.]|\.\d)') {
      $version = $Matches[1]
      break
    }
  }
  Assert-Condition -Condition ($version -eq $script:ExpectedCaptivateVersion) -Code 'UNSUPPORTED_CAPTIVATE_BUILD' -Message "This profile requires Captivate Classic $($script:ExpectedCaptivateVersion); detected $version."
  Assert-Condition -Condition ($item.VersionInfo.ProductName -match '(?i)Captivate\s+Classic') -Code 'UNEXPECTED_CAPTIVATE_PRODUCT' -Message 'The executable product name is not Adobe Captivate Classic.'

  $signature = Get-AuthenticodeSignature -LiteralPath $ExecutablePath
  Assert-Condition -Condition ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) -Code 'INVALID_CAPTIVATE_SIGNATURE' -Message 'AdobeCaptivateClassic.exe does not have a valid Authenticode signature.'
  $publisher = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
  Assert-Condition -Condition ($publisher -match '(?i)(?:^|,\s*)O="?Adobe Inc\.?"?(?:,|$)') -Code 'UNEXPECTED_CAPTIVATE_PUBLISHER' -Message 'AdobeCaptivateClassic.exe is not signed by Adobe Inc.'

  return [ordered]@{
    path = $ExecutablePath
    version = $version
    productName = $item.VersionInfo.ProductName
    publisher = $publisher
    sha256 = Get-Sha256 -LiteralPath $ExecutablePath
  }
}

function Assert-TextValue {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $normalized = Get-NormalizedWhitespace -Value $Value
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($normalized)) -Code $Code -Message "$Label may not be empty."
  Assert-Condition -Condition ($Value.Length -le 512) -Code $Code -Message "$Label exceeds the 512-character safety limit."
  Assert-Condition -Condition ($Value -notmatch '[\x00-\x1F\x7F]') -Code $Code -Message "$Label contains unsupported control characters."
}

function Get-ValidatedSlides {
  param([Parameter(Mandatory = $true)]$Job)
  $slidesValue = Get-PropertyValue -Object $Job -Name 'slides'
  Assert-Condition -Condition ($null -ne $slidesValue) -Code 'MISSING_SLIDES' -Message 'Export jobs require a slides array.'
  $slides = @($slidesValue)
  Assert-Condition -Condition ($slides.Count -ge 1 -and $slides.Count -le 200) -Code 'INVALID_SLIDE_COUNT' -Message 'Export jobs require between 1 and 200 slides.'

  $validated = New-Object 'System.Collections.Generic.List[object]'
  for ($index = 0; $index -lt $slides.Count; $index++) {
    $slide = $slides[$index]
    $title = [string](Get-PropertyValue -Object $slide -Name 'title' -Default '')
    Assert-TextValue -Value $title -Code 'INVALID_SLIDE_TITLE' -Label "slides[$index].title"
    $subtitle = [string](Get-PropertyValue -Object $slide -Name 'subtitle' -Default '')
    if ($index -eq 0) {
      Assert-TextValue -Value $subtitle -Code 'INVALID_TITLE_SLIDE_SUBTITLE' -Label 'slides[0].subtitle'
    } elseif (-not [string]::IsNullOrEmpty($subtitle)) {
      Assert-TextValue -Value $subtitle -Code 'INVALID_SLIDE_SUBTITLE' -Label "slides[$index].subtitle"
    }
    $validated.Add([ordered]@{ title = $title; subtitle = $subtitle })
  }
  return $validated.ToArray()
}

# MSAA is synchronous cross-process COM and has no caller-supplied timeout. The
# production driver therefore never loads or calls it in-process. Each query is
# delegated to a private invocation of this same hash-pinned script; the parent
# PowerShell process enforces the deadline and can terminate only that helper.
$script:AccessibilityHelperSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Accessibility;

public sealed class CatAccessibilityRequest
{
    public string Mode { get; set; }
    public int ProcessId { get; set; }
    public long DialogHwnd { get; set; }
    public long OwnerHwnd { get; set; }
    public long EditHwnd { get; set; }
    public int EditControlId { get; set; }
    public long SaveHwnd { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public string ExpectedName { get; set; }
    public string ExpectedValue { get; set; }
    public int ExpectedRole { get; set; }
    public uint ExpectedState { get; set; }
    public string TargetPath { get; set; }
}

public sealed class CatAccessibilityEvidence
{
    public bool Available { get; set; }
    public string Name { get; set; }
    public string Value { get; set; }
    public int Role { get; set; }
    public uint State { get; set; }
    public string Error { get; set; }
}

public sealed class CatAccessibilityResponse
{
    public int SchemaVersion { get; set; }
    public string Mode { get; set; }
    public bool Ok { get; set; }
    public string Code { get; set; }
    public string Error { get; set; }
    public bool Clicked { get; set; }
    public CatAccessibilityEvidence Evidence { get; set; }
    public string[] Strings { get; set; }
}

public static class CatAccessibilityHelper
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr control);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="SendMessageTimeoutW")] private static extern IntPtr SendMessageTimeoutText(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [In, Out, MarshalAs(UnmanagedType.IUnknown)] ref object result);
    [DllImport("oleacc.dll")] private static extern int AccessibleChildren(IAccessible container, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);

    private const uint GW_OWNER = 4;
    private const uint GA_ROOT = 2;
    private const uint OBJID_CLIENT = 0xFFFFFFFC;
    private const uint WM_GETTEXT = 0x000D;
    private const uint BM_CLICK = 0x00F5;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint SMTO_ERRORONEXIT = 0x0020;
    private const int MaxAccessibleDepth = 18;
    private const int MaxAccessibleChildren = 10000;
    private const int MaxStrings = 128;
    private const int MaxStringLength = 512;

    public static string Execute(string declaredMode, string payload)
    {
        JavaScriptSerializer serializer = NewSerializer();
        CatAccessibilityResponse response = NewResponse(declaredMode);
        try {
            if (String.IsNullOrEmpty(payload) || payload.Length > 262144) {
                return SerializeFailure(serializer, response, "INVALID_PAYLOAD", "The accessibility payload was empty or oversized.");
            }
            string json = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
            if (json.Length == 0 || json.Length > 131072) {
                return SerializeFailure(serializer, response, "INVALID_PAYLOAD", "The decoded accessibility payload was empty or oversized.");
            }
            CatAccessibilityRequest request = serializer.Deserialize<CatAccessibilityRequest>(json);
            if (request == null || !String.Equals(request.Mode, declaredMode, StringComparison.Ordinal)) {
                return SerializeFailure(serializer, response, "INVALID_MODE", "The declared accessibility mode did not match the request.");
            }

            if (String.Equals(declaredMode, "evidence", StringComparison.Ordinal)) {
                ExecuteEvidence(request, response);
            } else if (String.Equals(declaredMode, "save", StringComparison.Ordinal)) {
                ExecuteSave(request, response);
            } else if (String.Equals(declaredMode, "strings", StringComparison.Ordinal)) {
                ExecuteStrings(request, response);
            } else {
                return SerializeFailure(serializer, response, "INVALID_MODE", "The accessibility mode is unsupported.");
            }
        } catch (Exception error) {
            response.Ok = false;
            response.Code = "HELPER_EXCEPTION";
            response.Error = SafeError(error);
        }
        return serializer.Serialize(response);
    }

    private static JavaScriptSerializer NewSerializer()
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 262144;
        serializer.RecursionLimit = 24;
        return serializer;
    }

    private static CatAccessibilityResponse NewResponse(string mode)
    {
        return new CatAccessibilityResponse {
            SchemaVersion = 1,
            Mode = mode ?? "",
            Ok = false,
            Code = "",
            Error = "",
            Clicked = false,
            Evidence = null,
            Strings = new string[0]
        };
    }

    private static string SerializeFailure(JavaScriptSerializer serializer, CatAccessibilityResponse response, string code, string error)
    {
        response.Ok = false;
        response.Code = code;
        response.Error = Limit(error, 1024);
        return serializer.Serialize(response);
    }

    private static void Fail(CatAccessibilityResponse response, string code, string error)
    {
        response.Ok = false;
        response.Code = code;
        response.Error = Limit(error, 1024);
    }

    private static void ExecuteEvidence(CatAccessibilityRequest request, CatAccessibilityResponse response)
    {
        string error;
        if (!ValidateSaveDialog(request, out error)) {
            Fail(response, "EVIDENCE_DIALOG_REJECTED", error);
            return;
        }
        if (!ValidateEdit(request, out error)) {
            Fail(response, "EVIDENCE_EDIT_REJECTED", error);
            return;
        }
        response.Evidence = ReadEvidence(new IntPtr(request.EditHwnd));
        response.Ok = true;
    }

    private static void ExecuteSave(CatAccessibilityRequest request, CatAccessibilityResponse response)
    {
        string error;
        if (!ValidateSaveDialog(request, out error)) {
            Fail(response, "SAVE_DIALOG_REJECTED", error);
            return;
        }
        if (!ValidateEdit(request, out error)) {
            Fail(response, "SAVE_EDIT_REJECTED", error);
            return;
        }
        if (!ValidateSaveButton(request, out error)) {
            Fail(response, "SAVE_BUTTON_REJECTED", error);
            return;
        }
        if (String.IsNullOrEmpty(request.TargetPath) || !Path.IsPathRooted(request.TargetPath) ||
            !String.Equals(request.TargetPath, request.ExpectedValue, StringComparison.Ordinal)) {
            Fail(response, "SAVE_TARGET_REJECTED", "The exact absolute Save target did not match the expected accessibility value.");
            return;
        }

        CatAccessibilityEvidence evidence = ReadEvidence(new IntPtr(request.EditHwnd));
        response.Evidence = evidence;
        if (!evidence.Available ||
            !String.Equals(evidence.Name, request.ExpectedName, StringComparison.Ordinal) ||
            !String.Equals(evidence.Value, request.ExpectedValue, StringComparison.Ordinal) ||
            evidence.Role != request.ExpectedRole || evidence.State != request.ExpectedState) {
            Fail(response, "SAVE_EVIDENCE_REJECTED", "The exact filename accessibility name, value, role, or state changed before Save.");
            return;
        }
        if (!ValidateSaveDialog(request, out error)) {
            Fail(response, "SAVE_DIALOG_CHANGED_AFTER_EVIDENCE", error);
            return;
        }
        if (!ValidateEdit(request, out error)) {
            Fail(response, "SAVE_EDIT_CHANGED_AFTER_EVIDENCE", error);
            return;
        }
        if (!ValidateSaveButton(request, out error)) {
            Fail(response, "SAVE_BUTTON_CHANGED_AFTER_EVIDENCE", error);
            return;
        }
        if (File.Exists(request.TargetPath) || Directory.Exists(request.TargetPath)) {
            Fail(response, "SAVE_TARGET_EXISTS", "The exact Save target appeared before the button action.");
            return;
        }

        IntPtr messageResult;
        IntPtr call = SendMessageTimeout(
            new IntPtr(request.SaveHwnd),
            BM_CLICK,
            IntPtr.Zero,
            IntPtr.Zero,
            SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            2000,
            out messageResult
        );
        if (call == IntPtr.Zero) {
            Fail(response, "SAVE_CLICK_TIMEOUT", "The exact Save button did not accept bounded BM_CLICK.");
            return;
        }
        response.Clicked = true;
        response.Ok = true;
    }

    private static void ExecuteStrings(CatAccessibilityRequest request, CatAccessibilityResponse response)
    {
        string error;
        if (!ValidateSuccessDialog(request, out error)) {
            Fail(response, "STRINGS_DIALOG_REJECTED", error);
            return;
        }
        IAccessible accessible;
        if (!TryAccessibleRoot(new IntPtr(request.DialogHwnd), out accessible)) {
            response.Strings = new string[0];
            response.Ok = true;
            return;
        }
        List<string> strings = new List<string>();
        try {
            WalkAccessible(accessible, 0, 0, new HashSet<IntPtr>(), strings);
        } finally {
            ReleaseComObject(accessible);
        }
        response.Strings = strings.ToArray();
        response.Ok = true;
    }

    private static bool ValidateSaveDialog(CatAccessibilityRequest request, out string error)
    {
        IntPtr dialog = new IntPtr(request.DialogHwnd);
        error = "The exact Save As dialog identity or profile changed.";
        if (request.ProcessId <= 0 || request.DialogHwnd == 0 || request.OwnerHwnd == 0 || !IsWindow(dialog)) return false;
        if (ProcessIdFor(dialog) != request.ProcessId || !IsWindowVisible(dialog) || !IsWindowEnabled(dialog)) return false;
        if (!String.Equals(WindowClass(dialog), "#32770", StringComparison.Ordinal) ||
            !String.Equals(WindowText(dialog), "Save As", StringComparison.Ordinal)) return false;
        RECT rect;
        if (!GetWindowRect(dialog, out rect) || rect.Left != request.Left || rect.Top != request.Top ||
            rect.Right - rect.Left != request.Width || rect.Bottom - rect.Top != request.Height) return false;
        if (GetWindow(dialog, GW_OWNER).ToInt64() != request.OwnerHwnd || GetAncestor(dialog, GA_ROOT) != dialog) return false;
        return true;
    }

    private static bool ValidateSuccessDialog(CatAccessibilityRequest request, out string error)
    {
        IntPtr dialog = new IntPtr(request.DialogHwnd);
        error = "The exact XML success dialog identity changed.";
        if (request.ProcessId <= 0 || request.DialogHwnd == 0 || !IsWindow(dialog)) return false;
        if (ProcessIdFor(dialog) != request.ProcessId || !IsWindowVisible(dialog) || !IsWindowEnabled(dialog)) return false;
        if (!String.Equals(WindowClass(dialog), "#32770", StringComparison.Ordinal) ||
            !String.Equals(WindowText(dialog), "Adobe Captivate", StringComparison.Ordinal) ||
            GetAncestor(dialog, GA_ROOT) != dialog) return false;
        return true;
    }

    private static bool ValidateEdit(CatAccessibilityRequest request, out string error)
    {
        IntPtr edit = new IntPtr(request.EditHwnd);
        error = "The exact filename Edit identity changed.";
        if (request.EditHwnd == 0 || !IsWindow(edit) || ProcessIdFor(edit) != request.ProcessId ||
            !IsWindowVisible(edit) || !IsWindowEnabled(edit)) return false;
        if (!String.Equals(WindowClass(edit), "Edit", StringComparison.Ordinal) ||
            (request.EditControlId != 1001 && request.EditControlId != 1148) ||
            GetDlgCtrlID(edit) != request.EditControlId ||
            GetAncestor(edit, GA_ROOT).ToInt64() != request.DialogHwnd) return false;
        return true;
    }

    private static bool ValidateSaveButton(CatAccessibilityRequest request, out string error)
    {
        IntPtr button = new IntPtr(request.SaveHwnd);
        error = "The exact Save button identity changed.";
        if (request.SaveHwnd == 0 || !IsWindow(button) || ProcessIdFor(button) != request.ProcessId ||
            !IsWindowVisible(button) || !IsWindowEnabled(button)) return false;
        if (!String.Equals(WindowClass(button), "Button", StringComparison.Ordinal) ||
            !String.Equals(WindowText(button), "&Save", StringComparison.Ordinal) ||
            GetDlgCtrlID(button) != 1 || GetAncestor(button, GA_ROOT).ToInt64() != request.DialogHwnd) return false;
        return true;
    }

    private static CatAccessibilityEvidence ReadEvidence(IntPtr hwnd)
    {
        CatAccessibilityEvidence evidence = new CatAccessibilityEvidence {
            Available = false, Name = "", Value = "", Role = 0, State = 0, Error = ""
        };
        IAccessible accessible;
        if (!TryAccessibleRoot(hwnd, out accessible)) {
            evidence.Error = "The window did not expose an MSAA client object.";
            return evidence;
        }
        try {
            evidence.Name = accessible.get_accName(0) ?? "";
            evidence.Value = accessible.get_accValue(0) ?? "";
            evidence.Role = Convert.ToInt32(accessible.get_accRole(0));
            evidence.State = Convert.ToUInt32(accessible.get_accState(0));
            evidence.Available = true;
        } catch (Exception error) {
            evidence.Error = SafeError(error);
        } finally {
            ReleaseComObject(accessible);
        }
        return evidence;
    }

    private static bool TryAccessibleRoot(IntPtr hwnd, out IAccessible accessible)
    {
        accessible = null;
        object value = null;
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        int result = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, ref value);
        if (result < 0 || value == null) return false;
        accessible = value as IAccessible;
        return accessible != null;
    }

    private static void WalkAccessible(IAccessible accessible, object childId, int depth, HashSet<IntPtr> seen, List<string> strings)
    {
        if (depth > MaxAccessibleDepth || strings.Count >= MaxStrings) return;
        AddString(strings, SafeString(delegate { return accessible.get_accName(childId); }));
        AddString(strings, SafeString(delegate { return accessible.get_accValue(childId); }));
        AddString(strings, SafeString(delegate { return accessible.get_accDescription(childId); }));
        if (!Object.Equals(childId, 0) || strings.Count >= MaxStrings) return;

        int count = SafeInt(delegate { return accessible.accChildCount; });
        if (count <= 0 || count > MaxAccessibleChildren) return;
        object[] children = new object[count];
        int obtained = 0;
        try { AccessibleChildren(accessible, 0, count, children, out obtained); }
        catch { return; }
        if (obtained < 0 || obtained > count) return;

        for (int index = 0; index < obtained && strings.Count < MaxStrings; index++) {
            object child = children[index];
            if (child is int) {
                WalkAccessible(accessible, child, depth + 1, seen, strings);
                continue;
            }
            IAccessible childAccessible = child as IAccessible;
            if (childAccessible == null) continue;
            IntPtr identity = IntPtr.Zero;
            try {
                identity = Marshal.GetIUnknownForObject(childAccessible);
                if (seen.Add(identity)) WalkAccessible(childAccessible, 0, depth + 1, seen, strings);
            } finally {
                if (identity != IntPtr.Zero) Marshal.Release(identity);
            }
        }
    }

    private static void AddString(List<string> strings, string value)
    {
        if (strings.Count >= MaxStrings || String.IsNullOrWhiteSpace(value)) return;
        strings.Add(Limit(value, MaxStringLength));
    }

    private static string SafeString(Func<string> call)
    {
        try { return call() ?? ""; }
        catch { return ""; }
    }

    private static int SafeInt(Func<int> call)
    {
        try { return call(); }
        catch { return 0; }
    }

    private static void ReleaseComObject(object value)
    {
        try {
            if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        } catch { }
    }

    private static int ProcessIdFor(IntPtr hwnd)
    {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        return (int)processId;
    }

    private static string WindowClass(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(512);
        if (GetClassName(hwnd, value, value.Capacity) <= 0) return "";
        return value.ToString();
    }

    private static string WindowText(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(2048);
        IntPtr result;
        IntPtr call = SendMessageTimeoutText(
            hwnd,
            WM_GETTEXT,
            new IntPtr(value.Capacity),
            value,
            SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            1000,
            out result
        );
        return call == IntPtr.Zero ? null : value.ToString();
    }

    private static string SafeError(Exception error)
    {
        if (error == null) return "Unknown accessibility helper error.";
        return Limit(error.GetType().Name + ": " + error.Message, 1024);
    }

    private static string Limit(string value, int maximum)
    {
        if (String.IsNullOrEmpty(value)) return "";
        return value.Length <= maximum ? value : value.Substring(0, maximum);
    }
}
'@

if ($PSCmdlet.ParameterSetName -eq 'AccessibilityHelper') {
  try {
    if ($script:DriverStartupSha256 -cne $AccessibilityExpectedDriverSha256.ToLowerInvariant()) {
      throw [InvalidOperationException]::new('The accessibility helper script bytes did not match the parent driver startup hash.')
    }
    Add-Type -ReferencedAssemblies @('Accessibility', 'System.Web.Extensions') -TypeDefinition $script:AccessibilityHelperSource | Out-Null
    $helperResponse = [CatAccessibilityHelper]::Execute($AccessibilityHelperMode, $AccessibilityPayload)
    if ([string]::IsNullOrWhiteSpace($helperResponse) -or $helperResponse.Length -gt 262144) {
      throw [InvalidOperationException]::new('The accessibility helper produced an empty or oversized response.')
    }
    [Console]::Out.WriteLine($helperResponse)
    [Console]::Out.Flush()
    exit 0
  } catch {
    $helperFailure = [ordered]@{
      SchemaVersion = 1
      Mode = $AccessibilityHelperMode
      Ok = $false
      Code = 'HELPER_BOOTSTRAP_FAILED'
      Error = $_.Exception.Message
      Clicked = $false
      Evidence = $null
      Strings = @()
    }
    [Console]::Out.WriteLine((ConvertTo-DriverJson -Value $helperFailure))
    [Console]::Out.Flush()
    exit 1
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CatWindowInfo
{
    public long Hwnd;
    public int ProcessId;
    public string ClassName;
    public string Text;
    public bool Visible;
    public bool Enabled;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
    public long Owner;
}

public sealed class CatMenuItemInfo
{
    public int Position;
    public uint Id;
    public string Text;
    public uint State;
    public bool HasSubmenu;
}

public static class CatNative
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetPhysicalCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPhysicalPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(POINT point, uint flags);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr control);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="SendMessageTimeoutW")] private static extern IntPtr SendMessageTimeoutText(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern bool IsMenu(IntPtr menu);
    [DllImport("user32.dll")] private static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] private static extern uint GetMenuItemID(IntPtr menu, int position);
    [DllImport("user32.dll")] private static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("user32.dll")] private static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int maxCount, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMenuItemRect(IntPtr hwnd, IntPtr menu, uint item, out RECT rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr ignored);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
    [DllImport("shcore.dll")] private static extern int GetProcessDpiAwareness(IntPtr process, out int awareness);
    [DllImport("shcore.dll")] private static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetFocus();
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    private const uint GW_OWNER = 4;
    private const uint GA_ROOT = 2;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint SMTO_ERRORONEXIT = 0x0020;
    private const uint MONITOR_DEFAULTTOPRIMARY = 0x00000001;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_GETTEXT = 0x000D;
    private const uint BM_CLICK = 0x00F5;
    private const uint MN_GETHMENU = 0x01E1;
    private const uint MF_BYPOSITION = 0x0400;
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private static readonly object HelperJobLock = new object();
    private static IntPtr HelperJob = IntPtr.Zero;

    public static bool EnsureHelperKillOnParentCloseJob()
    {
        lock (HelperJobLock) {
            if (HelperJob != IntPtr.Zero) return true;
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return false;
            IntPtr information = IntPtr.Zero;
            try {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int informationSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                information = Marshal.AllocHGlobal(informationSize);
                Marshal.StructureToPtr(limits, information, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, information, (uint)informationSize)) {
                    CloseHandle(job);
                    return false;
                }
                // Captivate is already running before this is called. Joining only the
                // driver makes subsequently created accessibility helpers inherit this
                // kill-on-close job atomically without adding Captivate to the job.
                if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
                    CloseHandle(job);
                    return false;
                }
                HelperJob = job;
                return true;
            } finally {
                if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
            }
        }
    }

    public static bool IsProcessInHelperJob(IntPtr process)
    {
        if (process == IntPtr.Zero || HelperJob == IntPtr.Zero) return false;
        bool result;
        return IsProcessInJob(process, HelperJob, out result) && result;
    }

    private static string WindowText(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(2048);
        IntPtr result;
        IntPtr call = SendMessageTimeoutText(hwnd, WM_GETTEXT, new IntPtr(value.Capacity), value, SMTO_ABORTIFHUNG, 1000, out result);
        if (call == IntPtr.Zero) return "";
        return value.ToString();
    }

    private static string WindowClass(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(512);
        GetClassName(hwnd, value, value.Capacity);
        return value.ToString();
    }

    private static CatWindowInfo DescribeWithoutText(IntPtr hwnd)
    {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        RECT rect;
        GetWindowRect(hwnd, out rect);
        return new CatWindowInfo {
            Hwnd = hwnd.ToInt64(), ProcessId = (int)processId,
            ClassName = WindowClass(hwnd), Text = String.Empty,
            Visible = IsWindowVisible(hwnd), Enabled = IsWindowEnabled(hwnd),
            Left = rect.Left, Top = rect.Top, Width = rect.Right - rect.Left,
            Height = rect.Bottom - rect.Top, Owner = GetWindow(hwnd, GW_OWNER).ToInt64()
        };
    }

    private static CatWindowInfo Describe(IntPtr hwnd)
    {
        CatWindowInfo value = DescribeWithoutText(hwnd);
        value.Text = WindowText(hwnd);
        return value;
    }

    public static CatWindowInfo DescribeWindow(long hwnd) { return Describe(new IntPtr(hwnd)); }
    public static CatWindowInfo DescribeWindowWithoutText(long hwnd) { return DescribeWithoutText(new IntPtr(hwnd)); }

    public static CatWindowInfo[] TopWindowsForProcess(int processId, bool visibleOnly)
    {
        List<CatWindowInfo> values = new List<CatWindowInfo>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            uint ownerPid; GetWindowThreadProcessId(hwnd, out ownerPid);
            if (ownerPid == (uint)processId && (!visibleOnly || IsWindowVisible(hwnd))) values.Add(Describe(hwnd));
            return true;
        }, IntPtr.Zero);
        return values.ToArray();
    }

    public static CatWindowInfo[] AllWindowsForProcess(int processId, bool visibleOnly)
    {
        List<CatWindowInfo> values = new List<CatWindowInfo>();
        EnumWindows(delegate(IntPtr top, IntPtr ignored) {
            uint topPid; GetWindowThreadProcessId(top, out topPid);
            if (topPid != (uint)processId) return true;
            if (!visibleOnly || IsWindowVisible(top)) values.Add(Describe(top));
            EnumChildWindows(top, delegate(IntPtr child, IntPtr childIgnored) {
                uint childPid; GetWindowThreadProcessId(child, out childPid);
                if (childPid == (uint)processId && (!visibleOnly || IsWindowVisible(child))) values.Add(Describe(child));
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return values.ToArray();
    }

    public static long RootWindow(long hwnd) { return GetAncestor(new IntPtr(hwnd), GA_ROOT).ToInt64(); }
    public static CatWindowInfo FocusedWindowForThread(long hwnd)
    {
        uint threadId = GetWindowThreadProcessId(new IntPtr(hwnd), IntPtr.Zero);
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (threadId == 0 || !GetGUIThreadInfo(threadId, ref info) || info.hwndFocus == IntPtr.Zero) return null;
        return Describe(info.hwndFocus);
    }
    public static uint CoordinateSpaceDpi() { return GetDpiForSystem(); }
    public static int PrimaryMonitorScalePercent()
    {
        POINT origin = new POINT { X = 0, Y = 0 };
        IntPtr monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
        if (monitor == IntPtr.Zero) throw new InvalidOperationException("MonitorFromPoint did not return the primary monitor.");
        int scale;
        int result = GetScaleFactorForMonitor(monitor, out scale);
        if (result != 0) throw new InvalidOperationException("GetScaleFactorForMonitor failed: " + result);
        return scale;
    }
    public static int CurrentProcessDpiAwareness()
    {
        int awareness; int result = GetProcessDpiAwareness(GetCurrentProcess(), out awareness);
        if (result != 0) throw new InvalidOperationException("GetProcessDpiAwareness failed: " + result);
        return awareness;
    }
    public static bool ApplyQualifiedWindowProfile(long hwnd, int width, int height)
    {
        IntPtr target = new IntPtr(hwnd);
        ShowWindow(target, 9);
        return MoveWindow(target, 0, 0, width, height, true);
    }

    public static bool BringToForeground(long hwnd)
    {
        IntPtr target = new IntPtr(hwnd);
        if (!IsWindow(target)) return false;
        IntPtr foreground = GetForegroundWindow();
        uint currentThread = GetCurrentThreadId();
        uint targetThread = GetWindowThreadProcessId(target, IntPtr.Zero);
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
        bool attachedTarget = false;
        bool attachedForeground = false;
        try {
            if (targetThread != 0 && targetThread != currentThread) attachedTarget = AttachThreadInput(currentThread, targetThread, true);
            if (foregroundThread != 0 && foregroundThread != currentThread && foregroundThread != targetThread) attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
            ShowWindow(target, 9);
            SetForegroundWindow(target);
            SetFocus(target);
            IntPtr actual = GetForegroundWindow();
            return actual == target || GetAncestor(actual, GA_ROOT) == target;
        } finally {
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        }
    }

    public static bool FocusControl(long dialog, long control)
    {
        IntPtr dialogHandle = new IntPtr(dialog); IntPtr controlHandle = new IntPtr(control);
        uint targetThread = GetWindowThreadProcessId(controlHandle, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        try {
            if (targetThread != currentThread) attached = AttachThreadInput(currentThread, targetThread, true);
            SetForegroundWindow(dialogHandle);
            SetFocus(controlHandle);
            return GetForegroundWindow() == dialogHandle && GetFocus() == controlHandle;
        } finally {
            if (attached) AttachThreadInput(currentThread, targetThread, false);
        }
    }

    private static void SendMouseFlag(uint flag)
    {
        INPUT input = new INPUT(); input.type = INPUT_MOUSE; input.U.mi.dwFlags = flag;
        INPUT[] values = new INPUT[] { input };
        if (SendInput(1, values, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput mouse event failed.");
    }

    private static bool PositionCursorWithinTarget(int x, int y, long expectedRoot, string expectedClass)
    {
        if (!SetCursorPos(x, y)) return false;
        POINT cursor;
        if (!GetPhysicalCursorPos(out cursor) || cursor.X != x || cursor.Y != y) return false;
        IntPtr hit = WindowFromPhysicalPoint(cursor);
        if (hit == IntPtr.Zero || GetAncestor(hit, GA_ROOT).ToInt64() != expectedRoot) return false;
        return String.IsNullOrEmpty(expectedClass) || String.Equals(WindowClass(hit), expectedClass, StringComparison.Ordinal);
    }

    private static bool PositionCursorWithinRoot(int x, int y, long expectedRoot)
    {
        return PositionCursorWithinTarget(x, y, expectedRoot, null);
    }

    public static bool ClickWithinRoot(int x, int y, int count, long expectedRoot)
    {
        if (!PositionCursorWithinRoot(x, y, expectedRoot)) return false;
        for (int index = 0; index < count; index++) {
            SendMouseFlag(MOUSEEVENTF_LEFTDOWN); SendMouseFlag(MOUSEEVENTF_LEFTUP);
            if (index + 1 < count) System.Threading.Thread.Sleep(90);
        }
        return true;
    }

    public static bool ClickWithinRootAndClass(int x, int y, int count, long expectedRoot, string expectedClass)
    {
        if (!PositionCursorWithinTarget(x, y, expectedRoot, expectedClass)) return false;
        for (int index = 0; index < count; index++) {
            SendMouseFlag(MOUSEEVENTF_LEFTDOWN); SendMouseFlag(MOUSEEVENTF_LEFTUP);
            if (index + 1 < count) System.Threading.Thread.Sleep(90);
        }
        return true;
    }

    public static bool ClickWithinExactWindowProfile(int x, int y, int count, long expectedHwnd, int expectedProcessId, string expectedClass, string expectedText, int expectedLeft, int expectedTop, int expectedWidth, int expectedHeight, long expectedOwner)
    {
        IntPtr target = new IntPtr(expectedHwnd);
        if (!IsWindow(target)) return false;
        CatWindowInfo current = Describe(target);
        if (current.Hwnd != expectedHwnd || current.ProcessId != expectedProcessId || !current.Visible || !current.Enabled ||
            !String.Equals(current.ClassName, expectedClass, StringComparison.Ordinal) || !String.Equals(current.Text, expectedText, StringComparison.Ordinal) ||
            current.Left != expectedLeft || current.Top != expectedTop || current.Width != expectedWidth || current.Height != expectedHeight || current.Owner != expectedOwner) return false;
        if (!PositionCursorWithinTarget(x, y, expectedHwnd, expectedClass)) return false;
        for (int index = 0; index < count; index++) {
            SendMouseFlag(MOUSEEVENTF_LEFTDOWN); SendMouseFlag(MOUSEEVENTF_LEFTUP);
            if (index + 1 < count) System.Threading.Thread.Sleep(90);
        }
        return true;
    }

    public static bool RightClickWithinRootAndClass(int x, int y, long expectedRoot, string expectedClass)
    {
        if (!PositionCursorWithinTarget(x, y, expectedRoot, expectedClass)) return false;
        SendMouseFlag(MOUSEEVENTF_RIGHTDOWN); SendMouseFlag(MOUSEEVENTF_RIGHTUP);
        return true;
    }

    public static bool MoveCursorWithinRoot(int x, int y, long expectedRoot)
    {
        return PositionCursorWithinRoot(x, y, expectedRoot);
    }

    public static CatMenuItemInfo[] MenuItemsForPopup(long hwnd)
    {
        IntPtr menu;
        IntPtr call = SendMessageTimeout(new IntPtr(hwnd), MN_GETHMENU, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, 2000, out menu);
        if (call == IntPtr.Zero || menu == IntPtr.Zero || !IsMenu(menu)) return new CatMenuItemInfo[0];
        int count = GetMenuItemCount(menu);
        if (count < 0 || count > 256) return new CatMenuItemInfo[0];
        List<CatMenuItemInfo> items = new List<CatMenuItemInfo>();
        for (int position = 0; position < count; position++) {
            StringBuilder text = new StringBuilder(512);
            GetMenuString(menu, (uint)position, text, text.Capacity, MF_BYPOSITION);
            items.Add(new CatMenuItemInfo {
                Position = position,
                Id = GetMenuItemID(menu, position),
                Text = text.ToString(),
                State = GetMenuState(menu, (uint)position, MF_BYPOSITION),
                HasSubmenu = GetSubMenu(menu, position) != IntPtr.Zero
            });
        }
        return items.ToArray();
    }

    public static bool ClickPopupMenuPosition(long hwnd, int position)
    {
        IntPtr popup = new IntPtr(hwnd);
        IntPtr menu;
        IntPtr call = SendMessageTimeout(popup, MN_GETHMENU, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, 2000, out menu);
        if (call == IntPtr.Zero || menu == IntPtr.Zero || !IsMenu(menu)) return false;
        int count = GetMenuItemCount(menu);
        if (position < 0 || position >= count) return false;
        RECT rect;
        if (!GetMenuItemRect(popup, menu, (uint)position, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return false;
        int x = rect.Left + ((rect.Right - rect.Left) / 2);
        int y = rect.Top + ((rect.Bottom - rect.Top) / 2);
        if (!PositionCursorWithinRoot(x, y, hwnd)) return false;
        SendMouseFlag(MOUSEEVENTF_LEFTDOWN); SendMouseFlag(MOUSEEVENTF_LEFTUP);
        return true;
    }

    private static void SendVirtualKey(ushort key, bool up)
    {
        INPUT input = new INPUT(); input.type = INPUT_KEYBOARD; input.U.ki.wVk = key;
        input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        INPUT[] values = new INPUT[] { input };
        if (SendInput(1, values, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput keyboard event failed.");
    }

    public static void KeyPress(ushort key) { SendVirtualKey(key, false); SendVirtualKey(key, true); }
    public static void CtrlKey(ushort key) { SendVirtualKey(0x11, false); try { KeyPress(key); } finally { SendVirtualKey(0x11, true); } }

    public static void TypeUnicode(string value)
    {
        foreach (char character in value) {
            INPUT down = new INPUT(); down.type = INPUT_KEYBOARD; down.U.ki.wScan = character; down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            INPUT up = down; up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            INPUT[] values = new INPUT[] { down, up };
            if (SendInput(2, values, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput Unicode entry failed.");
        }
    }

    public static long DialogItem(long dialog, int id) { return GetDlgItem(new IntPtr(dialog), id).ToInt64(); }
    public static int DialogControlId(long control) { return GetDlgCtrlID(new IntPtr(control)); }
    public static string TextForWindow(long hwnd) { return WindowText(new IntPtr(hwnd)); }

    public static bool ClickButton(long hwnd)
    {
        IntPtr result;
        IntPtr call = SendMessageTimeout(new IntPtr(hwnd), BM_CLICK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, 2000, out result);
        return call != IntPtr.Zero;
    }

    public static bool CloseWindow(long hwnd)
    {
        IntPtr result;
        IntPtr call = SendMessageTimeout(new IntPtr(hwnd), WM_CLOSE, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 3000, out result);
        return call != IntPtr.Zero;
    }

}
'@ | Out-Null

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$script:WinRtAsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1

function Await-WinRtOperation {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )
  if ($null -eq $script:WinRtAsTaskMethod) { throw 'The WinRT task bridge is unavailable.' }
  $task = $script:WinRtAsTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Read-ImageTextWithWindowsOcr {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $file = Await-WinRtOperation -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($LiteralPath)) -ResultType ([Windows.Storage.StorageFile])
  $stream = Await-WinRtOperation -Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) -ResultType ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await-WinRtOperation -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRtOperation -Operation ($decoder.GetSoftwareBitmapAsync()) -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -eq $engine -or $engine.RecognizerLanguage.LanguageTag -notmatch '^en(?:-|$)') {
        throw 'The qualified English Windows OCR engine is unavailable.'
      }
      $result = Await-WinRtOperation -Operation ($engine.RecognizeAsync($bitmap)) -ResultType ([Windows.Media.Ocr.OcrResult])
      return [string]$result.Text
    } finally {
      $bitmap.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
    [int]$PollMilliseconds = 150
  )
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while ($deadline.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    $value = & $Condition
    if ($null -ne $value -and $value -ne $false) { return $value }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
  return $null
}

function ConvertTo-WindowsProcessArgument {
  param([AllowEmptyString()][string]$Value)

  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }

  # ProcessStartInfo.Arguments is one Windows command-line string on .NET Framework.
  # Apply the CommandLineToArgvW backslash/quote rules rather than PowerShell syntax.
  $quoted = New-Object Text.StringBuilder
  [void]$quoted.Append('"')
  $backslashes = 0
  for ($index = 0; $index -lt $Value.Length; $index++) {
    $character = $Value[$index]
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      if ($backslashes -gt 0) { [void]$quoted.Append(('\' * ($backslashes * 2))) }
      [void]$quoted.Append('\"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$quoted.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$quoted.Append($character)
  }
  if ($backslashes -gt 0) { [void]$quoted.Append(('\' * ($backslashes * 2))) }
  [void]$quoted.Append('"')
  return $quoted.ToString()
}

function Invoke-BoundedAccessibilityHelper {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('evidence', 'save', 'strings')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)]
    [ValidateRange(500, 15000)]
    [int]$TimeoutMilliseconds
  )

  $declaredMode = [string](Get-PropertyValue -Object $Request -Name 'Mode' -Default '')
  Assert-Condition -Condition ($declaredMode -ceq $Mode) -Code 'ACCESSIBILITY_HELPER_REQUEST_INVALID' -Message 'The accessibility helper request mode did not match its bounded invocation.'
  $requestJson = ConvertTo-DriverJson -Value $Request
  Assert-Condition -Condition ($requestJson.Length -le 131072) -Code 'ACCESSIBILITY_HELPER_REQUEST_TOO_LARGE' -Message 'The accessibility helper request exceeded its fixed safety limit.'
  $requestBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($requestJson)
  $payload = [Convert]::ToBase64String($requestBytes)

  $driverPath = $script:DriverScriptPath
  $driverHashBeforeHelper = Get-Sha256 -LiteralPath $driverPath
  Assert-Condition -Condition ($driverHashBeforeHelper -eq $script:DriverStartupSha256) -Code 'ACCESSIBILITY_HELPER_DRIVER_HASH_CHANGED' -Message 'The pinned driver script bytes changed after startup; no accessibility helper was launched.'
  $helperJobReady = [CatNative]::EnsureHelperKillOnParentCloseJob()
  Assert-Condition -Condition $helperJobReady -Code 'ACCESSIBILITY_HELPER_CONTAINMENT_FAILED' -Message 'The driver could not enter its helper-only kill-on-parent-close Windows Job Object; no accessibility helper was launched.'
  $currentHost = [Diagnostics.Process]::GetCurrentProcess()
  $powerShellPath = $currentHost.MainModule.FileName
  Assert-Condition -Condition ([IO.Path]::GetFileName($powerShellPath) -ieq 'powershell.exe') -Code 'ACCESSIBILITY_HELPER_HOST_REJECTED' -Message 'The bounded accessibility helper requires the same system powershell.exe host as the pinned driver.'
  $helperArguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $driverPath,
    '-AccessibilityHelperMode',
    $Mode,
    '-AccessibilityPayload',
    $payload,
    '-AccessibilityExpectedDriverSha256',
    $script:DriverStartupSha256
  )

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powerShellPath
  $helperArgumentLine = (($helperArguments | ForEach-Object {
        ConvertTo-WindowsProcessArgument -Value ([string]$_)
      }) -join ' ')
  Assert-Condition -Condition ($helperArgumentLine.Length -gt 0 -and $helperArgumentLine.Length -le 30000) -Code 'ACCESSIBILITY_HELPER_COMMAND_LINE_TOO_LARGE' -Message 'The fully quoted accessibility helper command line exceeded the conservative 30,000-character Windows process limit; no helper was launched.'
  $startInfo.Arguments = $helperArgumentLine
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if ($script:StagingRoot -and (Test-Path -LiteralPath $script:StagingRoot -PathType Container)) {
    $startInfo.WorkingDirectory = $script:StagingRoot
  }

  $helper = New-Object Diagnostics.Process
  $helper.StartInfo = $startInfo
  $helperStarted = $false
  $helperProcessId = $null
  $finallyTerminationFailure = $null
  try {
    $started = $helper.Start()
    if ($started) {
      $helperStarted = $true
      $helperProcessId = [int]$helper.Id
    }
    Assert-Condition -Condition $started -Code 'ACCESSIBILITY_HELPER_START_FAILED' -Message 'The bounded accessibility helper process did not start.'
    $helperContained = [CatNative]::IsProcessInHelperJob($helper.Handle)
    Assert-Condition -Condition $helperContained -Code 'ACCESSIBILITY_HELPER_CONTAINMENT_FAILED' -Message "Accessibility helper PID $helperProcessId did not inherit the driver's helper-only kill-on-parent-close Windows Job Object."
    $stdoutTask = $helper.StandardOutput.ReadToEndAsync()
    $stderrTask = $helper.StandardError.ReadToEndAsync()
    if (-not $helper.WaitForExit($TimeoutMilliseconds)) {
      try {
        if (-not $helper.HasExited) { $helper.Kill() }
      } catch { }
      $helperTerminationConfirmed = $false
      try { $helperTerminationConfirmed = $helper.WaitForExit(2000) } catch { }
      if (-not $helperTerminationConfirmed) {
        $script:AccessibilityHelperTerminationUnconfirmed = $true
        $script:AccessibilityHelperProcessId = $helperProcessId
        Stop-Driver -Code 'ACCESSIBILITY_HELPER_TERMINATION_UNCONFIRMED' -Message "Accessibility helper PID $($script:AccessibilityHelperProcessId) could not be confirmed terminated; no Captivate close or other UI action will be requested and staging will be retained."
      }
      Stop-Driver -Code 'ACCESSIBILITY_HELPER_TIMEOUT' -Message "The bounded $Mode accessibility helper exceeded $TimeoutMilliseconds ms and only that helper process was terminated."
    }
    $helper.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $helperExitCode = [int]$helper.ExitCode
    $stderrForDiagnostic = if ($stderr.Length -gt 4096) { $stderr.Substring(0, 4096) } else { $stderr }
    $normalizedHelperStderr = Get-NormalizedWhitespace -Value ([string]$stderrForDiagnostic)
    if ([string]::IsNullOrWhiteSpace($normalizedHelperStderr)) { $normalizedHelperStderr = '<empty>' }
    if ($normalizedHelperStderr.Length -gt 1024) { $normalizedHelperStderr = $normalizedHelperStderr.Substring(0, 1024) }
    $helperProcessContext = "exitCode=$helperExitCode; stderr=$normalizedHelperStderr"
    Assert-Condition -Condition ($stdout.Length -le 262144 -and $stderr.Length -le 16384) -Code 'ACCESSIBILITY_HELPER_OUTPUT_TOO_LARGE' -Message "The bounded accessibility helper exceeded its fixed output limit ($helperProcessContext)."
    $responseLines = @($stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    Assert-Condition -Condition ($responseLines.Count -eq 1) -Code 'ACCESSIBILITY_HELPER_PROTOCOL_INVALID' -Message "The bounded accessibility helper did not return exactly one JSON response ($helperProcessContext)."
    try { $response = $responseLines[0] | ConvertFrom-Json }
    catch { Stop-Driver -Code 'ACCESSIBILITY_HELPER_PROTOCOL_INVALID' -Message "The bounded accessibility helper returned malformed JSON ($helperProcessContext)." }

    $responseSchema = [int](Get-PropertyValue -Object $response -Name 'SchemaVersion' -Default 0)
    $responseMode = [string](Get-PropertyValue -Object $response -Name 'Mode' -Default '')
    $responseOk = Get-PropertyValue -Object $response -Name 'Ok' -Default $null
    Assert-Condition -Condition ($responseSchema -eq 1 -and $responseMode -ceq $Mode -and $responseOk -is [bool]) -Code 'ACCESSIBILITY_HELPER_PROTOCOL_INVALID' -Message "The bounded accessibility helper response did not match the exact schema and mode ($helperProcessContext)."
    if ($helper.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($stderr) -or -not $responseOk) {
      $helperCode = Get-NormalizedWhitespace -Value ([string](Get-PropertyValue -Object $response -Name 'Code' -Default 'HELPER_REJECTED'))
      $helperError = Get-NormalizedWhitespace -Value ([string](Get-PropertyValue -Object $response -Name 'Error' -Default 'The helper rejected the request.'))
      if ([string]::IsNullOrWhiteSpace($helperCode)) { $helperCode = 'HELPER_PROCESS_REJECTED' }
      if ([string]::IsNullOrWhiteSpace($helperError)) { $helperError = 'The helper response did not include an error message.' }
      if ($helperCode.Length -gt 128) { $helperCode = $helperCode.Substring(0, 128) }
      if ($helperError.Length -gt 1024) { $helperError = $helperError.Substring(0, 1024) }
      Stop-Driver -Code 'ACCESSIBILITY_HELPER_REJECTED' -Message "The bounded $Mode accessibility helper failed (code=$helperCode; $helperProcessContext): $helperError"
    }
    return $response
  } finally {
    if ($helperStarted) {
      $helperExitConfirmed = $false
      try { $helperExitConfirmed = $helper.HasExited } catch { }
      if (-not $helperExitConfirmed) {
        try { $helper.Kill() } catch { }
        try { $helperExitConfirmed = $helper.WaitForExit(2000) } catch { }
      }
      if (-not $helperExitConfirmed) {
        $script:AccessibilityHelperTerminationUnconfirmed = $true
        $script:AccessibilityHelperProcessId = $helperProcessId
        $finallyTerminationFailure = "Accessibility helper PID $helperProcessId remained active after exceptional-path cleanup; no Captivate close or other UI action will be requested and staging will be retained."
      }
    }
    $helper.Dispose()
    $currentHost.Dispose()
    if ($finallyTerminationFailure) {
      Stop-Driver -Code 'ACCESSIBILITY_HELPER_TERMINATION_UNCONFIRMED' -Message $finallyTerminationFailure
    }
  }
}

function Set-CaptivateForegroundOrFail {
  param(
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $currentForeground = [CatNative]::GetForegroundWindow()
  if ($currentForeground -eq [IntPtr]::Zero -or [CatNative]::RootWindow($currentForeground.ToInt64()) -ne $MainHwnd) {
    # A synthetic Alt key press releases Windows' foreground-lock restriction without
    # choosing a Captivate command. The exact target is still verified after settling.
    [CatNative]::KeyPress(0x12)
    Start-Sleep -Milliseconds 75
  }
  $focused = Wait-Until -TimeoutMilliseconds 5000 -PollMilliseconds 150 -Condition {
    if ([CatNative]::BringToForeground($MainHwnd)) {
      Start-Sleep -Milliseconds 250
      $settledForeground = [CatNative]::GetForegroundWindow()
      if ($settledForeground -ne [IntPtr]::Zero -and [CatNative]::RootWindow($settledForeground.ToInt64()) -eq $MainHwnd) {
        return $true
      }
    }
    return $null
  }
  Assert-Condition -Condition ($focused -eq $true) -Code 'CAPTIVATE_FOREGROUND_FAILED' -Message $Message
}

function Get-WindowInfo {
  param([Parameter(Mandatory = $true)][long]$Hwnd)
  if (-not [CatNative]::IsWindow([IntPtr]$Hwnd)) { return $null }
  return [CatNative]::DescribeWindow($Hwnd)
}

function Get-WindowInfoWithoutText {
  param([Parameter(Mandatory = $true)][long]$Hwnd)
  if (-not [CatNative]::IsWindow([IntPtr]$Hwnd)) { return $null }
  return [CatNative]::DescribeWindowWithoutText($Hwnd)
}

function Get-VisibleTopWindows {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  return @([CatNative]::TopWindowsForProcess($ProcessId, $true))
}

function Get-VisibleAdobeLicensingWindows {
  $visible = New-Object 'System.Collections.Generic.List[object]'
  foreach ($licensingProcess in @(Get-Process -Name 'adobe_licensing_wf' -ErrorAction SilentlyContinue)) {
    foreach ($licensingWindow in @(Get-VisibleTopWindows -ProcessId $licensingProcess.Id)) {
      $visible.Add([PSCustomObject]@{ Process = $licensingProcess; Window = $licensingWindow })
    }
  }
  return $visible.ToArray()
}

function Assert-WindowProfile {
  param([Parameter(Mandatory = $true)]$MainWindow)
  $currentScalePercent = [CatNative]::PrimaryMonitorScalePercent()
  Assert-Condition -Condition ($currentScalePercent -eq $script:ExpectedPrimaryScalePercent) -Code 'DISPLAY_SCALE_CHANGED' -Message "The primary display scale changed during Captivate automation; expected $($script:ExpectedPrimaryScalePercent)% and observed $currentScalePercent%."
  Assert-Condition -Condition ($MainWindow.Left -eq 0 -and $MainWindow.Top -eq 0 -and $MainWindow.Width -eq $script:ExpectedWorkingWidth -and $MainWindow.Height -eq $script:ExpectedWorkingHeight) -Code 'CAPTIVATE_WINDOW_PROFILE_MISMATCH' -Message "Captivate must occupy exactly 0,0,$($script:ExpectedWorkingWidth),$($script:ExpectedWorkingHeight); observed $($MainWindow.Left),$($MainWindow.Top),$($MainWindow.Width),$($MainWindow.Height)."
}

function Assert-DesktopProfile {
  Assert-Condition -Condition ([Environment]::UserInteractive) -Code 'NONINTERACTIVE_DESKTOP' -Message 'Captivate automation requires an interactive Windows desktop.'
  $dpiAwareness = [CatNative]::CurrentProcessDpiAwareness()
  $coordinateDpi = [CatNative]::CoordinateSpaceDpi()
  $script:PrimaryScalePercent = [CatNative]::PrimaryMonitorScalePercent()
  Assert-Condition -Condition ($dpiAwareness -eq 0 -and $coordinateDpi -eq 96 -and $script:PrimaryScalePercent -eq $script:ExpectedPrimaryScalePercent) -Code 'COORDINATE_DPI_PROFILE_MISMATCH' -Message "The qualified profile requires a DPI-unaware 96-DPI logical coordinate space on a $($script:ExpectedPrimaryScalePercent)% primary display; observed awareness $dpiAwareness, logical DPI $coordinateDpi, and primary scale $($script:PrimaryScalePercent)%."
  $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Assert-Condition -Condition ($area.Left -eq 0 -and $area.Top -eq 0 -and $area.Width -ge $script:ExpectedWorkingWidth -and $area.Height -ge $script:ExpectedWorkingHeight) -Code 'DESKTOP_PROFILE_MISMATCH' -Message "The primary working area must begin at 0,0 and fit the qualified $($script:ExpectedWorkingWidth) x $($script:ExpectedWorkingHeight) Captivate window; observed $($area.Left),$($area.Top),$($area.Width),$($area.Height)."
}

function Get-MainCaptivateWindow {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $captivateProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $captivateProcess) { return $null }
  $captivateProcess.Refresh()
  $mainHandle = $captivateProcess.MainWindowHandle
  if ($mainHandle -eq [IntPtr]::Zero) { return $null }
  $candidate = Get-WindowInfoWithoutText -Hwnd $mainHandle.ToInt64()
  if ($null -eq $candidate -or -not $candidate.Visible) { return $null }
  if ($candidate.ProcessId -ne $ProcessId -or $candidate.ClassName -ne 'Adobe Captivate Classic') { return $null }
  if ($candidate.Width -lt 800 -or $candidate.Height -lt 500) { return $null }
  return $candidate
}

function Wait-MainCaptivateWindow {
  param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)
  $window = Wait-Until -TimeoutMilliseconds 60000 -PollMilliseconds 250 -Condition {
    $Process.Refresh()
    if ($Process.HasExited) { Stop-Driver -Code 'CAPTIVATE_EXITED_DURING_STARTUP' -Message 'Captivate exited before its authoring window became ready.' }
    Get-MainCaptivateWindow -ProcessId $Process.Id
  }
  Assert-Condition -Condition ($null -ne $window) -Code 'CAPTIVATE_STARTUP_TIMEOUT' -Message 'Timed out waiting for the Captivate authoring window.'
  Assert-Condition -Condition ([CatNative]::ApplyQualifiedWindowProfile($window.Hwnd, $script:ExpectedWorkingWidth, $script:ExpectedWorkingHeight)) -Code 'CAPTIVATE_WINDOW_PROFILE_APPLY_FAILED' -Message 'Captivate did not accept the qualified 1280 x 696 window profile.'
  $profiled = Wait-Until -TimeoutMilliseconds 10000 -Condition {
    $current = Get-WindowInfoWithoutText -Hwnd $window.Hwnd
    if ($current -and $current.Left -eq 0 -and $current.Top -eq 0 -and $current.Width -eq $script:ExpectedWorkingWidth -and $current.Height -eq $script:ExpectedWorkingHeight) { $current } else { $null }
  }
  Assert-Condition -Condition ($null -ne $profiled) -Code 'CAPTIVATE_WINDOW_PROFILE_TIMEOUT' -Message 'Captivate did not enter the qualified 1280 x 696 window profile.'
  Assert-WindowProfile -MainWindow $profiled
  return $profiled
}

function Assert-NoUnexpectedTopWindow {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [string[]]$AllowedClasses = @(),
    [long[]]$AllowedHandles = @()
  )
  $unexpected = @(Get-VisibleTopWindows -ProcessId $ProcessId | Where-Object {
      $_.Hwnd -ne $MainHwnd -and $AllowedHandles -notcontains $_.Hwnd -and $AllowedClasses -notcontains $_.ClassName
    })
  if ($unexpected.Count -gt 0) {
    $summary = ($unexpected | ForEach-Object { "0x$('{0:X}' -f $_.Hwnd) [$($_.ClassName)] $($_.Text)" }) -join '; '
    Stop-Driver -Code 'UNEXPECTED_CAPTIVATE_WINDOW' -Message "Unexpected visible Captivate window(s): $summary"
  }
  $visibleLicensingWindows = @(Get-VisibleAdobeLicensingWindows)
  if ($visibleLicensingWindows.Count -gt 0) {
    Stop-Driver -Code 'LATE_ADOBE_LICENSING_WINDOW' -Message 'A visible Adobe licensing window appeared outside the exact startup/reopen reminder handler; no input was sent.'
  }
}

function Wait-CaptivateLicensingHandoff {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][int]$LicensingProcessId,
    [Parameter(Mandatory = $true)][long]$LicensingRootHwnd,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
  )
  $readiness = [PSCustomObject]@{ stableSamples = 0 }
  return Wait-Until -TimeoutMilliseconds $TimeoutMilliseconds -PollMilliseconds 250 -Condition {
    $captivateProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $captivateProcess) {
      Stop-Driver -Code 'CAPTIVATE_EXITED_DURING_LICENSING' -Message 'Captivate exited while the driver was passively waiting for Adobe licensing to complete.'
    }
    $captivateProcess.Refresh()
    $captivateResponding = $captivateProcess.Responding

    $main = Get-WindowInfoWithoutText -Hwnd $MainHwnd
    if ($null -eq $main) {
      $readiness.stableSamples = 0
      return $null
    }
    # Moving the pointer away from the dismissed Adobe reminder can expose a
    # transient Captivate canvas tooltip. It is non-modal, cannot satisfy any
    # licensing condition, and must not reset an otherwise exact handoff.
    $unexpectedCaptivate = @(Get-VisibleTopWindows -ProcessId $ProcessId | Where-Object {
        $_.Hwnd -ne $MainHwnd -and $_.ClassName -ne 'tooltips_class32'
      })
    if ($unexpectedCaptivate.Count -gt 0) {
      $summary = ($unexpectedCaptivate | ForEach-Object { "0x$('{0:X}' -f $_.Hwnd) [$($_.ClassName)] $($_.Text)" }) -join '; '
      Stop-Driver -Code 'UNEXPECTED_CAPTIVATE_WINDOW_DURING_LICENSING' -Message "Unexpected visible Captivate window(s) appeared during the passive licensing handoff: $summary"
    }

    $visibleLicensing = @(Get-VisibleAdobeLicensingWindows)
    $unexpectedLicensing = @($visibleLicensing | Where-Object {
        $_.Process.Id -ne $LicensingProcessId -or $_.Window.Hwnd -ne $LicensingRootHwnd
      })
    if ($unexpectedLicensing.Count -gt 0) {
      Stop-Driver -Code 'UNEXPECTED_ADOBE_LICENSING_WINDOW' -Message 'An additional Adobe licensing window appeared during the passive Captivate licensing handoff; no input was sent.'
    }

    $licensingProcess = Get-Process -Id $LicensingProcessId -ErrorAction SilentlyContinue
    $licensingProcessExited = $null -eq $licensingProcess
    $remainingLicensingProcesses = @(Get-Process -Name 'adobe_licensing_wf' -ErrorAction SilentlyContinue)
    $rootVisible = [CatNative]::IsWindow([IntPtr]$LicensingRootHwnd) -and [CatNative]::IsWindowVisible([IntPtr]$LicensingRootHwnd)
    $licensingUiComplete = $licensingProcessExited -and $remainingLicensingProcesses.Count -eq 0 -and -not $rootVisible -and $visibleLicensing.Count -eq 0
    $mainValid = $main.ProcessId -eq $ProcessId -and $main.ClassName -eq 'Adobe Captivate Classic' -and $main.Visible -and $main.Left -eq 0 -and $main.Top -eq 0 -and $main.Width -eq $script:ExpectedWorkingWidth -and $main.Height -eq $script:ExpectedWorkingHeight
    if ($licensingUiComplete -and $mainValid -and $main.Enabled -and $captivateResponding) {
      $readiness.stableSamples++
    } else {
      $readiness.stableSamples = 0
    }
    if ($readiness.stableSamples -ge 60) { return $true }
    return $null
  }
}

function Wait-ForExactTrialReminder {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd
  )
  $script:LicensingHandoffActive = $true
  $expectedLicensingPath = Join-Path $env:ProgramFiles 'Common Files\Adobe\Adobe Desktop Common\NGL\adobe_licensing_wf.exe'
  $discoveryState = [PSCustomObject]@{ stableNoReminderSamples = 0 }
  $discovery = Wait-Until -TimeoutMilliseconds 20000 -PollMilliseconds 250 -Condition {
    $captivateProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $captivateProcess) {
      Stop-Driver -Code 'CAPTIVATE_EXITED_DURING_LICENSING' -Message 'Captivate exited while the driver was checking for the Adobe trial reminder.'
    }
    $captivateProcess.Refresh()
    $captivateResponding = $captivateProcess.Responding
    $main = Get-WindowInfoWithoutText -Hwnd $MainHwnd
    $licensingProcesses = @(Get-Process -Name 'adobe_licensing_wf' -ErrorAction SilentlyContinue)
    $visibleLicensing = @(Get-VisibleAdobeLicensingWindows)
    $visibleCandidates = @($visibleLicensing | Where-Object {
        $_.Window.ClassName -eq 'EmbeddedWB' -and $_.Window.Text -eq 'Captivate'
      })
    if ($visibleCandidates.Count -gt 1) {
      Stop-Driver -Code 'AMBIGUOUS_TRIAL_REMINDER' -Message "Found $($visibleCandidates.Count) visible Adobe licensing reminders for Captivate."
    }
    if ($visibleCandidates.Count -eq 1) {
      return [PSCustomObject]@{ Kind = 'reminder'; Candidate = $visibleCandidates[0] }
    }
    if ($visibleLicensing.Count -gt 0) {
      Stop-Driver -Code 'UNEXPECTED_ADOBE_LICENSING_WINDOW' -Message 'A visible Adobe licensing window did not match the qualified EmbeddedWB/Captivate reminder; no input was sent.'
    }

    $mainValid = $null -ne $main -and $main.ProcessId -eq $ProcessId -and $main.ClassName -eq 'Adobe Captivate Classic' -and $main.Visible -and $main.Left -eq 0 -and $main.Top -eq 0 -and $main.Width -eq $script:ExpectedWorkingWidth -and $main.Height -eq $script:ExpectedWorkingHeight
    if ($licensingProcesses.Count -eq 0 -and $visibleLicensing.Count -eq 0 -and $mainValid -and $main.Enabled -and $captivateResponding) {
      $discoveryState.stableNoReminderSamples++
    } else {
      $discoveryState.stableNoReminderSamples = 0
    }
    if ($discoveryState.stableNoReminderSamples -ge 40) {
      return [PSCustomObject]@{ Kind = 'none'; Candidate = $null }
    }
    return $null
  }
  Assert-Condition -Condition ($null -ne $discovery) -Code 'LICENSING_DISCOVERY_TIMEOUT' -Message 'Timed out after 20 seconds without either the exact Adobe Captivate trial reminder or 10 continuous seconds of an enabled, responsive Captivate window with no Adobe licensing process/window. No input was sent.'
  if ($discovery.Kind -eq 'none') {
    Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
    $script:LicensingHandoffActive = $false
    return $false
  }

  $candidate = $discovery.Candidate
  $licensingProcess = $candidate.process
  $root = $candidate.window
  try { $actualLicensingPath = $licensingProcess.Path }
  catch { Stop-Driver -Code 'LICENSING_PROCESS_PATH_UNAVAILABLE' -Message 'The visible Adobe licensing reminder executable path could not be verified; it was left untouched.' }
  Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($actualLicensingPath) -and ([IO.Path]::GetFullPath($actualLicensingPath) -ieq [IO.Path]::GetFullPath($expectedLicensingPath))) -Code 'UNEXPECTED_LICENSING_PROCESS_PATH' -Message "The visible Captivate reminder came from an unexpected process path and was left untouched: $actualLicensingPath"
  $licensingItem = Get-Item -LiteralPath $actualLicensingPath -Force
  Assert-Condition -Condition (($licensingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -Code 'LICENSING_PROCESS_REPARSE_POINT' -Message 'The Adobe licensing executable is a reparse point; the visible reminder was left untouched.'
  $licensingSignature = Get-AuthenticodeSignature -LiteralPath $actualLicensingPath
  $licensingPublisher = if ($licensingSignature.SignerCertificate) { $licensingSignature.SignerCertificate.Subject } else { '' }
  Assert-Condition -Condition ($licensingSignature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and $licensingPublisher -match '(?i)(?:^|,\s*)O="?Adobe Inc\.?"?(?:,|$)') -Code 'INVALID_LICENSING_PROCESS_SIGNATURE' -Message 'The visible Captivate reminder was not hosted by a valid Adobe-signed licensing executable; it was left untouched.'

  # The current NGL host is transient and normally dismisses itself once it has
  # refreshed the trial state. Prefer a bounded passive wait so the driver sends
  # no input to Adobe licensing UI at all.
  $closedWithoutInput = Wait-Until -TimeoutMilliseconds 15000 -PollMilliseconds 250 -Condition {
    if (-not [CatNative]::IsWindow([IntPtr]$root.Hwnd)) { return $true }
    if (-not [CatNative]::IsWindowVisible([IntPtr]$root.Hwnd)) { return $true }
    $licensingProcess.Refresh()
    if ($licensingProcess.HasExited) { return $true }
    return $null
  }
  if ($closedWithoutInput -eq $true) {
    $captivateReady = Wait-CaptivateLicensingHandoff -ProcessId $ProcessId -MainHwnd $MainHwnd -LicensingProcessId $licensingProcess.Id -LicensingRootHwnd $root.Hwnd -TimeoutMilliseconds 90000
    Assert-Condition -Condition ($captivateReady -eq $true) -Code 'CAPTIVATE_LICENSING_HANDOFF_TIMEOUT' -Message 'The Adobe licensing window completed without input, but Captivate did not remain enabled without licensing UI for the required 15-second stabilization interval.'
    Add-AuditRecord -Stage $script:Stage -Message 'The exact Adobe-signed Captivate licensing window completed itself and Captivate stabilized; no input was sent.'
    Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
    $script:LicensingHandoffActive = $false
    return $true
  }

  $ocrScreenshotPath = Join-Path $script:StagingRoot 'licensing-ocr-verification.png'
  $ocrState = [PSCustomObject]@{ Text = ''; LastError = ''; ReminderCompleted = $false }
  try {
    $ocrReady = Wait-Until -TimeoutMilliseconds 30000 -PollMilliseconds 1000 -Condition {
      $currentRoot = Get-WindowInfo -Hwnd $root.Hwnd
      if ($null -eq $currentRoot -or -not $currentRoot.Visible) {
        $ocrState.ReminderCompleted = $true
        return $true
      }
      if ($currentRoot.ClassName -ne 'EmbeddedWB' -or $currentRoot.Text -ne 'Captivate') {
        Stop-Driver -Code 'TRIAL_REMINDER_CHANGED_BEFORE_OCR' -Message 'The verified Adobe licensing reminder changed during OCR verification; it was left untouched.'
      }
      try {
        if (Test-Path -LiteralPath $ocrScreenshotPath -PathType Leaf) { Remove-Item -LiteralPath $ocrScreenshotPath -Force }
        $ocrBitmap = New-Object Drawing.Bitmap ([Math]::Max(1, $currentRoot.Width)), ([Math]::Max(1, $currentRoot.Height))
        $ocrGraphics = [Drawing.Graphics]::FromImage($ocrBitmap)
        try {
          $ocrGraphics.CopyFromScreen($currentRoot.Left, $currentRoot.Top, 0, 0, $ocrBitmap.Size)
          $ocrBitmap.Save($ocrScreenshotPath, [Drawing.Imaging.ImageFormat]::Png)
        } finally {
          $ocrGraphics.Dispose()
          $ocrBitmap.Dispose()
        }
        $ocrState.Text = Get-NormalizedWhitespace -Value (Read-ImageTextWithWindowsOcr -LiteralPath $ocrScreenshotPath)
        $ocrVerified = $ocrState.Text -match '(?i)(?:^|\s)Adobe(?:\s|$)' -and $ocrState.Text -match '(?i)(?:^|\s)(?:\d{1,3}\s+)?days?\s+left\s+in\s+your\s+Captivate\s+trial\.?(?:\s|$)'
        if ($ocrVerified) { return $true }
      } catch {
        $ocrState.LastError = $_.Exception.Message
      }
      return $null
    }
  } finally {
    if (Test-Path -LiteralPath $ocrScreenshotPath -PathType Leaf) { Remove-Item -LiteralPath $ocrScreenshotPath -Force }
  }
  if ($ocrState.ReminderCompleted) {
    $captivateReady = Wait-CaptivateLicensingHandoff -ProcessId $ProcessId -MainHwnd $MainHwnd -LicensingProcessId $licensingProcess.Id -LicensingRootHwnd $root.Hwnd -TimeoutMilliseconds 90000
    Assert-Condition -Condition ($captivateReady -eq $true) -Code 'CAPTIVATE_LICENSING_HANDOFF_TIMEOUT' -Message 'The Adobe trial reminder completed during OCR retry, but the licensing process did not fully exit or Captivate did not remain enabled and responsive for 15 seconds.'
    Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
    $script:LicensingHandoffActive = $false
    return $true
  }
  $ocrFailureDetail = if ([string]::IsNullOrWhiteSpace($ocrState.LastError)) { 'OCR frames did not contain the qualified reminder text.' } else { "Last OCR error: $($ocrState.LastError)" }
  Assert-Condition -Condition ($ocrReady -eq $true) -Code 'TRIAL_REMINDER_OCR_TIMEOUT' -Message "Windows OCR could not verify the proven Adobe/Captivate trial-reminder text within 30 seconds; it was left untouched. $ocrFailureDetail"

  $resumeStage = $script:Stage
  Set-DriverStage -Name 'await-continue-trial' -Message 'Action required: choose Continue Trial (or Continue Offline if Adobe displays that label). Never choose Try Again and do not close the reminder. The driver will wait up to 300 seconds and will not send any input to Adobe licensing UI.'
  $captivateReady = Wait-CaptivateLicensingHandoff -ProcessId $ProcessId -MainHwnd $MainHwnd -LicensingProcessId $licensingProcess.Id -LicensingRootHwnd $root.Hwnd -TimeoutMilliseconds 300000
  Assert-Condition -Condition ($captivateReady -eq $true) -Code 'CONTINUE_TRIAL_USER_ACTION_TIMEOUT' -Message 'Timed out after 300 seconds waiting for you to choose Continue Trial (or Continue Offline if offered), for every adobe_licensing_wf process to exit, and for Captivate to remain enabled and responsive for 15 seconds. Never choose Try Again or close the reminder. No automated input was sent; Captivate and staging were left untouched.'
  Set-DriverStage -Name $resumeStage -Message 'The Adobe licensing handoff completed and Captivate is enabled and stable; Adobe licensing UI received no automated input.'
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  $script:LicensingHandoffActive = $false
  return $true
}

function Start-OwnedCaptivate {
  param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Assert-NoCaptivateProcess
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $ExecutablePath
  $startInfo.Arguments = '"' + $ProjectPath + '"'
  $startInfo.WorkingDirectory = $WorkingDirectory
  # Shell execution prevents the GUI process from inheriting this driver's
  # stdout/stderr handles, while Start() still returns the owned Captivate PID.
  $startInfo.UseShellExecute = $true
  $startInfo.CreateNoWindow = $false
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  Assert-Condition -Condition ($process.Start()) -Code 'CAPTIVATE_LAUNCH_FAILED' -Message 'Captivate did not start.'
  $script:OwnedProcess = $process
  $script:ConfirmedProcessExit = $false
  $script:ProcessIds.Add($process.Id)
  return $process
}

function Assert-OwnedProcessIsExclusive {
  param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)
  $running = @(Get-Process -Name 'AdobeCaptivateClassic' -ErrorAction SilentlyContinue)
  Assert-Condition -Condition ($running.Count -eq 1 -and $running[0].Id -eq $Process.Id) -Code 'CAPTIVATE_PROCESS_OWNERSHIP_LOST' -Message 'The active AdobeCaptivateClassic process no longer uniquely matches the process launched by this driver.'
}

function Invoke-ProfileClick {
  param(
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [ValidateSet(1, 2)][int]$Count = 1,
    [string]$ExpectedHitClass = ''
  )
  $window = Get-WindowInfoWithoutText -Hwnd $MainHwnd
  Assert-Condition -Condition ($null -ne $window) -Code 'CAPTIVATE_MAIN_WINDOW_LOST' -Message 'The Captivate main window is no longer available.'
  Assert-WindowProfile -MainWindow $window
  Assert-Condition -Condition ($X -ge $window.Left -and $X -lt ($window.Left + $window.Width) -and $Y -ge $window.Top -and $Y -lt ($window.Top + $window.Height)) -Code 'PROFILE_COORDINATE_OUTSIDE_WINDOW' -Message "Qualified coordinate $X,$Y is outside the Captivate window."
  Set-CaptivateForegroundOrFail -MainHwnd $MainHwnd -Message 'Captivate could not be brought to the foreground.'
  $clicked = if ([string]::IsNullOrEmpty($ExpectedHitClass)) {
    [CatNative]::ClickWithinRoot($X, $Y, $Count, $MainHwnd)
  } else {
    [CatNative]::ClickWithinRootAndClass($X, $Y, $Count, $MainHwnd, $ExpectedHitClass)
  }
  Assert-Condition -Condition $clicked -Code 'PROFILE_CLICK_TARGET_MISMATCH' -Message "The qualified cursor point $X,$Y did not resolve to the expected Captivate target; no input was sent."
}

function Confirm-TextEditContextAndSelectAll {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  $currentMain = Get-WindowInfoWithoutText -Hwnd $MainHwnd
  Assert-Condition -Condition ($null -ne $currentMain) -Code 'CAPTIVATE_MAIN_WINDOW_LOST' -Message 'The Captivate main window disappeared before text-edit attestation.'
  Assert-WindowProfile -MainWindow $currentMain
  Set-CaptivateForegroundOrFail -MainHwnd $MainHwnd -Message "Captivate could not be focused while attesting native text edit for $Label."
  Assert-Condition -Condition ([CatNative]::RightClickWithinRootAndClass($X, $Y, $MainHwnd, 'DocumentContainerWindowClass')) -Code 'TEXT_EDIT_CONTEXT_CLICK_TARGET_MISMATCH' -Message "The qualified $Label point did not resolve to the exact Captivate document canvas; no context-menu input was sent."

  $popup = Wait-Until -TimeoutMilliseconds 5000 -PollMilliseconds 100 -Condition {
    $visibleTopWindows = @(Get-VisibleTopWindows -ProcessId $ProcessId)
    $matches = @($visibleTopWindows | Where-Object {
        $_.Hwnd -ne $MainHwnd -and $_.ClassName -eq '#32768' -and $_.Text -eq '' -and $_.Visible -and $_.Enabled -and $_.Width -eq 227 -and $_.Height -eq 156 -and $_.Owner -eq 0
      })
    if ($matches.Count -eq 1) { return $matches[0] }
    if ($matches.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_TEXT_EDIT_CONTEXT_MENU' -Message 'More than one qualified Captivate text-edit context menu appeared.' }
    $unexpected = @($visibleTopWindows | Where-Object { $_.Hwnd -ne $MainHwnd -and $_.ClassName -ne 'tooltips_class32' })
    if ($unexpected.Count -gt 0) {
      $summary = ($unexpected | ForEach-Object { "[$($_.ClassName)] $($_.Text)" }) -join '; '
      Stop-Driver -Code 'UNEXPECTED_WINDOW_WHILE_ATTESTING_TEXT_EDIT' -Message "Captivate displayed an unexpected window while attesting $Label text edit: $summary"
    }
    return $null
  }
  Assert-Condition -Condition ($null -ne $popup) -Code 'TEXT_EDIT_CONTEXT_MENU_TIMEOUT' -Message "The qualified text-edit context menu did not appear for $Label; no text input was sent."
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd -AllowedHandles @($popup.Hwnd) -AllowedClasses @('tooltips_class32')

  $items = @([CatNative]::MenuItemsForPopup($popup.Hwnd))
  # Captivate assigns the six leaf command IDs dynamically between launches.
  # The qualified proof pins exact positions, labels, states, separators,
  # submenu absence, popup geometry, and distinct nonzero leaf IDs.
  $expected = @(
    [PSCustomObject]@{ Position = 0; Id = -1; Text = "Cu&t`tCtrl+X"; State = 0 },
    [PSCustomObject]@{ Position = 1; Id = -1; Text = "&Copy`tCtrl+C"; State = 0 },
    [PSCustomObject]@{ Position = 2; Id = -1; Text = 'Copy Appearance'; State = 0 },
    [PSCustomObject]@{ Position = 3; Id = -1; Text = "&Delete`tDel"; State = 0 },
    [PSCustomObject]@{ Position = 4; Id = 4294967295; Text = ''; State = 2048 },
    [PSCustomObject]@{ Position = 5; Id = -1; Text = "S&elect All`tCtrl+A"; State = 0 },
    [PSCustomObject]@{ Position = 6; Id = 4294967295; Text = ''; State = 2048 },
    [PSCustomObject]@{ Position = 7; Id = -1; Text = 'Insert Hyperlink'; State = 0 }
  )
  Assert-Condition -Condition ($items.Count -eq $expected.Count) -Code 'TEXT_EDIT_CONTEXT_MENU_PROFILE_CHANGED' -Message "The $Label context menu did not contain the eight qualified native text-edit rows; no text input was sent."
  foreach ($definition in $expected) {
    $matches = @($items | Where-Object { $_.Position -eq $definition.Position })
    if ($matches.Count -ne 1) {
      Stop-Driver -Code 'TEXT_EDIT_CONTEXT_MENU_PROFILE_CHANGED' -Message "The $Label context menu position $($definition.Position) was missing or ambiguous; no text input was sent."
    }
    $item = $matches[0]
    $idMatches = if ([long]$definition.Id -lt 0) { [long]$item.Id -gt 0 -and [long]$item.Id -lt 4294967295 } else { [long]$item.Id -eq [long]$definition.Id }
    $valid = $idMatches -and $item.Text -ceq $definition.Text -and [long]$item.State -eq [long]$definition.State -and $item.HasSubmenu -eq $false
    Assert-Condition -Condition $valid -Code 'TEXT_EDIT_CONTEXT_MENU_PROFILE_CHANGED' -Message "The $Label context menu position $($definition.Position) did not match the qualified text-edit command; no text input was sent."
  }
  $leafIds = @($items | Where-Object { $_.Position -notin @(4, 6) } | ForEach-Object { [long]$_.Id })
  $distinctLeafIds = @($leafIds | Sort-Object -Unique)
  Assert-Condition -Condition ($leafIds.Count -eq 6 -and $distinctLeafIds.Count -eq 6) -Code 'TEXT_EDIT_CONTEXT_MENU_PROFILE_CHANGED' -Message "The $Label context menu leaf command IDs were not distinct; no text input was sent."

  Assert-Condition -Condition ([CatNative]::ClickPopupMenuPosition($popup.Hwnd, 5)) -Code 'TEXT_EDIT_SELECT_ALL_REJECTED' -Message "The qualified Select All text command could not be invoked for $Label; no text input was sent."
  $closed = Wait-Until -TimeoutMilliseconds 5000 -PollMilliseconds 100 -Condition {
    -not [CatNative]::IsWindow([IntPtr]$popup.Hwnd) -or -not [CatNative]::IsWindowVisible([IntPtr]$popup.Hwnd)
  }
  Assert-Condition -Condition ($closed -eq $true) -Code 'TEXT_EDIT_CONTEXT_MENU_DID_NOT_CLOSE' -Message "The $Label text-edit context menu remained open after Select All; no text input was sent."
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd

  $focusState = [PSCustomObject]@{ Last = 'none' }
  $textFocus = Wait-Until -TimeoutMilliseconds 3000 -PollMilliseconds 100 -Condition {
    $candidate = [CatNative]::FocusedWindowForThread($MainHwnd)
    if ($null -eq $candidate) {
      $focusState.Last = 'none'
      return $null
    }
    $candidateRoot = [CatNative]::RootWindow($candidate.Hwnd)
    $focusState.Last = "hwnd=$($candidate.Hwnd),pid=$($candidate.ProcessId),class=$($candidate.ClassName),root=$candidateRoot,visible=$($candidate.Visible),enabled=$($candidate.Enabled)"
    if ($candidate.ProcessId -eq $ProcessId -and $candidate.ClassName -eq 'OWL.Document' -and $candidateRoot -eq $MainHwnd -and $candidate.Visible -and $candidate.Enabled) {
      return $candidate
    }
    return $null
  }
  Assert-Condition -Condition ($null -ne $textFocus) -Code 'TEXT_EDIT_FOCUS_NOT_CONFIRMED' -Message "Captivate did not retain the exact document focus after the qualified $Label Select All command; observed $($focusState.Last). No text input was sent."
}

function Set-NativeTextAtProfilePoint {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  Invoke-ProfileClick -MainHwnd $MainHwnd -X $X -Y $Y -Count 2 -ExpectedHitClass 'DocumentContainerWindowClass'
  Start-Sleep -Milliseconds 250
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  Confirm-TextEditContextAndSelectAll -ProcessId $ProcessId -MainHwnd $MainHwnd -X $X -Y $Y -Label $Label
  [CatNative]::TypeUnicode($Text)
  Start-Sleep -Milliseconds 150
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  Add-AuditRecord -Stage $script:Stage -Message "Populated native $Label at the qualified profile point."
}

function Add-ContentSlide {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd
  )
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  Invoke-ProfileClick -MainHwnd $MainHwnd -X 52 -Y 62
  $transitionState = [PSCustomObject]@{ Hwnd = 0L; Owner = 0L; Left = 0; Top = 0; Width = 0; Height = 0 }
  $popup = Wait-Until -TimeoutMilliseconds 10000 -Condition {
    $visibleTopWindows = @(Get-VisibleTopWindows -ProcessId $ProcessId)
    $matches = @($visibleTopWindows | Where-Object {
        $_.Hwnd -ne $MainHwnd -and $_.ClassName -eq 'DroverLord - Window Class' -and $_.Text -eq 'OS_PopupWindow' -and $_.Visible -and $_.Enabled -and
        $_.Width -eq 200 -and $_.Height -eq 370 -and $_.Left -ge 0 -and $_.Top -ge 0 -and
        ($_.Left + $_.Width) -le $script:ExpectedWorkingWidth -and ($_.Top + $_.Height) -le $script:ExpectedWorkingHeight -and $_.Owner -in @(0, $MainHwnd)
      })
    if ($matches.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_SLIDES_POPUP' -Message 'More than one qualified Slides popup appeared.' }
    # Captivate may expose the same Drover popup host briefly as OS_ViewContainer
    # before it settles to the qualified OS_PopupWindow. It is never clicked in
    # that state; all other top-level windows still fail immediately.
    $transitionalHosts = @($visibleTopWindows | Where-Object {
        $_.Hwnd -ne $MainHwnd -and $_.ClassName -eq 'DroverLord - Window Class' -and $_.Text -eq 'OS_ViewContainer' -and $_.Visible -and $_.Enabled -and
        $_.Width -eq 200 -and $_.Height -eq 370 -and $_.Left -ge 0 -and $_.Top -ge 0 -and
        ($_.Left + $_.Width) -le $script:ExpectedWorkingWidth -and ($_.Top + $_.Height) -le $script:ExpectedWorkingHeight -and $_.Owner -in @(0, $MainHwnd)
      })
    if ($transitionalHosts.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_SLIDES_POPUP_TRANSITION' -Message 'More than one Captivate Slides transition host appeared.' }
    $transitionHandles = @($transitionalHosts | ForEach-Object { [long]$_.Hwnd })
    if ($transitionalHosts.Count -eq 1) {
      $transition = $transitionalHosts[0]
      if ($transitionState.Hwnd -eq 0) {
        $transitionState.Hwnd = [long]$transition.Hwnd
        $transitionState.Owner = [long]$transition.Owner
        $transitionState.Left = [int]$transition.Left
        $transitionState.Top = [int]$transition.Top
        $transitionState.Width = [int]$transition.Width
        $transitionState.Height = [int]$transition.Height
      } elseif ($transitionState.Hwnd -ne $transition.Hwnd -or $transitionState.Owner -ne $transition.Owner -or $transitionState.Left -ne $transition.Left -or $transitionState.Top -ne $transition.Top -or $transitionState.Width -ne $transition.Width -or $transitionState.Height -ne $transition.Height) {
        Stop-Driver -Code 'SLIDES_POPUP_TRANSITION_CHANGED' -Message 'The Captivate Slides transition host changed identity or geometry before qualification.'
      }
    }
    if ($matches.Count -eq 1) {
      $match = $matches[0]
      if ($transitionalHosts.Count -gt 0) { Stop-Driver -Code 'AMBIGUOUS_SLIDES_POPUP_TRANSITION' -Message 'A qualified Slides popup and a transition host were visible at the same time.' }
      if ($transitionState.Hwnd -ne 0 -and ($match.Hwnd -ne $transitionState.Hwnd -or $match.Owner -ne $transitionState.Owner -or $match.Left -ne $transitionState.Left -or $match.Top -ne $transitionState.Top -or $match.Width -ne $transitionState.Width -or $match.Height -ne $transitionState.Height)) {
        Stop-Driver -Code 'SLIDES_POPUP_TRANSITION_IDENTITY_MISMATCH' -Message 'The qualified Slides popup did not retain the exact transition-host identity and geometry.'
      }
      return $match
    }
    $unexpected = @($visibleTopWindows | Where-Object {
        $_.Hwnd -ne $MainHwnd -and $_.ClassName -ne 'tooltips_class32' -and -not ($transitionHandles -contains $_.Hwnd)
      })
    if ($unexpected.Count -gt 0) {
      $summary = ($unexpected | ForEach-Object { "[$($_.ClassName)] $($_.Text)" }) -join '; '
      Stop-Driver -Code 'UNEXPECTED_WINDOW_WHILE_OPENING_SLIDES' -Message "Captivate displayed an unexpected window instead of the Slides popup: $summary"
    }
    return $null
  }
  Assert-Condition -Condition ($null -ne $popup) -Code 'SLIDES_POPUP_TIMEOUT' -Message 'The qualified 200 x 370 Slides popup (DroverLord class, OS_PopupWindow caption) did not appear.'
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd -AllowedHandles @($popup.Hwnd)
  $currentPopup = Get-WindowInfo -Hwnd $popup.Hwnd
  $popupUnchanged = $null -ne $currentPopup -and $currentPopup.Hwnd -eq $popup.Hwnd -and $currentPopup.ProcessId -eq $ProcessId -and $currentPopup.ClassName -ceq 'DroverLord - Window Class' -and $currentPopup.Text -ceq 'OS_PopupWindow' -and $currentPopup.Visible -and $currentPopup.Enabled -and $currentPopup.Left -eq $popup.Left -and $currentPopup.Top -eq $popup.Top -and $currentPopup.Width -eq 200 -and $currentPopup.Height -eq 370 -and $currentPopup.Owner -eq $popup.Owner
  Assert-Condition -Condition $popupUnchanged -Code 'SLIDES_POPUP_CHANGED_BEFORE_CLICK' -Message 'The qualified Slides popup changed identity, state, caption, owner, or geometry before input; no click was sent.'
  Assert-Condition -Condition ([CatNative]::ClickWithinExactWindowProfile(($popup.Left + 80), ($popup.Top + 59), 1, $popup.Hwnd, $ProcessId, 'DroverLord - Window Class', 'OS_PopupWindow', $popup.Left, $popup.Top, 200, 370, $popup.Owner)) -Code 'SLIDES_POPUP_CLICK_TARGET_MISMATCH' -Message 'The qualified Content Slide point did not resolve to the unchanged exact Slides popup; no input was sent.'
  $closed = Wait-Until -TimeoutMilliseconds 10000 -Condition {
    -not [CatNative]::IsWindow([IntPtr]$popup.Hwnd) -or -not [CatNative]::IsWindowVisible([IntPtr]$popup.Hwnd)
  }
  Assert-Condition -Condition ($closed -eq $true) -Code 'SLIDES_POPUP_DID_NOT_CLOSE' -Message 'The Slides popup remained open after selecting the qualified Content Slide row.'
  Start-Sleep -Milliseconds 500
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
}

function Assert-ExactMenuItem {
  param(
    [Parameter(Mandatory = $true)][object[]]$Items,
    [Parameter(Mandatory = $true)][int]$Position,
    [long]$Id = -1,
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][bool]$HasSubmenu,
    [Parameter(Mandatory = $true)][string]$Code
  )
  $matches = @($Items | Where-Object { $_.Position -eq $Position })
  if ($matches.Count -ne 1) {
    Stop-Driver -Code $Code -Message "Captivate menu position $Position did not match the qualified item '$Text'."
  }
  $item = $matches[0]
  $idMatches = $Id -lt 0 -or [long]$item.Id -eq $Id
  $valid = $idMatches -and $item.Text -ceq $Text -and $item.HasSubmenu -eq $HasSubmenu -and ([long]$item.State -band 0x3) -eq 0
  Assert-Condition -Condition $valid -Code $Code -Message "Captivate menu position $Position did not match the qualified item '$Text'."
}

function Open-ExactXmlExportDialog {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd
  )
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd -AllowedClasses @('tooltips_class32')
  $currentMain = Get-WindowInfoWithoutText -Hwnd $MainHwnd
  Assert-Condition -Condition ($null -ne $currentMain) -Code 'CAPTIVATE_MAIN_WINDOW_LOST' -Message 'The Captivate main window disappeared before the XML export sequence.'
  Assert-WindowProfile -MainWindow $currentMain
  Set-CaptivateForegroundOrFail -MainHwnd $MainHwnd -Message 'Captivate could not be focused for the qualified XML export menu sequence.'
  Assert-Condition -Condition ([CatNative]::ClickWithinRoot(60, 20, 1, $MainHwnd)) -Code 'FILE_MENU_CLICK_TARGET_MISMATCH' -Message 'The qualified File-menu point did not resolve to the exact Captivate authoring window; no input was sent.'

  $filePopup = Wait-Until -TimeoutMilliseconds 5000 -PollMilliseconds 100 -Condition {
    $matches = @(Get-VisibleTopWindows -ProcessId $ProcessId | Where-Object {
        $_.ClassName -eq '#32768' -and $_.Text -eq '' -and $_.Enabled -and $_.Left -eq 42 -and $_.Top -eq 28 -and $_.Width -eq 287 -and $_.Height -eq 491 -and $_.Owner -eq 0
      })
    if ($matches.Count -eq 1) { return $matches[0] }
    if ($matches.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_FILE_MENU_POPUP' -Message 'More than one qualified Captivate File popup appeared.' }
    return $null
  }
  Assert-Condition -Condition ($null -ne $filePopup) -Code 'FILE_MENU_POPUP_TIMEOUT' -Message 'The qualified Captivate File popup did not appear.'
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd -AllowedHandles @($filePopup.Hwnd) -AllowedClasses @('tooltips_class32')
  $fileItems = @([CatNative]::MenuItemsForPopup($filePopup.Hwnd))
  Assert-Condition -Condition ($fileItems.Count -eq 25) -Code 'FILE_MENU_PROFILE_CHANGED' -Message "Expected 25 qualified File-menu items; found $($fileItems.Count)."
  Assert-ExactMenuItem -Items $fileItems -Position 14 -Id 4294967295 -Text '&Export' -HasSubmenu $true -Code 'EXPORT_MENU_ITEM_CHANGED'

  Assert-Condition -Condition ([CatNative]::MoveCursorWithinRoot(185, 324, $filePopup.Hwnd)) -Code 'EXPORT_MENU_HOVER_TARGET_MISMATCH' -Message 'The qualified Export-row point did not resolve to the exact File popup; no input was sent.'
  $exportPopup = Wait-Until -TimeoutMilliseconds 5000 -PollMilliseconds 100 -Condition {
    $matches = @(Get-VisibleTopWindows -ProcessId $ProcessId | Where-Object {
        $_.Hwnd -ne $filePopup.Hwnd -and $_.ClassName -eq '#32768' -and $_.Text -eq '' -and $_.Enabled -and $_.Left -eq 323 -and $_.Top -eq 310 -and $_.Width -eq 306 -and $_.Height -eq 94 -and $_.Owner -eq $MainHwnd
      })
    if ($matches.Count -eq 1) { return $matches[0] }
    if ($matches.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_EXPORT_MENU_POPUP' -Message 'More than one qualified Captivate Export submenu appeared.' }
    return $null
  }
  Assert-Condition -Condition ($null -ne $exportPopup) -Code 'EXPORT_MENU_POPUP_TIMEOUT' -Message 'The qualified Captivate Export submenu did not appear after hovering the exact Export row.'
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd -AllowedHandles @($filePopup.Hwnd, $exportPopup.Hwnd) -AllowedClasses @('tooltips_class32')
  $exportItems = @([CatNative]::MenuItemsForPopup($exportPopup.Hwnd))
  Assert-Condition -Condition ($exportItems.Count -eq 4) -Code 'EXPORT_MENU_PROFILE_CHANGED' -Message "Expected four qualified Export-menu items; found $($exportItems.Count)."
  # Captivate assigns these leaf command IDs dynamically between launches. The
  # qualified action uses the exact stable positions, labels, state, and popup geometry.
  Assert-ExactMenuItem -Items $exportItems -Position 0 -Text 'Pr&eferences...' -HasSubmenu $false -Code 'EXPORT_PREFERENCES_ITEM_CHANGED'
  Assert-ExactMenuItem -Items $exportItems -Position 1 -Text 'P&roject Captions and Closed Captions...' -HasSubmenu $false -Code 'EXPORT_CAPTIONS_ITEM_CHANGED'
  Assert-ExactMenuItem -Items $exportItems -Position 2 -Text '&To XML...' -HasSubmenu $false -Code 'EXPORT_TO_XML_ITEM_CHANGED'
  Assert-ExactMenuItem -Items $exportItems -Position 3 -Text 'Styles...' -HasSubmenu $false -Code 'EXPORT_STYLES_ITEM_CHANGED'

  Assert-Condition -Condition ([CatNative]::MoveCursorWithinRoot(476, 368, $exportPopup.Hwnd)) -Code 'TO_XML_HOVER_TARGET_MISMATCH' -Message 'The qualified To XML point did not resolve to the exact Export popup; no input was sent.'
  Start-Sleep -Milliseconds 500
  $currentExportPopup = Get-WindowInfo -Hwnd $exportPopup.Hwnd
  Assert-Condition -Condition ($null -ne $currentExportPopup -and $currentExportPopup.Visible -and $currentExportPopup.Enabled -and $currentExportPopup.ClassName -eq '#32768' -and $currentExportPopup.Left -eq 323 -and $currentExportPopup.Top -eq 310 -and $currentExportPopup.Width -eq 306 -and $currentExportPopup.Height -eq 94) -Code 'EXPORT_MENU_MOVED_BEFORE_CLICK' -Message 'The qualified Export submenu changed before the To XML selection.'
  Assert-Condition -Condition ([CatNative]::ClickWithinRoot(476, 368, 1, $exportPopup.Hwnd)) -Code 'TO_XML_CLICK_TARGET_MISMATCH' -Message 'The qualified To XML point no longer resolved to the exact Export popup; no click was sent.'
  $menusClosed = Wait-Until -TimeoutMilliseconds 5000 -PollMilliseconds 100 -Condition {
    $fileClosed = -not [CatNative]::IsWindow([IntPtr]$filePopup.Hwnd) -or -not [CatNative]::IsWindowVisible([IntPtr]$filePopup.Hwnd)
    $exportClosed = -not [CatNative]::IsWindow([IntPtr]$exportPopup.Hwnd) -or -not [CatNative]::IsWindowVisible([IntPtr]$exportPopup.Hwnd)
    if ($fileClosed -and $exportClosed) { return $true }
    return $null
  }
  Assert-Condition -Condition ($menusClosed -eq $true) -Code 'XML_EXPORT_MENUS_DID_NOT_CLOSE' -Message 'Captivate menus remained visible after the exact To XML selection.'
}

function Get-XmlFileDialogControls {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$DialogHwnd
  )
  $descendants = @([CatNative]::AllWindowsForProcess($ProcessId, $true) | Where-Object { [CatNative]::RootWindow($_.Hwnd) -eq $DialogHwnd -and $_.Hwnd -ne $DialogHwnd })
  $edits = @($descendants | Where-Object { $_.ClassName -eq 'Edit' -and $_.Enabled -and [CatNative]::DialogControlId($_.Hwnd) -in @(1001, 1148) })
  $saveButtons = @($descendants | Where-Object { $_.ClassName -eq 'Button' -and $_.Enabled -and $_.Text -ceq '&Save' -and [CatNative]::DialogControlId($_.Hwnd) -eq 1 })
  if ($edits.Count -eq 1 -and $saveButtons.Count -eq 1) {
    return [PSCustomObject]@{
      EditHwnd = [long]$edits[0].Hwnd
      EditControlId = [int][CatNative]::DialogControlId($edits[0].Hwnd)
      SaveHwnd = [long]$saveButtons[0].Hwnd
    }
  }
  return $null
}

function Get-StandardXmlFileDialog {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd
  )
  $dialogs = @(Get-VisibleTopWindows -ProcessId $ProcessId | Where-Object {
      $_.ClassName -eq '#32770' -and $_.Text -eq 'Save As' -and $_.Enabled -and $_.Left -eq 0 -and $_.Top -eq 0 -and $_.Width -eq 1200 -and $_.Height -eq 720 -and $_.Owner -eq $MainHwnd
    })
  $qualified = New-Object 'System.Collections.Generic.List[object]'
  foreach ($dialog in $dialogs) {
    $controls = Get-XmlFileDialogControls -ProcessId $ProcessId -DialogHwnd $dialog.Hwnd
    if ($null -ne $controls) { $qualified.Add($dialog) }
  }
  if ($qualified.Count -eq 1) { return $qualified[0] }
  if ($qualified.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_XML_FILE_DIALOG' -Message 'More than one qualified XML export file dialog appeared.' }
  return $null
}

function Enter-XmlExportPath {
  param(
    [Parameter(Mandatory = $true)]$Dialog,
    [Parameter(Mandatory = $true)][string]$XmlPath
  )
  $mainHwnd = [long]$Dialog.Owner
  Assert-Condition -Condition ($mainHwnd -ne 0) -Code 'XML_FILE_DIALOG_OWNER_CHANGED' -Message 'The qualified Save As dialog no longer has the exact Captivate owner; no input was sent.'
  Assert-NoUnexpectedTopWindow -ProcessId $Dialog.ProcessId -MainHwnd $mainHwnd -AllowedHandles @($Dialog.Hwnd)
  $currentDialog = Get-StandardXmlFileDialog -ProcessId $Dialog.ProcessId -MainHwnd $mainHwnd
  Assert-Condition -Condition ($null -ne $currentDialog -and $currentDialog.Hwnd -eq $Dialog.Hwnd) -Code 'XML_FILE_DIALOG_CHANGED_BEFORE_ENTRY' -Message 'The qualified Save As dialog changed before filename entry; no input was sent.'
  $controls = Get-XmlFileDialogControls -ProcessId $Dialog.ProcessId -DialogHwnd $Dialog.Hwnd
  Assert-Condition -Condition ($null -ne $controls) -Code 'XML_FILE_DIALOG_CONTROLS_CHANGED' -Message 'The standard XML Save As dialog no longer exposes exactly one qualified file-name Edit and Save button.'
  $editRoot = [CatNative]::RootWindow($controls.EditHwnd)
  $saveRoot = [CatNative]::RootWindow($controls.SaveHwnd)
  Assert-Condition -Condition ($editRoot -eq $Dialog.Hwnd -and $saveRoot -eq $Dialog.Hwnd) -Code 'XML_FILE_DIALOG_CONTROL_ROOT_CHANGED' -Message 'The qualified filename Edit or Save button is no longer rooted in the exact Save As dialog; no input was sent.'
  Assert-Condition -Condition ([CatNative]::FocusControl($Dialog.Hwnd, $controls.EditHwnd)) -Code 'XML_FILE_NAME_FOCUS_FAILED' -Message 'Could not focus the qualified standard file-name Edit.'
  [CatNative]::CtrlKey(0x41)
  [CatNative]::TypeUnicode($XmlPath)
  # The modern shell filename Edit intentionally returns an empty WM_GETTEXT
  # value while its MSAA ROLE_SYSTEM_TEXT value exposes the displayed model.
  $qualifiedFileNameState = [uint32]0x00100004 # STATE_SYSTEM_FOCUSED | STATE_SYSTEM_FOCUSABLE
  $evidenceState = [PSCustomObject]@{ Last = 'none' }
  $evidenceRequest = [PSCustomObject]@{
    Mode = 'evidence'
    ProcessId = [int]$Dialog.ProcessId
    DialogHwnd = [long]$Dialog.Hwnd
    OwnerHwnd = $mainHwnd
    EditHwnd = [long]$controls.EditHwnd
    EditControlId = [int]$controls.EditControlId
    SaveHwnd = 0
    Left = 0
    Top = 0
    Width = 1200
    Height = 720
    ExpectedName = ''
    ExpectedValue = ''
    ExpectedRole = 0
    ExpectedState = [uint32]0
    TargetPath = ''
  }
  $enteredEvidence = Wait-Until -TimeoutMilliseconds 12000 -PollMilliseconds 100 -Condition {
    Assert-NoUnexpectedTopWindow -ProcessId $Dialog.ProcessId -MainHwnd $mainHwnd -AllowedHandles @($Dialog.Hwnd)
    $evidenceResponse = Invoke-BoundedAccessibilityHelper -Mode 'evidence' -Request $evidenceRequest -TimeoutMilliseconds $script:AccessibilityEvidenceTimeoutMilliseconds
    $candidate = Get-PropertyValue -Object $evidenceResponse -Name 'Evidence' -Default $null
    if ($null -eq $candidate) {
      $evidenceState.Last = 'none'
      return $null
    }
    $evidenceState.Last = "available=$($candidate.Available),name='$($candidate.Name)',role=$($candidate.Role),state=0x$('{0:X8}' -f [uint32]$candidate.State),error='$($candidate.Error)'"
    $qualifiedEvidence = $candidate.Available -and $candidate.Name -ceq 'File name:' -and $candidate.Role -eq 42 -and $candidate.State -eq $qualifiedFileNameState -and $candidate.Value -ceq $XmlPath
    if ($qualifiedEvidence) { return $candidate }
    return $null
  }
  Assert-Condition -Condition ($null -ne $enteredEvidence) -Code 'XML_FILE_NAME_ENTRY_MISMATCH' -Message "Actual keyboard entry did not produce the exact qualified ROLE_SYSTEM_TEXT filename accessibility model; observed $($evidenceState.Last)."

  # Requalify the full dialog/control chain before delegating one bounded helper
  # operation. That child repeats the exact dialog, Edit, accessibility model,
  # target nonexistence, and Save-button checks immediately before BM_CLICK.
  Assert-NoUnexpectedTopWindow -ProcessId $Dialog.ProcessId -MainHwnd $mainHwnd -AllowedHandles @($Dialog.Hwnd)
  $finalDialog = Get-StandardXmlFileDialog -ProcessId $Dialog.ProcessId -MainHwnd $mainHwnd
  Assert-Condition -Condition ($null -ne $finalDialog -and $finalDialog.Hwnd -eq $Dialog.Hwnd) -Code 'XML_FILE_DIALOG_CHANGED_BEFORE_SAVE' -Message 'The qualified Save As dialog changed before Save; no button input was sent.'
  $finalControls = Get-XmlFileDialogControls -ProcessId $Dialog.ProcessId -DialogHwnd $Dialog.Hwnd
  Assert-Condition -Condition ($null -ne $finalControls -and $finalControls.EditHwnd -eq $controls.EditHwnd -and $finalControls.EditControlId -eq $controls.EditControlId -and $finalControls.SaveHwnd -eq $controls.SaveHwnd) -Code 'XML_FILE_DIALOG_CONTROLS_CHANGED_BEFORE_SAVE' -Message 'The qualified filename Edit or Save button changed before Save; no button input was sent.'
  $finalEditRoot = [CatNative]::RootWindow($finalControls.EditHwnd)
  $finalSaveRoot = [CatNative]::RootWindow($finalControls.SaveHwnd)
  Assert-Condition -Condition ($finalEditRoot -eq $Dialog.Hwnd -and $finalSaveRoot -eq $Dialog.Hwnd) -Code 'XML_FILE_DIALOG_CONTROL_ROOT_CHANGED_BEFORE_SAVE' -Message 'The requalified filename Edit or Save button is not rooted in the exact Save As dialog; no button input was sent.'
  $saveRequest = [PSCustomObject]@{
    Mode = 'save'
    ProcessId = [int]$Dialog.ProcessId
    DialogHwnd = [long]$Dialog.Hwnd
    OwnerHwnd = $mainHwnd
    EditHwnd = [long]$finalControls.EditHwnd
    EditControlId = [int]$finalControls.EditControlId
    SaveHwnd = [long]$finalControls.SaveHwnd
    Left = 0
    Top = 0
    Width = 1200
    Height = 720
    ExpectedName = 'File name:'
    ExpectedValue = $XmlPath
    ExpectedRole = 42
    ExpectedState = $qualifiedFileNameState
    TargetPath = $XmlPath
  }
  $saveResponse = Invoke-BoundedAccessibilityHelper -Mode 'save' -Request $saveRequest -TimeoutMilliseconds $script:AccessibilitySaveTimeoutMilliseconds
  $saveClicked = Get-PropertyValue -Object $saveResponse -Name 'Clicked' -Default $false
  Assert-Condition -Condition ($saveClicked -eq $true) -Code 'XML_FILE_DIALOG_SAVE_REJECTED' -Message 'The bounded helper did not complete the exact evidence-bound Save button action.'
}

function Wait-FileStable {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
    [Parameter(Mandatory = $true)][string]$Code
  )
  $stability = [PSCustomObject]@{ lastSignature = $null; stableSamples = 0 }
  $result = Wait-Until -TimeoutMilliseconds $TimeoutMilliseconds -PollMilliseconds 250 -Condition {
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if ($item.Length -le 0) { return $null }
    $signature = "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
    if ($signature -eq $stability.lastSignature) { $stability.stableSamples++ } else { $stability.lastSignature = $signature; $stability.stableSamples = 0 }
    if ($stability.stableSamples -ge 3) { return $item }
    return $null
  }
  Assert-Condition -Condition ($null -ne $result) -Code $Code -Message "File did not appear and stabilize before timeout: $LiteralPath"
  return $result
}

function Wait-FileChangedAndStable {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$BaselineSha256,
    [Parameter(Mandatory = $true)][long]$BaselineWriteTicks,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
    [Parameter(Mandatory = $true)][string]$Code
  )
  $state = [PSCustomObject]@{ changeObserved = $false; lastSignature = $null; stableSamples = 0; changedHash = $null }
  $result = Wait-Until -TimeoutMilliseconds $TimeoutMilliseconds -PollMilliseconds 300 -Condition {
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if ($item.Length -le 0) { return $null }
    $currentHash = $null
    try { $currentHash = Get-Sha256 -LiteralPath $LiteralPath } catch { return $null }
    if ($item.LastWriteTimeUtc.Ticks -ne $BaselineWriteTicks -or $currentHash -ne $BaselineSha256) {
      $state.changeObserved = $true
      $state.changedHash = $currentHash
    }
    if (-not $state.changeObserved -or $currentHash -eq $BaselineSha256) { return $null }
    $signature = "$($item.Length):$($item.LastWriteTimeUtc.Ticks):$currentHash"
    if ($signature -eq $state.lastSignature) { $state.stableSamples++ } else { $state.lastSignature = $signature; $state.stableSamples = 0 }
    if ($state.stableSamples -ge 3) { return [ordered]@{ item = $item; sha256 = $currentHash } }
    return $null
  }
  Assert-Condition -Condition ($null -ne $result) -Code $Code -Message "The project file did not observably change from its baseline and stabilize before timeout: $LiteralPath"
  return $result
}

function Test-ExclusiveFileAccess {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  try {
    $stream = [IO.File]::Open($LiteralPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.Dispose()
    return $true
  } catch { return $false }
}

function Close-OwnedCaptivateNormally {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][long]$MainHwnd
  )
  Assert-OwnedProcessIsExclusive -Process $Process
  Assert-NoUnexpectedTopWindow -ProcessId $Process.Id -MainHwnd $MainHwnd
  $mainWithText = Get-WindowInfo -Hwnd $MainHwnd
  Assert-Condition -Condition ($null -ne $mainWithText -and -not $mainWithText.Text.TrimEnd().EndsWith('*')) -Code 'CAPTIVATE_DIRTY_DURING_CLOSE' -Message 'Captivate still reports unsaved changes, so no close request was sent.'
  $Process.Refresh()
  Assert-Condition -Condition ($Process.MainWindowHandle.ToInt64() -eq $MainHwnd) -Code 'CAPTIVATE_MAIN_WINDOW_CHANGED' -Message 'Captivate main-window identity changed before normal close.'
  Assert-Condition -Condition ($Process.CloseMainWindow()) -Code 'CAPTIVATE_NORMAL_CLOSE_REJECTED' -Message 'Captivate rejected the normal Windows close request.'
  $exited = Wait-Until -TimeoutMilliseconds 30000 -PollMilliseconds 250 -Condition {
    $Process.Refresh()
    if ($Process.HasExited) { return $true }
    $unexpected = @(Get-VisibleTopWindows -ProcessId $Process.Id | Where-Object { $_.Hwnd -ne $MainHwnd })
    if ($unexpected.Count -gt 0) {
      $summary = ($unexpected | ForEach-Object { "[$($_.ClassName)] $($_.Text)" }) -join '; '
      Stop-Driver -Code 'UNEXPECTED_WINDOW_DURING_CLOSE' -Message "Captivate displayed an unexpected window during normal close: $summary"
    }
    return $null
  }
  Assert-Condition -Condition ($exited -eq $true) -Code 'CAPTIVATE_NORMAL_CLOSE_TIMEOUT' -Message 'Captivate did not exit after the guarded normal close request. It was not force-killed.'
  $script:ConfirmedProcessExit = $true
  $script:OwnedProcess = $null
  Add-AuditRecord -Stage $script:Stage -Message 'Captivate exited through a guarded normal main-window close with no unsaved-change marker.'
  Assert-NoCaptivateProcess
}

function Request-BoundedNormalCloseAfterFailure {
  if ($script:AccessibilityHelperTerminationUnconfirmed) {
    Add-AuditRecord -Stage $script:Stage -Message "Did not request failure cleanup because accessibility helper PID $($script:AccessibilityHelperProcessId) could not be confirmed terminated; no Captivate close or other UI action was sent."
    return
  }
  if ($null -eq $script:OwnedProcess) { return }
  $licensingFailure = $script:LicensingHandoffActive -or $script:Stage -eq 'await-continue-trial' -or $script:FailureCode -match '(?i)(?:LICENSING|TRIAL_REMINDER|CONTINUE_TRIAL)'
  if ($licensingFailure) {
    Add-AuditRecord -Stage $script:Stage -Message 'Did not request failure cleanup after a licensing/trial failure; no WM_CLOSE was sent and staging is retained.'
    return
  }
  try {
    $script:OwnedProcess.Refresh()
    if ($script:OwnedProcess.HasExited) {
      $script:ConfirmedProcessExit = $true
      $script:OwnedProcess = $null
      Add-AuditRecord -Stage $script:Stage -Message 'Confirmed that the owned Captivate process had already exited after failure.'
      return
    }

    $running = @(Get-Process -Name 'AdobeCaptivateClassic' -ErrorAction SilentlyContinue)
    if ($running.Count -ne 1 -or $running[0].Id -ne $script:OwnedProcess.Id) {
      Add-AuditRecord -Stage $script:Stage -Message 'Did not request failure cleanup because Captivate process ownership was no longer unique.'
      return
    }
    $main = Get-MainCaptivateWindow -ProcessId $script:OwnedProcess.Id
    if ($null -eq $main) {
      Add-AuditRecord -Stage $script:Stage -Message 'Did not request failure cleanup because the owned Captivate main window could not be identified uniquely.'
      return
    }

    $mainWithText = Get-WindowInfo -Hwnd $main.Hwnd
    if ($null -eq $mainWithText -or $mainWithText.Text.TrimEnd().EndsWith('*')) {
      Add-AuditRecord -Stage $script:Stage -Message 'Did not request failure cleanup because the Captivate project title is unavailable or ends with the dirty-project marker (*); staging is retained.'
      return
    }
    $unexpected = @(Get-VisibleTopWindows -ProcessId $script:OwnedProcess.Id | Where-Object { $_.Hwnd -ne $main.Hwnd })
    $visibleLicensing = @(Get-VisibleAdobeLicensingWindows)
    if (-not $mainWithText.Enabled -or $unexpected.Count -gt 0 -or $visibleLicensing.Count -gt 0) {
      Add-AuditRecord -Stage $script:Stage -Message 'Did not request failure cleanup because Captivate is disabled by a modal state or an unexpected Captivate/Adobe licensing top window is visible; staging is retained.'
      return
    }

    Add-AuditRecord -Stage $script:Stage -Message 'Requesting one bounded normal WM_CLOSE after failure; no prompt will be answered and no process will be force-killed.'
    if (-not [CatNative]::CloseWindow($main.Hwnd)) {
      Add-AuditRecord -Stage $script:Stage -Message 'The owned Captivate window did not accept the bounded normal close request.'
      return
    }
    $exited = Wait-Until -TimeoutMilliseconds 15000 -PollMilliseconds 250 -Condition {
      $script:OwnedProcess.Refresh()
      if ($script:OwnedProcess.HasExited) { return $true }
      return $null
    }
    if ($exited -eq $true) {
      $script:ConfirmedProcessExit = $true
      $script:OwnedProcess = $null
      Add-AuditRecord -Stage $script:Stage -Message 'Owned Captivate process exited after the bounded normal close request.'
    } else {
      Add-AuditRecord -Stage $script:Stage -Message 'Owned Captivate process remains running after the bounded normal close request; staging is retained.'
    }
  } catch {
    Add-AuditRecord -Stage $script:Stage -Message "Bounded normal-close cleanup could not be confirmed: $($_.Exception.Message)"
  }
}

function Get-ExactXmlSuccessDialog {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $expectedPrompt = "XML Export was successful.`r`nDo you want to open the file?"
  $expectedNormalized = Get-NormalizedWhitespace -Value $expectedPrompt
  $dialogs = @(Get-VisibleTopWindows -ProcessId $ProcessId | Where-Object { $_.ClassName -eq '#32770' -and $_.Text -eq 'Adobe Captivate' -and $_.Enabled })
  $matches = New-Object 'System.Collections.Generic.List[object]'
  foreach ($dialog in $dialogs) {
    $all = @([CatNative]::AllWindowsForProcess($ProcessId, $true))
    $hasDrover = @($all | Where-Object { [CatNative]::RootWindow($_.Hwnd) -eq $dialog.Hwnd -and $_.ClassName -like 'DroverLord - Window Class*' }).Count -gt 0
    if (-not $hasDrover) { continue }
    $stringsRequest = [PSCustomObject]@{
      Mode = 'strings'
      ProcessId = $ProcessId
      DialogHwnd = [long]$dialog.Hwnd
      OwnerHwnd = 0
      EditHwnd = 0
      EditControlId = 0
      SaveHwnd = 0
      Left = 0
      Top = 0
      Width = 0
      Height = 0
      ExpectedName = ''
      ExpectedValue = ''
      ExpectedRole = 0
      ExpectedState = [uint32]0
      TargetPath = ''
    }
    $stringsResponse = Invoke-BoundedAccessibilityHelper -Mode 'strings' -Request $stringsRequest -TimeoutMilliseconds $script:AccessibilityStringsTimeoutMilliseconds
    $rawStrings = @(Get-PropertyValue -Object $stringsResponse -Name 'Strings' -Default @())
    $strings = @($rawStrings | ForEach-Object { Get-NormalizedWhitespace -Value ([string]$_) })
    $promptMatches = @($strings | Where-Object { $_ -eq $expectedNormalized })
    if ($promptMatches.Count -ge 2) { $matches.Add($dialog) }
  }
  if ($matches.Count -eq 1) { return $matches[0] }
  if ($matches.Count -gt 1) { Stop-Driver -Code 'AMBIGUOUS_XML_SUCCESS_PROMPT' -Message 'More than one exact XML export success prompt appeared.' }
  return $null
}

function Read-SafeXmlDocument {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $settings = New-Object Xml.XmlReaderSettings
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $stream = [IO.File]::Open($LiteralPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $reader = [Xml.XmlReader]::Create($stream, $settings)
    try {
      $document = New-Object Xml.XmlDocument
      $document.XmlResolver = $null
      $document.Load($reader)
      return $document
    } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function Confirm-XmlAttestation {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][object[]]$Slides
  )
  try { $document = Read-SafeXmlDocument -LiteralPath $LiteralPath }
  catch { Stop-Driver -Code 'XML_VERIFICATION_PARSE_FAILED' -Message "Captivate's exported XML could not be parsed safely: $($_.Exception.Message)" }

  $upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  $lower = 'abcdefghijklmnopqrstuvwxyz'
  $countNodes = @($document.SelectNodes("//*[translate(local-name(), '$upper', '$lower')='count' and @unit='x-cp-slides' and @count-type='total']"))
  Assert-Condition -Condition ($countNodes.Count -eq 1) -Code 'XML_SCHEMA_UNRECOGNIZED' -Message "Expected exactly one XLIFF x-cp-slides total count; found $($countNodes.Count)."
  $declaredSlideCount = 0
  $declaredCountText = Get-NormalizedWhitespace -Value $countNodes[0].InnerText
  Assert-Condition -Condition ([int]::TryParse($declaredCountText, [ref]$declaredSlideCount)) -Code 'XML_SCHEMA_UNRECOGNIZED' -Message 'The XLIFF x-cp-slides count was not an integer.'

  $slideNodes = @($document.SelectNodes("//*[translate(local-name(), '$upper', '$lower')='slide' and @restype='x-cp-standard-slide']"))
  Assert-Condition -Condition ($slideNodes.Count -gt 0) -Code 'XML_SCHEMA_UNRECOGNIZED' -Message 'The exported XML contained no x-cp-standard-slide project slides.'
  Assert-Condition -Condition ($declaredSlideCount -eq $Slides.Count -and $slideNodes.Count -eq $Slides.Count) -Code 'XML_SLIDE_COUNT_MISMATCH' -Message "Expected $($Slides.Count) project slides; XLIFF declared $declaredSlideCount and contained $($slideNodes.Count) x-cp-standard-slide elements."

  for ($index = 0; $index -lt $Slides.Count; $index++) {
    $slideValues = New-Object 'System.Collections.Generic.List[string]'
    foreach ($node in @($slideNodes[$index].SelectNodes('.//text()[normalize-space(.) != ""] | .//@*'))) {
      $normalized = Get-NormalizedWhitespace -Value $node.Value
      if (-not [string]::IsNullOrWhiteSpace($normalized)) { $slideValues.Add($normalized) }
    }
    $expectedTitle = Get-NormalizedWhitespace -Value ([string]$Slides[$index].title)
    Assert-Condition -Condition ($slideValues -contains $expectedTitle) -Code 'XML_MARKER_TITLE_MISSING' -Message "Project slide $($index + 1) did not contain its exact marker title '$expectedTitle'."
    if ($index -eq 0) {
      $expectedSubtitle = Get-NormalizedWhitespace -Value ([string]$Slides[0].subtitle)
      Assert-Condition -Condition ($slideValues -contains $expectedSubtitle) -Code 'XML_MARKER_SUBTITLE_MISSING' -Message "The title slide did not contain its exact marker subtitle '$expectedSubtitle'."
    }
  }
  return [ordered]@{ slideCount = $slideNodes.Count; markerTitles = @($Slides | ForEach-Object { [string]$_.title }) }
}

function Remove-StagingDirectorySafely {
  if ([string]::IsNullOrWhiteSpace($script:StagingRoot) -or -not (Test-Path -LiteralPath $script:StagingRoot -PathType Container)) { return }
  Assert-Condition -Condition ($script:ConfirmedProcessExit) -Code 'STAGING_CLEANUP_WITH_PROCESS_RUNNING' -Message 'Refusing to clean staging before Captivate exit is confirmed.'
  $staging = Get-Item -LiteralPath $script:StagingRoot -Force
  $parent = $staging.Parent
  Assert-Condition -Condition ($staging.Name -match '^\.compos-a-toast-captivate-[a-f0-9]{32}$') -Code 'UNSAFE_STAGING_PATH' -Message 'Refusing to remove a staging directory whose name does not match the driver-created pattern.'
  Assert-Condition -Condition (($staging.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -Code 'UNSAFE_STAGING_REPARSE_POINT' -Message 'Refusing to remove a staging directory that became a reparse point.'
  $expectedParent = if ($script:StagingCptxPath) { [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($script:StagingCptxPath)) } else { $parent.FullName }
  Assert-Condition -Condition ($parent.FullName -eq $expectedParent) -Code 'UNSAFE_STAGING_PARENT' -Message 'Refusing to remove staging outside its verified output parent.'
  Remove-Item -LiteralPath $staging.FullName -Recurse -Force
}

function Save-ProjectInPlace {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][string]$ProjectPath
  )
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  $beforeSave = Get-Item -LiteralPath $ProjectPath -Force
  $baselineWriteTicks = $beforeSave.LastWriteTimeUtc.Ticks
  $baselineHash = Get-Sha256 -LiteralPath $ProjectPath
  Set-CaptivateForegroundOrFail -MainHwnd $MainHwnd -Message 'Captivate could not be focused for Ctrl+S.'
  [CatNative]::CtrlKey(0x53)
  $saved = Wait-FileChangedAndStable -LiteralPath $ProjectPath -BaselineSha256 $baselineHash -BaselineWriteTicks $baselineWriteTicks -TimeoutMilliseconds 45000 -Code 'CAPTIVATE_SAVE_TIMEOUT'
  Assert-NoUnexpectedTopWindow -ProcessId $ProcessId -MainHwnd $MainHwnd
  return $saved.sha256
}

function Invoke-XmlExportAndVerify {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][long]$MainHwnd,
    [Parameter(Mandatory = $true)][string]$XmlPath,
    [Parameter(Mandatory = $true)][object[]]$Slides
  )
  Assert-NoUnexpectedTopWindow -ProcessId $Process.Id -MainHwnd $MainHwnd
  Open-ExactXmlExportDialog -ProcessId $Process.Id -MainHwnd $MainHwnd

  $dialog = Wait-Until -TimeoutMilliseconds 20000 -Condition { Get-StandardXmlFileDialog -ProcessId $Process.Id -MainHwnd $MainHwnd }
  Assert-Condition -Condition ($null -ne $dialog) -Code 'XML_FILE_DIALOG_TIMEOUT' -Message 'The qualified standard XML export file dialog did not appear.'
  Assert-NoUnexpectedTopWindow -ProcessId $Process.Id -MainHwnd $MainHwnd -AllowedHandles @($dialog.Hwnd)
  Enter-XmlExportPath -Dialog $dialog -XmlPath $XmlPath
  $dialogClosed = Wait-Until -TimeoutMilliseconds 20000 -Condition { -not [CatNative]::IsWindow([IntPtr]$dialog.Hwnd) }
  Assert-Condition -Condition ($dialogClosed -eq $true) -Code 'XML_FILE_DIALOG_DID_NOT_CLOSE' -Message 'The XML export file dialog did not close after the qualified Save button was invoked.'
  $xmlFile = Wait-FileStable -LiteralPath $XmlPath -TimeoutMilliseconds 30000 -Code 'XML_EXPORT_FILE_TIMEOUT'

  $successDialog = Wait-Until -TimeoutMilliseconds 20000 -Condition { Get-ExactXmlSuccessDialog -ProcessId $Process.Id }
  Assert-Condition -Condition ($null -ne $successDialog) -Code 'XML_SUCCESS_PROMPT_TIMEOUT' -Message 'The exact Captivate XML export success prompt did not appear; no dialog was dismissed.'
  Assert-Condition -Condition ((Test-Path -LiteralPath $XmlPath -PathType Leaf) -and $xmlFile.Length -gt 0) -Code 'XML_SUCCESS_WITHOUT_FILE' -Message 'The exact success prompt appeared without a stable expected XML file.'
  Assert-NoUnexpectedTopWindow -ProcessId $Process.Id -MainHwnd $MainHwnd -AllowedHandles @($successDialog.Hwnd)
  Assert-Condition -Condition ([CatNative]::CloseWindow($successDialog.Hwnd)) -Code 'XML_SUCCESS_DECLINE_FAILED' -Message 'The exact XML success prompt did not accept the profile-qualified WM_CLOSE decline action.'
  $successClosed = Wait-Until -TimeoutMilliseconds 10000 -Condition { -not [CatNative]::IsWindow([IntPtr]$successDialog.Hwnd) }
  Assert-Condition -Condition ($successClosed -eq $true) -Code 'XML_SUCCESS_DECLINE_TIMEOUT' -Message 'The exact XML success prompt remained visible after WM_CLOSE.'
  Assert-NoUnexpectedTopWindow -ProcessId $Process.Id -MainHwnd $MainHwnd
  return Confirm-XmlAttestation -LiteralPath $XmlPath -Slides $Slides
}

$exitCode = 1
$terminalResult = $null

try {
  Set-DriverStage -Name 'read-job' -Message 'Reading and validating the Captivate driver job.'
  $resolvedJobPath = Resolve-RegularFile -LiteralPath $JobPath -Code 'JOB_NOT_FOUND' -Label 'Job JSON'
  $jobItem = Get-Item -LiteralPath $resolvedJobPath
  Assert-Condition -Condition ($jobItem.Length -le 1MB) -Code 'JOB_TOO_LARGE' -Message 'The driver job exceeds the 1 MiB limit.'
  try { $job = Get-Content -LiteralPath $resolvedJobPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Stop-Driver -Code 'INVALID_JOB_JSON' -Message "Could not parse job JSON: $($_.Exception.Message)" }

  $schemaVersion = [int](Get-PropertyValue -Object $job -Name 'schemaVersion' -Default 0)
  Assert-Condition -Condition ($schemaVersion -eq $script:DriverSchemaVersion) -Code 'UNSUPPORTED_JOB_SCHEMA' -Message "Expected job schemaVersion $($script:DriverSchemaVersion)."
  $script:Mode = ([string](Get-PropertyValue -Object $job -Name 'mode' -Default '')).ToLowerInvariant()
  Assert-Condition -Condition ($script:Mode -in @('verify', 'export')) -Code 'INVALID_MODE' -Message 'mode must be verify or export.'

  Set-DriverStage -Name 'preflight' -Message 'Verifying the pinned Captivate executable, seed, desktop profile, and idle process state.'
  Assert-Condition -Condition ($env:OS -eq 'Windows_NT') -Code 'UNSUPPORTED_PLATFORM' -Message 'The Captivate Classic driver runs only on Windows.'
  Assert-DesktopProfile
  Assert-NoCaptivateProcess
  $executablePath = Resolve-RegularFile -LiteralPath ([string](Get-PropertyValue -Object $job -Name 'executablePath' -Default '')) -Code 'CAPTIVATE_EXECUTABLE_NOT_FOUND' -Label 'Captivate executable'
  $script:ExecutableAttestation = Get-CaptivateAttestation -ExecutablePath $executablePath
  $script:SeedPath = Resolve-RegularFile -LiteralPath ([string](Get-PropertyValue -Object $job -Name 'seedCptxPath' -Default '')) -Code 'SEED_NOT_FOUND' -Label 'Seed CPTX'
  Assert-Condition -Condition ([IO.Path]::GetExtension($script:SeedPath) -ieq '.cptx') -Code 'INVALID_SEED_EXTENSION' -Message 'The seed project must have a .cptx extension.'
  $script:SeedHashBefore = Get-Sha256 -LiteralPath $script:SeedPath
  Test-ExpectedSeedHash -Expected ([string](Get-PropertyValue -Object $job -Name 'expectedSeedSha256' -Default '')) -Actual $script:SeedHashBefore

  $outputPathRaw = [string](Get-PropertyValue -Object $job -Name 'outputCptxPath' -Default '')
  $outputPath = $null
  if (-not [string]::IsNullOrWhiteSpace($outputPathRaw)) {
    Assert-Condition -Condition ([IO.Path]::IsPathRooted($outputPathRaw)) -Code 'INVALID_OUTPUT_PATH' -Message 'outputCptxPath must be absolute.'
    $outputPath = [IO.Path]::GetFullPath($outputPathRaw)
    Assert-Condition -Condition ([IO.Path]::GetExtension($outputPath) -ieq '.cptx') -Code 'INVALID_OUTPUT_EXTENSION' -Message 'outputCptxPath must have a .cptx extension.'
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $outputPath)) -Code 'OUTPUT_ALREADY_EXISTS' -Message 'The output CPTX already exists; this driver never overwrites output.'
    $outputParent = Resolve-ExistingDirectory -LiteralPath ([IO.Path]::GetDirectoryName($outputPath)) -Code 'OUTPUT_PARENT_NOT_FOUND' -Label 'Output parent directory'
    Assert-Condition -Condition ($outputPath -ne $script:SeedPath) -Code 'OUTPUT_EQUALS_SEED' -Message 'The output path may not equal the seed CPTX path.'
  }

  if ($script:Mode -eq 'verify') {
    $seedHashAfter = Get-Sha256 -LiteralPath $script:SeedPath
    Assert-Condition -Condition ($seedHashAfter -eq $script:SeedHashBefore) -Code 'SEED_CHANGED_DURING_VERIFY' -Message 'The seed CPTX changed during verification.'
    Set-DriverStage -Name 'complete' -Message 'The Captivate Classic 11.8.4.21 automation profile is eligible for an export attempt.'
    $terminalResult = [ordered]@{
      type = 'result'; schemaVersion = $script:DriverSchemaVersion; ok = $true; mode = $script:Mode; stage = 'complete'
      attestation = [ordered]@{
        driverProfile = $script:DriverProfile
        desktop = [ordered]@{ processDpiAwareness = 0; logicalDpi = 96; primaryScalePercent = $script:PrimaryScalePercent }
        captivate = $script:ExecutableAttestation
        seed = [ordered]@{ path = $script:SeedPath; sha256 = $script:SeedHashBefore; unchanged = $true }
        requestedSlideCount = 0
        processIds = @()
        processExitConfirmed = $true
        outputPromoted = $false
        startedAt = $script:StartedAt.ToString('o')
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        stages = @($script:Audit | ForEach-Object { $_.stage })
      }
    }
    $exitCode = 0
  } else {
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($outputPathRaw)) -Code 'MISSING_OUTPUT_PATH' -Message 'Export jobs require outputCptxPath.'
    $script:RequestedSlides = @(Get-ValidatedSlides -Job $job)

    Set-DriverStage -Name 'prepare-staging' -Message 'Cloning the immutable seed into an exclusive staging directory.'
    $stagingName = '.compos-a-toast-captivate-' + [Guid]::NewGuid().ToString('N')
    $script:StagingRoot = Join-Path $outputParent $stagingName
    # Windows PowerShell 5.1 exposes -Path (not -LiteralPath) on New-Item. This path is
    # driver-generated from a GUID and cannot contain wildcard input.
    [void](New-Item -ItemType Directory -Path $script:StagingRoot)
    $script:StagingCptxPath = Join-Path $script:StagingRoot ([IO.Path]::GetFileName($outputPath))
    $script:StagingXmlPath = Join-Path $script:StagingRoot 'captivate-verification.xml'
    [IO.File]::Copy($script:SeedPath, $script:StagingCptxPath, $false)
    [IO.File]::SetAttributes($script:StagingCptxPath, [IO.FileAttributes]::Normal)
    $cloneHash = Get-Sha256 -LiteralPath $script:StagingCptxPath
    $seedAfterClone = Get-Sha256 -LiteralPath $script:SeedPath
    Assert-Condition -Condition ($cloneHash -eq $script:SeedHashBefore -and $seedAfterClone -eq $script:SeedHashBefore) -Code 'SEED_CLONE_HASH_MISMATCH' -Message 'The staged clone is not byte-identical to the unchanged seed CPTX.'

    Set-DriverStage -Name 'author-project' -Message 'Opening the staged seed and creating native slide titles in the qualified profile.'
    $process = Start-OwnedCaptivate -ExecutablePath $executablePath -ProjectPath $script:StagingCptxPath -WorkingDirectory $script:StagingRoot
    $main = Wait-MainCaptivateWindow -Process $process
    Assert-OwnedProcessIsExclusive -Process $process
    [void](Wait-ForExactTrialReminder -ProcessId $process.Id -MainHwnd $main.Hwnd)
    Assert-NoUnexpectedTopWindow -ProcessId $process.Id -MainHwnd $main.Hwnd

    Set-NativeTextAtProfilePoint -ProcessId $process.Id -MainHwnd $main.Hwnd -X 700 -Y 350 -Text ([string]$script:RequestedSlides[0].title) -Label 'title-slide title'
    Set-NativeTextAtProfilePoint -ProcessId $process.Id -MainHwnd $main.Hwnd -X 700 -Y 430 -Text ([string]$script:RequestedSlides[0].subtitle) -Label 'title-slide subtitle'

    $propertiesCollapsed = $false
    for ($index = 1; $index -lt $script:RequestedSlides.Count; $index++) {
      Add-ContentSlide -ProcessId $process.Id -MainHwnd $main.Hwnd
      if (-not $propertiesCollapsed) {
        Invoke-ProfileClick -MainHwnd $main.Hwnd -X 1230 -Y 62
        Start-Sleep -Milliseconds 300
        Assert-NoUnexpectedTopWindow -ProcessId $process.Id -MainHwnd $main.Hwnd
        $propertiesCollapsed = $true
        Add-AuditRecord -Stage $script:Stage -Message 'Toggled Properties once using the qualified profile point before content-title entry.'
      }
      Set-NativeTextAtProfilePoint -ProcessId $process.Id -MainHwnd $main.Hwnd -X 700 -Y 580 -Text ([string]$script:RequestedSlides[$index].title) -Label "content-slide $($index + 1) title"
    }

    Set-DriverStage -Name 'save-project' -Message 'Saving the staged CPTX in place with Ctrl+S.'
    $savedHash = Save-ProjectInPlace -ProcessId $process.Id -MainHwnd $main.Hwnd -ProjectPath $script:StagingCptxPath
    Assert-Condition -Condition ($savedHash -ne $script:SeedHashBefore) -Code 'SAVE_DID_NOT_CHANGE_PROJECT' -Message 'The saved staged CPTX is still byte-identical to the seed; native edits were not proven.'

    Set-DriverStage -Name 'close-after-save' -Message 'Closing Captivate normally after the in-place save.'
    Close-OwnedCaptivateNormally -Process $process -MainHwnd $main.Hwnd
    Assert-Condition -Condition (Test-ExclusiveFileAccess -LiteralPath $script:StagingCptxPath) -Code 'PROJECT_NOT_RELEASED_AFTER_SAVE' -Message 'The saved staged CPTX is still locked after confirmed Captivate exit.'
    $hashBeforeReopen = Get-Sha256 -LiteralPath $script:StagingCptxPath
    Assert-Condition -Condition ($hashBeforeReopen -eq $savedHash) -Code 'SAVED_PROJECT_HASH_CHANGED_BEFORE_REOPEN' -Message 'The staged CPTX bytes changed after the proven save and before independent reopen verification.'

    Set-DriverStage -Name 'reopen-project' -Message 'Reopening the saved CPTX for independent XML verification.'
    $reopenProcess = Start-OwnedCaptivate -ExecutablePath $executablePath -ProjectPath $script:StagingCptxPath -WorkingDirectory $script:StagingRoot
    $reopenMain = Wait-MainCaptivateWindow -Process $reopenProcess
    Assert-OwnedProcessIsExclusive -Process $reopenProcess
    [void](Wait-ForExactTrialReminder -ProcessId $reopenProcess.Id -MainHwnd $reopenMain.Hwnd)
    Assert-NoUnexpectedTopWindow -ProcessId $reopenProcess.Id -MainHwnd $reopenMain.Hwnd

    Set-DriverStage -Name 'export-verification-xml' -Message 'Exporting XML through the version-pinned native File > Export > To XML path.'
    $xmlVerification = Invoke-XmlExportAndVerify -Process $reopenProcess -MainHwnd $reopenMain.Hwnd -XmlPath $script:StagingXmlPath -Slides $script:RequestedSlides
    $xmlItem = Get-Item -LiteralPath $script:StagingXmlPath -Force
    $xmlSize = [long]$xmlItem.Length
    Assert-Condition -Condition ($xmlSize -gt 0) -Code 'XML_EXPORT_EMPTY' -Message 'The verified Captivate XML export is empty.'
    $xmlHash = Get-Sha256 -LiteralPath $script:StagingXmlPath

    Set-DriverStage -Name 'close-after-verification' -Message 'Closing Captivate normally after XML verification.'
    Close-OwnedCaptivateNormally -Process $reopenProcess -MainHwnd $reopenMain.Hwnd
    Assert-Condition -Condition (Test-ExclusiveFileAccess -LiteralPath $script:StagingCptxPath) -Code 'PROJECT_NOT_RELEASED_AFTER_VERIFICATION' -Message 'The verified CPTX is still locked after confirmed Captivate exit.'
    $hashAfterVerification = Get-Sha256 -LiteralPath $script:StagingCptxPath
    Assert-Condition -Condition ($hashAfterVerification -eq $savedHash) -Code 'VERIFIED_PROJECT_HASH_CHANGED_AFTER_REOPEN' -Message 'The CPTX bytes no longer match the exact saved project that was reopened and XML-verified.'
    $seedHashAfter = Get-Sha256 -LiteralPath $script:SeedPath
    Assert-Condition -Condition ($seedHashAfter -eq $script:SeedHashBefore) -Code 'SEED_CHANGED_DURING_EXPORT' -Message 'The immutable seed CPTX changed during export.'

    Set-DriverStage -Name 'promote-output' -Message 'Atomically promoting the verified staged CPTX to its new output path.'
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $outputPath)) -Code 'OUTPUT_APPEARED_DURING_EXPORT' -Message 'The output path appeared during export; the driver will not overwrite it.'
    $hashImmediatelyBeforePromotion = Get-Sha256 -LiteralPath $script:StagingCptxPath
    Assert-Condition -Condition ($hashImmediatelyBeforePromotion -eq $savedHash -and $hashImmediatelyBeforePromotion -eq $hashAfterVerification) -Code 'VERIFIED_PROJECT_HASH_CHANGED_BEFORE_PROMOTION' -Message 'The XML-verified CPTX bytes changed immediately before atomic promotion.'
    [IO.File]::Move($script:StagingCptxPath, $outputPath)
    $outputItem = Get-Item -LiteralPath $outputPath -Force
    $outputHash = Get-Sha256 -LiteralPath $outputPath
    Assert-Condition -Condition ($outputHash -eq $savedHash -and $outputHash -eq $hashImmediatelyBeforePromotion) -Code 'PROMOTED_PROJECT_HASH_MISMATCH' -Message 'The promoted CPTX bytes do not match the exact saved and XML-verified project.'
    $script:OutputPromoted = $true

    Remove-StagingDirectorySafely
    $script:StagingRoot = $null
    Set-DriverStage -Name 'complete' -Message 'Created and independently verified the native editable Captivate project.'
    $terminalResult = [ordered]@{
      type = 'result'; schemaVersion = $script:DriverSchemaVersion; ok = $true; mode = $script:Mode; stage = 'complete'
      attestation = [ordered]@{
        driverProfile = $script:DriverProfile
        desktop = [ordered]@{ processDpiAwareness = 0; logicalDpi = 96; primaryScalePercent = $script:PrimaryScalePercent }
        captivate = $script:ExecutableAttestation
        seed = [ordered]@{ path = $script:SeedPath; sha256 = $script:SeedHashBefore; unchanged = $true }
        requestedSlideCount = $script:RequestedSlides.Count
        verifiedSlideCount = $xmlVerification.slideCount
        markerTitles = @($xmlVerification.markerTitles)
        output = [ordered]@{ path = $outputPath; sha256 = $outputHash; size = $outputItem.Length }
        verificationXml = [ordered]@{ sha256 = $xmlHash; size = $xmlSize }
        processIds = $script:ProcessIds.ToArray()
        processExitConfirmed = $script:ConfirmedProcessExit
        outputPromoted = $script:OutputPromoted
        startedAt = $script:StartedAt.ToString('o')
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        stages = @($script:Audit | ForEach-Object { $_.stage })
      }
    }
    $exitCode = 0
  }
} catch {
  $message = $_.Exception.Message
  Add-AuditRecord -Stage $script:Stage -Message "FAILED: $message"
  Request-BoundedNormalCloseAfterFailure
  $seedUnchanged = $null
  if ($script:SeedPath -and (Test-Path -LiteralPath $script:SeedPath -PathType Leaf) -and $script:SeedHashBefore) {
    try { $seedUnchanged = ((Get-Sha256 -LiteralPath $script:SeedPath) -eq $script:SeedHashBefore) } catch { $seedUnchanged = $false }
  }

  if ($script:StagingRoot -and -not $script:OutputPromoted) {
    Add-AuditRecord -Stage $script:Stage -Message 'Retained isolated staging after failure for safe diagnosis; no partial cleanup was attempted.'
  }

  $seedFailureAttestation = $null
  if ($script:SeedPath) {
    $seedFailureAttestation = [ordered]@{
      path = $script:SeedPath
      sha256 = $script:SeedHashBefore
      unchanged = $seedUnchanged
    }
  }
  $terminalResult = [ordered]@{
    type = 'result'
    schemaVersion = $script:DriverSchemaVersion
    ok = $false
    mode = $script:Mode
    stage = $script:Stage
    error = [ordered]@{ code = $script:FailureCode; message = $message }
    retainedStagingPath = $script:StagingRoot
    attestation = [ordered]@{
      driverProfile = $script:DriverProfile
      desktop = [ordered]@{ processDpiAwareness = 0; logicalDpi = 96; primaryScalePercent = $script:PrimaryScalePercent }
      captivate = $script:ExecutableAttestation
      seed = $seedFailureAttestation
      requestedSlideCount = $script:RequestedSlides.Count
      processIds = $script:ProcessIds.ToArray()
      processExitConfirmed = $script:ConfirmedProcessExit
      outputPromoted = $script:OutputPromoted
      accessibilityHelperTerminationUnconfirmed = $script:AccessibilityHelperTerminationUnconfirmed
      accessibilityHelperProcessId = $script:AccessibilityHelperProcessId
      startedAt = $script:StartedAt.ToString('o')
      completedAt = [DateTimeOffset]::UtcNow.ToString('o')
      stages = @($script:Audit | ForEach-Object { $_.stage })
    }
  }
  $exitCode = 1
}

Write-DriverEvent $terminalResult
exit $exitCode
