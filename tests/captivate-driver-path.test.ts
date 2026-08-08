import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPTIVATE_CLASSIC_DRIVER_FILENAME,
  resolveCaptivateClassicDriverPath
} from '../src/main/captivate-driver-path'

describe('resolveCaptivateClassicDriverPath', () => {
  it('resolves the source driver from the Electron app path during development', () => {
    const appPath = join('workspace', 'compos-a-toast')

    expect(
      resolveCaptivateClassicDriverPath({
        appPath,
        isPackaged: false,
        resourcesPath: join('unused', 'resources')
      })
    ).toBe(
      join(appPath, 'src', 'core', 'captivate', CAPTIVATE_CLASSIC_DRIVER_FILENAME)
    )
  })

  it('resolves the unpacked driver from Electron resources in packaged builds', () => {
    const resourcesPath = join('installed-app', 'resources')

    expect(
      resolveCaptivateClassicDriverPath({
        appPath: join(resourcesPath, 'app.asar'),
        isPackaged: true,
        resourcesPath
      })
    ).toBe(join(resourcesPath, 'captivate', CAPTIVATE_CLASSIC_DRIVER_FILENAME))
  })
})
