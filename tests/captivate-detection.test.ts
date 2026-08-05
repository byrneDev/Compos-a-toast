import { win32 as windowsPath } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectCaptivate,
  type CaptivateDetectorDependencies,
  type CaptivateExecutableMetadata
} from '../src/core/captivate/detect'

const { join } = windowsPath

const programRoot = 'C:\\Program Files'
const adobeRoot = join(programRoot, 'Adobe')

function detector(
  directories: string[],
  files: Record<string, CaptivateExecutableMetadata | Error>,
  platform: NodeJS.Platform = 'win32'
): CaptivateDetectorDependencies {
  return {
    platform,
    programRoots: [programRoot],
    listDirectories: async (path) => {
      if (path !== adobeRoot) throw new Error(`Unexpected directory: ${path}`)
      return directories
    },
    isFile: async (path) => Object.hasOwn(files, path),
    readExecutableMetadata: async (path) => {
      const metadata = files[path]
      if (metadata instanceof Error) throw metadata
      if (!metadata) throw new Error(`Unexpected executable: ${path}`)
      return metadata
    }
  }
}

function signedClassic(version: string): CaptivateExecutableMetadata {
  return {
    fileVersion: version,
    productVersion: version,
    productName: 'Adobe Captivate Classic',
    signatureStatus: 'Valid',
    publisher: 'CN=Adobe Inc., OU=Captivate, O=Adobe Inc., C=US'
  }
}

describe('detectCaptivate', () => {
  it('recognizes the installed Captivate Classic 11.8.4 executable name and build', async () => {
    const path = join(
      adobeRoot,
      'Adobe Captivate Classic x64',
      'AdobeCaptivateClassic.exe'
    )

    await expect(
      detectCaptivate(detector(['Adobe Captivate Classic x64'], { [path]: signedClassic('11.8.4.21') }))
    ).resolves.toEqual({
      detected: true,
      path,
      product: 'classic',
      version: '11.8.4.21',
      productName: 'Adobe Captivate Classic',
      signatureVerified: true,
      versionSupported: true,
      adapterEligible: true,
      reason: undefined
    })
  })

  it('supports the directly downloadable 11.8.3.8 build', async () => {
    const path = join(
      adobeRoot,
      'Adobe Captivate Classic x64',
      'AdobeCaptivateClassic.exe'
    )
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], { [path]: signedClassic('11.8.3.8') })
    )

    expect(result.versionSupported).toBe(true)
    expect(result.adapterEligible).toBe(true)
    expect(result.version).toBe('11.8.3.8')
  })

  it('detects but does not approve an untested Classic build', async () => {
    const path = join(adobeRoot, 'Adobe Captivate Classic x64', 'AdobeCaptivateClassic.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], { [path]: signedClassic('11.8.2.1') })
    )

    expect(result).toMatchObject({
      detected: true,
      product: 'classic',
      version: '11.8.2.1',
      signatureVerified: true,
      versionSupported: false,
      adapterEligible: false
    })
    expect(result.reason).toMatch(/11\.8\.3\.8 and 11\.8\.4\.21/)
  })

  it('rejects a Captivate executable without a verified Adobe signature', async () => {
    const path = join(adobeRoot, 'Adobe Captivate Classic x64', 'AdobeCaptivateClassic.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], {
        [path]: {
          ...signedClassic('11.8.4.21'),
          signatureStatus: 'NotSigned',
          publisher: undefined
        }
      })
    )

    expect(result.versionSupported).toBe(true)
    expect(result.adapterEligible).toBe(false)
    expect(result.signatureVerified).toBe(false)
    expect(result.reason).toMatch(/signature/i)
  })

  it('distinguishes the newer CPT-based Captivate product from Classic', async () => {
    const path = join(adobeRoot, 'Adobe Captivate', 'Captivate.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate'], {
        [path]: {
          ...signedClassic('13.1.0.10'),
          productName: 'Adobe Captivate'
        }
      })
    )

    expect(result).toMatchObject({
      detected: true,
      product: 'modern',
      version: '13.1.0.10',
      versionSupported: false,
      adapterEligible: false
    })
    expect(result.reason).toMatch(/CPT-based/i)
  })

  it('prefers a Classic installation when both products are installed', async () => {
    const classicPath = join(
      adobeRoot,
      'Adobe Captivate Classic x64',
      'AdobeCaptivateClassic.exe'
    )
    const modernPath = join(adobeRoot, 'Adobe Captivate', 'Captivate.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate', 'Adobe Captivate Classic x64'], {
        [classicPath]: signedClassic('11.8.4.21'),
        [modernPath]: { ...signedClassic('13.1.0.10'), productName: 'Adobe Captivate' }
      })
    )

    expect(result.path).toBe(classicPath)
    expect(result.product).toBe('classic')
  })

  it('reports a found executable when version inspection fails', async () => {
    const path = join(adobeRoot, 'Adobe Captivate Classic x64', 'AdobeCaptivateClassic.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], { [path]: new Error('PowerShell unavailable') })
    )

    expect(result).toMatchObject({
      detected: true,
      path,
      product: 'classic',
      signatureVerified: false,
      versionSupported: false,
      adapterEligible: false
    })
    expect(result.reason).toMatch(/could not be verified/i)
  })

  it('returns a platform-specific result outside Windows', async () => {
    await expect(detectCaptivate(detector([], {}, 'darwin'))).resolves.toEqual({
      detected: false,
      signatureVerified: false,
      versionSupported: false,
      adapterEligible: false,
      reason: 'Editable CPTX assembly requires Adobe Captivate Classic on Windows.'
    })
  })

  it('continues scanning when an earlier executable is unsupported', async () => {
    const unsupportedPath = join(adobeRoot, 'Adobe Captivate Classic 11.8.2', 'Captivate.exe')
    const supportedPath = join(
      adobeRoot,
      'Adobe Captivate Classic x64',
      'AdobeCaptivateClassic.exe'
    )
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic 11.8.2', 'Adobe Captivate Classic x64'], {
        [unsupportedPath]: signedClassic('11.8.2.1'),
        [supportedPath]: signedClassic('11.8.4.21')
      })
    )

    expect(result.path).toBe(supportedPath)
    expect(result.versionSupported).toBe(true)
    expect(result.adapterEligible).toBe(true)
  })

  it('rejects a five-component version instead of accepting its prefix', async () => {
    const path = join(adobeRoot, 'Adobe Captivate Classic x64', 'AdobeCaptivateClassic.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], { [path]: signedClassic('11.8.4.21.99') })
    )

    expect(result.version).toBeUndefined()
    expect(result.versionSupported).toBe(false)
    expect(result.adapterEligible).toBe(false)
  })

  it('falls back to ProductVersion when FileVersion is malformed', async () => {
    const path = join(adobeRoot, 'Adobe Captivate Classic x64', 'AdobeCaptivateClassic.exe')
    const metadata = signedClassic('11.8.4.21')
    metadata.fileVersion = 'not-a-version'
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], { [path]: metadata })
    )

    expect(result.version).toBe('11.8.4.21')
    expect(result.versionSupported).toBe(true)
    expect(result.adapterEligible).toBe(true)
  })

  it('recognizes the legacy Captivate executable filename', async () => {
    const path = join(adobeRoot, 'Adobe Captivate Classic x64', 'Captivate.exe')
    const result = await detectCaptivate(
      detector(['Adobe Captivate Classic x64'], { [path]: signedClassic('11.8.3.8') })
    )

    expect(result.path).toBe(path)
    expect(result.versionSupported).toBe(true)
    expect(result.adapterEligible).toBe(true)
  })

  it('reports a clear result when Captivate is not installed on Windows', async () => {
    await expect(detectCaptivate(detector([], {}))).resolves.toEqual({
      detected: false,
      signatureVerified: false,
      versionSupported: false,
      adapterEligible: false,
      reason: 'Adobe Captivate Classic was not found. Bundle and SCORM exports remain available.'
    })
  })
})
