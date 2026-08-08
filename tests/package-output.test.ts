import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The executable ESM script intentionally has no generated declaration file.
import { cleanReleaseOutput } from '../scripts/clean-release.mjs'
// @ts-expect-error The executable ESM script intentionally has no generated declaration file.
import { verifyPackageOutput } from '../scripts/verify-package.mjs'

const temporaryRoots: string[] = []

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'compos-a-toast-package-test-'))
  temporaryRoots.push(root)
  return root
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch {
    return false
  }
}

interface PackageFixtureOptions {
  includeMain?: boolean
  mainSource?: string
}

async function packageFixture(options: PackageFixtureOptions = {}): Promise<{
  appAsarPath: string
  packagedDriverPath: string
  root: string
  sourceDriverHash: string
}> {
  const root = await temporaryProject()
  const driverSource = Buffer.from('qualified synthetic driver\n', 'utf8')
  const sourceDriverHash = createHash('sha256').update(driverSource).digest('hex')
  const packageMetadata = {
    name: 'synthetic-package',
    version: '1.0.0',
    main: './out/main/index.js',
    build: {
      extraResources: [
        {
          from: 'src/core/captivate/classic-11.8.4-driver.ps1',
          to: 'captivate/classic-11.8.4-driver.ps1'
        }
      ]
    }
  }

  const sourceDriverPath = join(
    root,
    'src',
    'core',
    'captivate',
    'classic-11.8.4-driver.ps1'
  )
  const resourcesPath = join(root, 'release', 'win-unpacked', 'resources')
  const packagedDriverPath = join(
    resourcesPath,
    'captivate',
    'classic-11.8.4-driver.ps1'
  )
  const asarInput = join(root, 'asar-input')
  const appAsarPath = join(resourcesPath, 'app.asar')

  await Promise.all([
    mkdir(dirname(sourceDriverPath), { recursive: true }),
    mkdir(dirname(packagedDriverPath), { recursive: true }),
    mkdir(join(asarInput, 'out', 'main'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify(packageMetadata), 'utf8'),
    writeFile(sourceDriverPath, driverSource),
    writeFile(packagedDriverPath, driverSource),
    writeFile(join(asarInput, 'package.json'), JSON.stringify(packageMetadata), 'utf8')
  ])
  if (options.includeMain !== false) {
    await writeFile(
      join(asarInput, 'out', 'main', 'index.js'),
      options.mainSource ?? `export const driverHash = '${sourceDriverHash}'\n`,
      'utf8'
    )
  }
  await createPackage(asarInput, appAsarPath)

  return { appAsarPath, packagedDriverPath, root, sourceDriverHash }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('release output maturity guards', () => {
  it('deletes only the exact generated release directory', async () => {
    const root = await temporaryProject()
    const releasePath = join(root, 'release')
    const retainedPath = join(root, 'retain.txt')
    await mkdir(join(releasePath, 'nested'), { recursive: true })
    await Promise.all([
      writeFile(join(releasePath, 'nested', 'artifact.exe'), 'generated', 'utf8'),
      writeFile(retainedPath, 'keep', 'utf8')
    ])

    await expect(cleanReleaseOutput(root)).resolves.toEqual({
      removed: true,
      releasePath
    })
    expect(await pathExists(releasePath)).toBe(false)
    await expect(readFile(retainedPath, 'utf8')).resolves.toBe('keep')
  })

  it('refuses a release root that is a link or junction', async () => {
    const root = await temporaryProject()
    const externalPath = join(root, 'external-output')
    const retainedPath = join(externalPath, 'retain.txt')
    await mkdir(externalPath)
    await writeFile(retainedPath, 'keep', 'utf8')
    await symlink(externalPath, join(root, 'release'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(cleanReleaseOutput(root)).rejects.toThrow(/ordinary directory|symbolic link/i)
    await expect(readFile(retainedPath, 'utf8')).resolves.toBe('keep')
  })

  it('refuses linked entries inside release output', async () => {
    const root = await temporaryProject()
    const releasePath = join(root, 'release')
    const externalPath = join(root, 'external-output')
    const retainedPath = join(externalPath, 'retain.txt')
    await Promise.all([mkdir(releasePath), mkdir(externalPath)])
    await writeFile(retainedPath, 'keep', 'utf8')
    await symlink(
      externalPath,
      join(releasePath, 'linked-output'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(cleanReleaseOutput(root)).rejects.toThrow(/symbolic link/i)
    await expect(readFile(retainedPath, 'utf8')).resolves.toBe('keep')
  })

  it('cleans release before every packaging workflow', async () => {
    const packageMetadata = JSON.parse(
      await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    for (const scriptName of [
      'package',
      'package:unsigned',
      'package:win',
      'package:win:unsigned'
    ]) {
      expect(packageMetadata.scripts[scriptName]).toMatch(/^npm run clean:release && /)
    }
  })
})

describe('packaged application verification', () => {
  it('verifies app.asar, its configured main entry, and exact driver bytes', async () => {
    const fixture = await packageFixture()

    await expect(verifyPackageOutput(fixture.root)).resolves.toMatchObject({
      appAsarPath: fixture.appAsarPath,
      driverSha256: fixture.sourceDriverHash,
      mainEntry: 'out/main/index.js'
    })
  })

  it('rejects a packaged driver whose bytes differ from source', async () => {
    const fixture = await packageFixture()
    await writeFile(fixture.packagedDriverPath, 'changed driver\n', 'utf8')

    await expect(verifyPackageOutput(fixture.root)).rejects.toThrow(
      /packaged Captivate driver differs from its source/i
    )
  })

  it('rejects app.asar when the configured main entry is missing', async () => {
    const fixture = await packageFixture({ includeMain: false })

    await expect(verifyPackageOutput(fixture.root)).rejects.toThrow(
      /Packaged Electron main entry is missing from app\.asar/i
    )
  })

  it('rejects a packaged main entry that is not pinned to the exact driver hash', async () => {
    const fixture = await packageFixture({ mainSource: 'export const ready = true\n' })

    await expect(verifyPackageOutput(fixture.root)).rejects.toThrow(
      /main entry does not contain the exact Captivate driver hash/i
    )
  })

  it('rejects an empty app.asar before parsing entries', async () => {
    const fixture = await packageFixture()
    await writeFile(fixture.appAsarPath, Buffer.alloc(0))

    await expect(verifyPackageOutput(fixture.root)).rejects.toThrow(
      /app\.asar must be a nonempty regular file/i
    )
  })
})
