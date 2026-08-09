import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The executable ESM script intentionally has no generated declaration file.
import { verifyWindowsInstallerOutput } from '../scripts/verify-windows-installer.mjs'

const temporaryRoots: string[] = []

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'compos-a-toast-installer-test-'))
  temporaryRoots.push(root)
  return root
}

function syntheticPe(machine: number): Buffer {
  const executable = Buffer.alloc(512)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(0x80, 0x3c)
  executable.write('PE\0\0', 0x80, 'binary')
  executable.writeUInt16LE(machine, 0x84)
  return executable
}

interface InstallerFixtureOptions {
  appMachine?: number
  emptyInstaller?: boolean
  includeInstaller?: boolean
}

async function installerFixture(options: InstallerFixtureOptions = {}): Promise<{
  appExecutablePath: string
  installerPath: string
  releasePath: string
  root: string
}> {
  const root = await temporaryProject()
  const releasePath = join(root, 'release')
  const unpackedPath = join(releasePath, 'win-unpacked')
  const installerPath = join(releasePath, 'Compos-a-toast-Setup-0.5.0-x64.exe')
  const appExecutablePath = join(unpackedPath, 'Compos-a-toast.exe')
  const packageMetadata = {
    name: 'compos-a-toast',
    version: '0.5.0',
    build: {
      productName: 'Compos-a-toast',
      nsis: {
        artifactName: '${productName}-Setup-${version}-${arch}.${ext}'
      }
    }
  }

  await mkdir(unpackedPath, { recursive: true })
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify(packageMetadata), 'utf8'),
    writeFile(appExecutablePath, syntheticPe(options.appMachine ?? 0x8664))
  ])
  if (options.includeInstaller !== false) {
    await writeFile(
      installerPath,
      options.emptyInstaller ? Buffer.alloc(0) : Buffer.from('synthetic NSIS installer')
    )
  }

  return { appExecutablePath, installerPath, releasePath, root }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows installer output verification', () => {
  it('accepts the expected versioned NSIS installer and x64 packaged app', async () => {
    const fixture = await installerFixture()

    await expect(verifyWindowsInstallerOutput(fixture.root)).resolves.toMatchObject({
      appExecutablePath: fixture.appExecutablePath,
      installerPath: fixture.installerPath,
      machine: 0x8664
    })
  })

  it('rejects a missing expected x64 installer', async () => {
    const fixture = await installerFixture({ includeInstaller: false })

    await expect(verifyWindowsInstallerOutput(fixture.root)).rejects.toThrow(
      /Windows x64 NSIS installer is missing/i
    )
  })

  it('rejects an empty expected x64 installer', async () => {
    const fixture = await installerFixture({ emptyInstaller: true })

    await expect(verifyWindowsInstallerOutput(fixture.root)).rejects.toThrow(
      /Windows x64 NSIS installer must be a nonempty regular file/i
    )
  })

  it('rejects an additional top-level executable as a possible portable artifact', async () => {
    const fixture = await installerFixture()
    await writeFile(
      join(fixture.releasePath, 'Compos-a-toast-0.5.0-portable.exe'),
      'synthetic portable executable',
      'utf8'
    )

    await expect(verifyWindowsInstallerOutput(fixture.root)).rejects.toThrow(
      /portable target may have been emitted.*Compos-a-toast-0\.5\.0-portable\.exe/i
    )
  })

  it('rejects a packaged x86 app even though the NSIS stub architecture is not inspected', async () => {
    const fixture = await installerFixture({ appMachine: 0x014c })

    await expect(verifyWindowsInstallerOutput(fixture.root)).rejects.toThrow(
      /must target x64 \(0x8664\); found 0x014c/i
    )
  })
})
