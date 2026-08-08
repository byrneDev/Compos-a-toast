import { lstat, open, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
export const projectRoot = path.resolve(path.dirname(scriptPath), '..')

const WINDOWS_X64_MACHINE = 0x8664
const WINDOWS_X64_ARCH = 'x64'
const WINDOWS_EXECUTABLE_EXTENSION = 'exe'

async function readNonemptyRegularFileStats(filePath, label) {
  let fileStats
  try {
    fileStats = await lstat(filePath)
  } catch (error) {
    throw new Error(`${label} is missing: ${filePath}`, { cause: error })
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.size === 0) {
    throw new Error(`${label} must be a nonempty regular file: ${filePath}`)
  }
  return fileStats
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error })
  }
}

function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a nonempty string.`)
  }
  return value.trim()
}

function requireSafeFilename(value, label) {
  const filename = requireNonemptyString(value, label)
  if (
    path.win32.isAbsolute(filename) ||
    filename === '.' ||
    filename === '..' ||
    path.win32.basename(filename) !== filename ||
    filename.includes('\0')
  ) {
    throw new Error(`${label} must resolve to a filename, not a path: ${value}`)
  }
  return filename
}

function expectedInstallerFilename(packageMetadata) {
  const productName = requireNonemptyString(
    packageMetadata.build?.productName ?? packageMetadata.productName ?? packageMetadata.name,
    'Electron product name'
  )
  const packageName = requireNonemptyString(packageMetadata.name, 'Package name')
  const version = requireNonemptyString(packageMetadata.version, 'Package version')
  const template = requireNonemptyString(
    packageMetadata.build?.nsis?.artifactName,
    'NSIS artifactName'
  )

  if (!template.includes('${version}') || !template.includes('${arch}')) {
    throw new Error('NSIS artifactName must include both ${version} and ${arch}.')
  }

  const variables = {
    arch: WINDOWS_X64_ARCH,
    ext: WINDOWS_EXECUTABLE_EXTENSION,
    name: packageName,
    productName,
    version
  }
  const filename = template.replace(/\$\{([^}]+)}/g, (placeholder, variable) => {
    if (!Object.hasOwn(variables, variable)) {
      throw new Error(`Unsupported NSIS artifactName variable: ${placeholder}`)
    }
    return variables[variable]
  })

  if (!filename.toLowerCase().endsWith(`.${WINDOWS_EXECUTABLE_EXTENSION}`)) {
    throw new Error(`NSIS artifactName must resolve to an .exe file: ${filename}`)
  }
  return requireSafeFilename(filename, 'Resolved NSIS artifactName')
}

async function readPeMachine(filePath, fileSize) {
  const file = await open(filePath, 'r')
  try {
    if (fileSize < 64) {
      throw new Error('file is too small to contain a DOS header')
    }

    const dosHeader = Buffer.alloc(64)
    const dosRead = await file.read(dosHeader, 0, dosHeader.length, 0)
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('DOS MZ header is missing')
    }

    const peOffset = dosHeader.readUInt32LE(0x3c)
    if (peOffset > fileSize - 6) {
      throw new Error('PE header offset is outside the file')
    }

    const peHeader = Buffer.alloc(6)
    const peRead = await file.read(peHeader, 0, peHeader.length, peOffset)
    if (peRead.bytesRead !== peHeader.length || !peHeader.subarray(0, 4).equals(Buffer.from('PE\0\0'))) {
      throw new Error('PE signature is missing')
    }
    return peHeader.readUInt16LE(4)
  } finally {
    await file.close()
  }
}

function hexadecimalMachine(machine) {
  return `0x${machine.toString(16).padStart(4, '0')}`
}

export async function verifyWindowsInstallerOutput(root = projectRoot) {
  const resolvedRoot = path.resolve(root)
  const packagePath = path.join(resolvedRoot, 'package.json')
  const packageStats = await readNonemptyRegularFileStats(packagePath, 'Source package.json')
  const packageMetadata = parseJson(await readFile(packagePath), 'Source package.json')
  if (packageStats.size === 0) {
    throw new Error(`Source package.json is empty: ${packagePath}`)
  }

  const installerFilename = expectedInstallerFilename(packageMetadata)
  const releasePath = path.join(resolvedRoot, 'release')
  const installerPath = path.join(releasePath, installerFilename)
  const installerStats = await readNonemptyRegularFileStats(
    installerPath,
    'Windows x64 NSIS installer'
  )

  let releaseEntries
  try {
    releaseEntries = await readdir(releasePath, { withFileTypes: true })
  } catch (error) {
    throw new Error(`Release directory cannot be read: ${releasePath}`, { cause: error })
  }
  const unexpectedExecutables = releaseEntries
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.toLowerCase().endsWith('.exe') &&
        name.toLowerCase() !== installerFilename.toLowerCase()
    )
    .sort((left, right) => left.localeCompare(right))
  if (unexpectedExecutables.length > 0) {
    throw new Error(
      `Unexpected top-level Windows executable artifact(s); a portable target may have been emitted: ${unexpectedExecutables.join(', ')}`
    )
  }

  const productName = requireNonemptyString(
    packageMetadata.build?.productName ?? packageMetadata.productName ?? packageMetadata.name,
    'Electron product name'
  )
  const executableName = requireSafeFilename(
    packageMetadata.build?.win?.executableName ?? productName,
    'Windows executableName'
  )
  const appExecutableFilename = executableName.toLowerCase().endsWith('.exe')
    ? executableName
    : `${executableName}.exe`
  const appExecutablePath = path.join(
    releasePath,
    'win-unpacked',
    appExecutableFilename
  )
  const appExecutableStats = await readNonemptyRegularFileStats(
    appExecutablePath,
    'Packaged Windows application executable'
  )

  let machine
  try {
    machine = await readPeMachine(appExecutablePath, appExecutableStats.size)
  } catch (error) {
    throw new Error(`Packaged Windows application executable is not a valid PE file: ${appExecutablePath}`, {
      cause: error
    })
  }
  if (machine !== WINDOWS_X64_MACHINE) {
    throw new Error(
      `Packaged Windows application executable must target x64 (${hexadecimalMachine(WINDOWS_X64_MACHINE)}); found ${hexadecimalMachine(machine)}.`
    )
  }

  return {
    appExecutablePath,
    appExecutableSize: appExecutableStats.size,
    installerPath,
    installerSize: installerStats.size,
    machine
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
    const result = await verifyWindowsInstallerOutput()
    console.log(
      `Verified x64 app ${result.appExecutablePath} and NSIS installer ${result.installerPath} (${result.installerSize} bytes).`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
