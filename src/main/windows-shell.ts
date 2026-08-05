import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'

const WINDOWS_11_BUILD = 22_000
const WINDOWS_11_22H2_BUILD = 22_621
const TITLE_BAR_HEIGHT = 48

const COLORS = {
  light: {
    background: '#F3F3F3',
    foreground: '#1A1A1A'
  },
  dark: {
    background: '#202020',
    foreground: '#FFFFFF'
  }
} as const

export interface NativeThemeSnapshot {
  shouldUseDarkColors: boolean
  shouldUseHighContrastColors: boolean
  inForcedColorsMode: boolean
  prefersReducedTransparency: boolean
}

export interface DesktopShellEnvironment {
  platform: NodeJS.Platform
  osRelease: string
  nativeTheme: NativeThemeSnapshot
}

export type DesktopShellWindowOptions = Pick<
  BrowserWindowConstructorOptions,
  | 'backgroundColor'
  | 'backgroundMaterial'
  | 'titleBarOverlay'
  | 'titleBarStyle'
>

export type SecureRendererPreferences = Pick<
  WebPreferences,
  | 'allowRunningInsecureContent'
  | 'contextIsolation'
  | 'nodeIntegration'
  | 'nodeIntegrationInSubFrames'
  | 'nodeIntegrationInWorker'
  | 'preload'
  | 'sandbox'
  | 'webSecurity'
  | 'webviewTag'
>

export interface DesktopShellConfiguration {
  /** The theme Electron reports after applying the user's native OS preference. */
  colorScheme: 'light' | 'dark'
  /** Parsed Windows build, or null for a non-Windows/unknown release. */
  windowsBuild: number | null
  /** True when the renderer should reserve space for native window controls. */
  usesWindowControlsOverlay: boolean
  /** True when the window may use the Windows 11 system backdrop. */
  usesMica: boolean
  /** Constructor options that can be spread directly into BrowserWindow options. */
  windowOptions: DesktopShellWindowOptions
}

/**
 * Parses the Windows build component from releases such as `10.0.22631`.
 * A null result deliberately opts the application into the conservative shell.
 */
export function parseWindowsBuild(osRelease: string): number | null {
  const components = osRelease.trim().split('.')
  if (components.length < 3 || !/^\d+$/.test(components[2] ?? '')) return null

  const build = Number.parseInt(components[2], 10)
  return Number.isSafeInteger(build) ? build : null
}

/**
 * Creates platform- and accessibility-aware BrowserWindow appearance options.
 * The returned opaque background is also the safe fallback while the renderer
 * starts and whenever Windows backdrop materials are unavailable.
 */
export function createDesktopShellConfiguration(
  environment: DesktopShellEnvironment
): DesktopShellConfiguration {
  const colorScheme = environment.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const colors = COLORS[colorScheme]
  const windowsBuild =
    environment.platform === 'win32' ? parseWindowsBuild(environment.osRelease) : null
  const usesWindowControlsOverlay =
    windowsBuild !== null && windowsBuild >= WINDOWS_11_BUILD
  const hasContrastOverride =
    environment.nativeTheme.shouldUseHighContrastColors ||
    environment.nativeTheme.inForcedColorsMode
  const usesMica =
    windowsBuild !== null &&
    windowsBuild >= WINDOWS_11_22H2_BUILD &&
    !hasContrastOverride &&
    !environment.nativeTheme.prefersReducedTransparency

  const windowOptions: DesktopShellWindowOptions = {
    backgroundColor: colors.background
  }

  if (windowsBuild !== null && windowsBuild >= WINDOWS_11_22H2_BUILD) {
    windowOptions.backgroundMaterial = usesMica ? 'mica' : 'none'
  }

  if (usesWindowControlsOverlay) {
    windowOptions.titleBarStyle = 'hidden'
    windowOptions.titleBarOverlay = {
      // An explicit color keeps the native caption-button strip in sync with
      // dark mode. A transparent overlay can expose a light DWM backing layer
      // even while the renderer and Mica backdrop are dark.
      color: colors.background,
      symbolColor: colors.foreground,
      height: TITLE_BAR_HEIGHT
    }
  }

  return {
    colorScheme,
    windowsBuild,
    usesWindowControlsOverlay,
    usesMica,
    windowOptions
  }
}

/**
 * Provides the restrictive defaults for the renderer process. The preload
 * remains the sole bridge between privileged main-process code and page code.
 */
export function createSecureRendererPreferences(preload: string): SecureRendererPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false
  }
}
