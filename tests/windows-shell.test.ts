import { describe, expect, it } from 'vitest'
import {
  createDesktopShellConfiguration,
  createSecureRendererPreferences,
  parseWindowsBuild,
  type DesktopShellEnvironment,
  type NativeThemeSnapshot
} from '../src/main/windows-shell'

const lightTheme: NativeThemeSnapshot = {
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  inForcedColorsMode: false,
  prefersReducedTransparency: false
}

function windowsEnvironment(
  osRelease: string,
  nativeTheme: NativeThemeSnapshot = lightTheme
): DesktopShellEnvironment {
  return { platform: 'win32', osRelease, nativeTheme }
}

describe('parseWindowsBuild', () => {
  it.each([
    ['10.0.22631', 22_631],
    ['10.0.22621.1', 22_621],
    [' 10.0.22000 ', 22_000]
  ])('parses %s', (release, expected) => {
    expect(parseWindowsBuild(release)).toBe(expected)
  })

  it.each(['', '10', '10.0', '10.0.preview', '10.0.-1'])('rejects %s', (release) => {
    expect(parseWindowsBuild(release)).toBeNull()
  })
})

describe('createDesktopShellConfiguration', () => {
  it('keeps the native title bar and an opaque fallback before Windows 11', () => {
    const configuration = createDesktopShellConfiguration(windowsEnvironment('10.0.21999'))

    expect(configuration).toMatchObject({
      colorScheme: 'light',
      windowsBuild: 21_999,
      usesWindowControlsOverlay: false,
      usesMica: false,
      windowOptions: {
        backgroundColor: '#F3F3F3'
      }
    })
    expect(configuration.windowOptions).not.toHaveProperty('titleBarStyle')
    expect(configuration.windowOptions).not.toHaveProperty('titleBarOverlay')
  })

  it('enables the Windows 11 overlay at build 22000 without enabling Mica', () => {
    const configuration = createDesktopShellConfiguration(windowsEnvironment('10.0.22000'))

    expect(configuration.usesWindowControlsOverlay).toBe(true)
    expect(configuration.usesMica).toBe(false)
    expect(configuration.windowOptions).toMatchObject({
      backgroundColor: '#F3F3F3',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#F3F3F3',
        symbolColor: '#1A1A1A',
        height: 48
      }
    })
  })

  it('enables Mica starting with Windows 11 22H2', () => {
    const configuration = createDesktopShellConfiguration(windowsEnvironment('10.0.22621'))

    expect(configuration.usesMica).toBe(true)
    expect(configuration.windowOptions).toMatchObject({
      backgroundColor: '#F3F3F3',
      backgroundMaterial: 'mica',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: 'transparent',
        symbolColor: '#1A1A1A'
      }
    })
  })

  it.each([
    {
      name: 'high contrast',
      theme: { ...lightTheme, shouldUseHighContrastColors: true }
    },
    {
      name: 'forced colors',
      theme: { ...lightTheme, inForcedColorsMode: true }
    },
    {
      name: 'reduced transparency',
      theme: { ...lightTheme, prefersReducedTransparency: true }
    }
  ])('uses an opaque background when $name is active', ({ theme }) => {
    const configuration = createDesktopShellConfiguration(
      windowsEnvironment('10.0.26100', theme)
    )

    expect(configuration.usesWindowControlsOverlay).toBe(true)
    expect(configuration.usesMica).toBe(false)
    expect(configuration.windowOptions.backgroundMaterial).toBe('none')
    expect(configuration.windowOptions.titleBarOverlay).toMatchObject({
      color: '#F3F3F3'
    })
  })

  it('follows the native dark theme for the initial and title-bar colors', () => {
    const configuration = createDesktopShellConfiguration(
      windowsEnvironment('10.0.26100', { ...lightTheme, shouldUseDarkColors: true })
    )

    expect(configuration.colorScheme).toBe('dark')
    expect(configuration.windowOptions).toMatchObject({
      backgroundColor: '#202020',
      titleBarOverlay: {
        symbolColor: '#FFFFFF'
      }
    })
  })

  it('avoids Windows-only options on other platforms and malformed releases', () => {
    const configuration = createDesktopShellConfiguration({
      platform: 'linux',
      osRelease: '6.8.0',
      nativeTheme: lightTheme
    })

    expect(configuration).toEqual({
      colorScheme: 'light',
      windowsBuild: null,
      usesWindowControlsOverlay: false,
      usesMica: false,
      windowOptions: { backgroundColor: '#F3F3F3' }
    })

    const unknownWindows = createDesktopShellConfiguration(windowsEnvironment('unknown'))
    expect(unknownWindows.usesWindowControlsOverlay).toBe(false)
    expect(unknownWindows.usesMica).toBe(false)
  })
})

describe('createSecureRendererPreferences', () => {
  it('keeps privileged APIs out of the renderer', () => {
    expect(createSecureRendererPreferences('C:\\app\\preload.cjs')).toEqual({
      preload: 'C:\\app\\preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
  })
})
