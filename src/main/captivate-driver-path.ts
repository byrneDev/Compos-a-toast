import { join } from 'node:path'

export const CAPTIVATE_CLASSIC_DRIVER_FILENAME = 'classic-11.8.4-driver.ps1'

export interface CaptivateClassicDriverPathContext {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
}

/**
 * Resolves the external PowerShell driver without relying on the current working directory.
 *
 * In development, Electron's app path is the repository root. Packaged builds copy the
 * script outside app.asar so Windows PowerShell can execute it as a normal file.
 */
export function resolveCaptivateClassicDriverPath(
  context: CaptivateClassicDriverPathContext
): string {
  if (context.isPackaged) {
    return join(context.resourcesPath, 'captivate', CAPTIVATE_CLASSIC_DRIVER_FILENAME)
  }

  return join(
    context.appPath,
    'src',
    'core',
    'captivate',
    CAPTIVATE_CLASSIC_DRIVER_FILENAME
  )
}
