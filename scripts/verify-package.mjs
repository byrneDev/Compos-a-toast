import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, uncache } from '@electron/asar'

const scriptPath = fileURLToPath(import.meta.url)
export const projectRoot = path.resolve(path.dirname(scriptPath), '..')

const DRIVER_SOURCE = 'src/core/captivate/classic-11.8.4-driver.ps1'
const DRIVER_RESOURCE = 'captivate/classic-11.8.4-driver.ps1'
const EXPECTED_MAIN_ENTRY = 'out/main/index.js'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readNonemptyRegularFile(filePath, label) {
  let fileStats
  try {
    fileStats = await lstat(filePath)
  } catch (error) {
    throw new Error(`${label} is missing: ${filePath}`, { cause: error })
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.size === 0) {
    throw new Error(`${label} must be a nonempty regular file: ${filePath}`)
  }
  return { bytes: await readFile(filePath), size: fileStats.size }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error })
  }
}

function normalizeMainEntry(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} does not declare a main entry.`)
  }
  const normalized = path.posix.normalize(value.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${label} declares an unsafe main entry: ${value}`)
  }
  if (normalized !== EXPECTED_MAIN_ENTRY) {
    throw new Error(
      `${label} must declare ${EXPECTED_MAIN_ENTRY} as its main entry; found ${normalized}.`
    )
  }
  return normalized
}

function extractRequiredEntry(asarPath, entryPath, label) {
  let bytes
  try {
    const platformEntryPath = entryPath.split('/').join(path.sep)
    bytes = extractFile(asarPath, platformEntryPath)
  } catch (error) {
    throw new Error(`${label} is missing from app.asar: ${entryPath}`, { cause: error })
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error(`${label} is empty in app.asar: ${entryPath}`)
  }
  return bytes
}

export async function verifyPackageOutput(root = projectRoot) {
  const resolvedRoot = path.resolve(root)
  const packagePath = path.join(resolvedRoot, 'package.json')
  const packageFile = await readNonemptyRegularFile(packagePath, 'Source package.json')
  const packageMetadata = parseJson(packageFile.bytes, 'Source package.json')
  const sourceMainEntry = normalizeMainEntry(packageMetadata.main, 'Source package.json')

  const driverResource = packageMetadata.build?.extraResources?.find(
    (resource) => resource?.from === DRIVER_SOURCE && resource?.to === DRIVER_RESOURCE
  )
  if (!driverResource) {
    throw new Error('package.json does not map the exact Captivate driver into resources.')
  }

  const resourcesPath = path.join(resolvedRoot, 'release', 'win-unpacked', 'resources')
  const sourceDriverPath = path.join(resolvedRoot, ...DRIVER_SOURCE.split('/'))
  const packagedDriverPath = path.join(resourcesPath, ...DRIVER_RESOURCE.split('/'))
  const appAsarPath = path.join(resourcesPath, 'app.asar')

  const [sourceDriver, packagedDriver, appAsar] = await Promise.all([
    readNonemptyRegularFile(sourceDriverPath, 'Source Captivate driver'),
    readNonemptyRegularFile(packagedDriverPath, 'Packaged Captivate driver'),
    readNonemptyRegularFile(appAsarPath, 'Packaged app.asar')
  ])

  const sourceDriverSha256 = sha256(sourceDriver.bytes)
  const packagedDriverSha256 = sha256(packagedDriver.bytes)
  if (
    sourceDriverSha256 !== packagedDriverSha256 ||
    !sourceDriver.bytes.equals(packagedDriver.bytes)
  ) {
    throw new Error(
      `The packaged Captivate driver differs from its source (${packagedDriverSha256} != ${sourceDriverSha256}).`
    )
  }

  try {
    const packagedPackageBytes = extractRequiredEntry(
      appAsarPath,
      'package.json',
      'Packaged package.json'
    )
    const packagedPackage = parseJson(packagedPackageBytes, 'Packaged package.json')
    const packagedMainEntry = normalizeMainEntry(
      packagedPackage.main,
      'Packaged package.json'
    )
    if (packagedMainEntry !== sourceMainEntry) {
      throw new Error('Packaged package.json main entry differs from the source configuration.')
    }

    const packagedMain = extractRequiredEntry(
      appAsarPath,
      packagedMainEntry,
      'Packaged Electron main entry'
    )
    if (!packagedMain.includes(Buffer.from(sourceDriverSha256, 'ascii'))) {
      throw new Error(
        'The packaged Electron main entry does not contain the exact Captivate driver hash.'
      )
    }

    return {
      appAsarPath,
      appAsarSize: appAsar.size,
      driverSha256: sourceDriverSha256,
      mainEntry: packagedMainEntry,
      mainEntrySize: packagedMain.length
    }
  } finally {
    uncache(appAsarPath)
  }
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

const invokedDirectly = process.argv[1] && samePath(process.argv[1], scriptPath)
if (invokedDirectly) {
  try {
    const result = await verifyPackageOutput()
    console.log(
      `Verified app.asar ${result.mainEntry} and packaged Captivate driver ${result.driverSha256}.`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
