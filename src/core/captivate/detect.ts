import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export interface CaptivateDetection {
  detected: boolean
  path?: string
  reason?: string
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
export async function detectCaptivate(): Promise<CaptivateDetection> {
  if (process.platform !== 'win32') {
    return {
      detected: false,
      reason: 'Editable CPTX assembly requires Adobe Captivate on Windows.'
    }
  }

  const programRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
    (value): value is string => Boolean(value)
  )

  for (const programRoot of programRoots) {
    const adobeRoot = join(programRoot, 'Adobe')
    let entries: string[] = []

    try {
      entries = await readdir(adobeRoot)
    } catch {
      continue
    }

    const captivateDirectories = entries
      .filter((entry) => /^Adobe Captivate(?:\s|$)/i.test(entry))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))

    for (const directory of captivateDirectories) {
      for (const executable of ['AdobeCaptivate.exe', 'Captivate.exe']) {
        const candidate = join(adobeRoot, directory, executable)
        if (await isExecutable(candidate)) {
          return { detected: true, path: candidate }
        }
      }
    }
  }

  return {
    detected: false,
    reason: 'Adobe Captivate was not found. Bundle and SCORM exports remain available.'
  }
}
