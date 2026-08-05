import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { win32 as windowsPath } from 'node:path'
import type {
  CaptivateDetectionDto,
  CaptivateProduct
} from '../../shared/contracts'

export const SUPPORTED_CAPTIVATE_CLASSIC_BUILDS = ['11.8.3.8', '11.8.4.21'] as const

const { isAbsolute, join } = windowsPath

export interface CaptivateExecutableMetadata {
  fileVersion?: string
  productVersion?: string
  productName?: string
  signatureStatus?: string
  publisher?: string
}

export type CaptivateDetection = CaptivateDetectionDto

export interface CaptivateDetectorDependencies {
  platform: NodeJS.Platform
  programRoots: readonly string[]
  listDirectories(path: string): Promise<string[]>
  isFile(path: string): Promise<boolean>
  readExecutableMetadata(path: string): Promise<CaptivateExecutableMetadata>
}

const EXECUTABLE_NAMES = [
  'AdobeCaptivateClassic.exe',
  'AdobeCaptivate.exe',
  'Captivate.exe'
] as const

const VERSION_INFO_SCRIPT = `
$item = Get-Item -LiteralPath $env:COMPOS_A_TOAST_CAPTIVATE_PATH -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
[PSCustomObject]@{
  fileVersion = $item.VersionInfo.FileVersion
  productVersion = $item.VersionInfo.ProductVersion
  productName = $item.VersionInfo.ProductName
  signatureStatus = $signature.Status.ToString()
  publisher = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
} | ConvertTo-Json -Compress
`

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function windowsPowerShellPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function readExecutableMetadata(
  path: string,
  powerShellPath = windowsPowerShellPath()
): Promise<CaptivateExecutableMetadata> {
  return new Promise((resolve, reject) => {
    execFile(
      powerShellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_INFO_SCRIPT],
      {
        encoding: 'utf8',
        env: { ...process.env, COMPOS_A_TOAST_CAPTIVATE_PATH: path },
        maxBuffer: 64 * 1024,
        timeout: 8_000,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }

        try {
          resolve(JSON.parse(stdout.trim()) as CaptivateExecutableMetadata)
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

function systemDependencies(): CaptivateDetectorDependencies {
  const seenRoots = new Set<string>()
  const programRoots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ].filter((value): value is string => {
    if (!value?.trim()) return false
    const key = value.toLocaleLowerCase('en-US')
    if (seenRoots.has(key)) return false
    seenRoots.add(key)
    return true
  })

  return {
    platform: process.platform,
    programRoots,
    listDirectories: (path) => readdir(path),
    isFile,
    readExecutableMetadata
  }
}

function normalizeVersion(metadata: CaptivateExecutableMetadata): string | undefined {
  for (const rawVersion of [metadata.fileVersion, metadata.productVersion]) {
    const match = rawVersion?.match(/(?:^|[^\d.])(\d+(?:\.\d+){1,3})(?![\d.]|\.\d)/)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function identifyProduct(
  directory: string,
  executable: string,
  metadata: CaptivateExecutableMetadata
): CaptivateProduct {
  const identity = `${directory} ${executable} ${metadata.productName ?? ''}`
  if (/captivate\s*classic/i.test(identity)) return 'classic'
  if (/captivate/i.test(identity)) return 'modern'
  return 'unknown'
}

function isAdobeSignature(metadata: CaptivateExecutableMetadata): boolean {
  return (
    metadata.signatureStatus?.toLowerCase() === 'valid' &&
    /(?:^|,\s*)O="?Adobe Inc\.?"?(?:,|$)/i.test(metadata.publisher ?? '')
  )
}

function supportedClassicBuild(version: string | undefined): boolean {
  return SUPPORTED_CAPTIVATE_CLASSIC_BUILDS.some((supported) => supported === version)
}

function compareDetections(left: CaptivateDetection, right: CaptivateDetection): number {
  const eligibleDifference = Number(right.adapterEligible) - Number(left.adapterEligible)
  if (eligibleDifference !== 0) return eligibleDifference

  const classicDifference = Number(right.product === 'classic') - Number(left.product === 'classic')
  if (classicDifference !== 0) return classicDifference

  const signatureDifference =
    Number(right.signatureVerified) - Number(left.signatureVerified)
  if (signatureDifference !== 0) return signatureDifference

  const supportedDifference = Number(right.versionSupported) - Number(left.versionSupported)
  if (supportedDifference !== 0) return supportedDifference

  return (right.version ?? '').localeCompare(left.version ?? '', undefined, { numeric: true })
}

function detectionReason(
  product: CaptivateProduct,
  version: string | undefined,
  signatureVerified: boolean,
  metadataAvailable: boolean
): string | undefined {
  if (!metadataAvailable) {
    return 'Captivate was found, but its product version and publisher could not be verified.'
  }
  if (product !== 'classic') {
    return 'Editable CPTX assembly requires Adobe Captivate Classic, not the newer CPT-based application.'
  }
  if (!signatureVerified) {
    return 'Captivate Classic was found, but its Adobe code signature could not be verified.'
  }
  if (!supportedClassicBuild(version)) {
    return `Captivate Classic ${version ?? 'with an unknown version'} is installed, but the automation adapter currently targets ${SUPPORTED_CAPTIVATE_CLASSIC_BUILDS.join(' and ')}.`
  }
  return undefined
}

/**
 * Finds an installed Captivate executable and verifies the exact authoring build.
 * Dependencies are injectable so detection can be tested without requiring Adobe
 * software or invoking PowerShell in the test process.
 */
export async function detectCaptivate(
  dependencies: CaptivateDetectorDependencies = systemDependencies()
): Promise<CaptivateDetection> {
  if (dependencies.platform !== 'win32') {
    return {
      detected: false,
      signatureVerified: false,
      versionSupported: false,
      adapterEligible: false,
      reason: 'Editable CPTX assembly requires Adobe Captivate Classic on Windows.'
    }
  }

  const directories: Array<{ root: string; name: string }> = []
  for (const programRoot of dependencies.programRoots) {
    const adobeRoot = join(programRoot, 'Adobe')
    let entries: string[] = []
    try {
      entries = await dependencies.listDirectories(adobeRoot)
    } catch {
      continue
    }

    for (const name of entries) {
      if (/^Adobe Captivate(?:\s|$)/i.test(name)) directories.push({ root: adobeRoot, name })
    }
  }

  directories.sort((left, right) => {
    const classicDifference = Number(/classic/i.test(right.name)) - Number(/classic/i.test(left.name))
    if (classicDifference !== 0) return classicDifference
    return right.name.localeCompare(left.name, undefined, { numeric: true })
  })

  const detections: CaptivateDetection[] = []
  for (const directory of directories) {
    for (const executable of EXECUTABLE_NAMES) {
      const candidate = join(directory.root, directory.name, executable)
      if (!isAbsolute(candidate)) continue
      if (!(await dependencies.isFile(candidate))) continue

      let metadata: CaptivateExecutableMetadata = {}
      let metadataAvailable = true
      try {
        metadata = await dependencies.readExecutableMetadata(candidate)
      } catch {
        metadataAvailable = false
      }

      const version = normalizeVersion(metadata)
      const product = identifyProduct(directory.name, executable, metadata)
      const signatureVerified = isAdobeSignature(metadata)
      const versionSupported = supportedClassicBuild(version)
      const adapterEligible = product === 'classic' && signatureVerified && versionSupported

      detections.push({
        detected: true,
        path: candidate,
        product,
        version,
        productName: metadata.productName,
        signatureVerified,
        versionSupported,
        adapterEligible,
        reason: detectionReason(product, version, signatureVerified, metadataAvailable)
      })
    }
  }

  if (detections.length > 0) return detections.sort(compareDetections)[0]

  return {
    detected: false,
    signatureVerified: false,
    versionSupported: false,
    adapterEligible: false,
    reason: 'Adobe Captivate Classic was not found. Bundle and SCORM exports remain available.'
  }
}
