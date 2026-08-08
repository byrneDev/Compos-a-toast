import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { detectCaptivate } from '../core/captivate/detect'
import {
  defaultCaptivateSeedCandidates,
  probeCaptivateAdapter,
  type CaptivateAdapterActivityOutcome,
  type CaptivateAdapterProgress,
  type CaptivateAdapterRuntime
} from '../core/captivate/adapter'
import { analyzeCourse, exportCourse, type CourseServiceRuntime } from './course-service'
import { CaptivateActivityTracker } from './captivate-activity'
import { resolveCaptivateClassicDriverPath } from './captivate-driver-path'
import { toCaptivateProgressDto } from './captivate-progress'
import {
  isTrustedMainFrame,
  isTrustedRendererUrl,
  resolveTrustedRendererLocation,
  type TrustedRendererLocation
} from './renderer-security'
import { focusExistingWindow } from './single-instance'
import { IPC_CHANNELS, type ExportRequestDto } from '../shared/contracts'
import {
  createDesktopShellConfiguration,
  createSecureRendererPreferences,
  type NativeThemeSnapshot
} from './windows-shell'

let mainWindow: BrowserWindow | null = null
let trustedRendererLocation: TrustedRendererLocation | null = null
const captivateActivity = new CaptivateActivityTracker()
let deferredQuitRequested = false

const DEFERRED_QUIT_MESSAGE =
  'Close requested. Compos-a-toast will exit after Captivate closes normally. Do not end Captivate or PowerShell in Task Manager.'

function deferQuitUntilCaptivateIsIdle(): void {
  deferredQuitRequested = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.quitDeferred, DEFERRED_QUIT_MESSAGE)
  }
}

captivateActivity.onIdle(() => {
  if (!deferredQuitRequested) return
  deferredQuitRequested = false
  app.quit()
})

function currentNativeTheme(): NativeThemeSnapshot {
  return {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
    inForcedColorsMode: nativeTheme.inForcedColorsMode,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency
  }
}

function desktopShellConfiguration() {
  return createDesktopShellConfiguration({
    platform: process.platform,
    osRelease: process.getSystemVersion(),
    nativeTheme: currentNativeTheme()
  })
}

function captivateRuntime(trackActivity = false): CaptivateAdapterRuntime {
  const activityHooks = trackActivity
    ? {
        onStart: (): void => {
          captivateActivity.hooks.onStart()
          stopWindowFlashing()
        },
        onProgress: (progress: CaptivateAdapterProgress): void => {
          const presentation = toCaptivateProgressDto(progress)
          if (!mainWindow || mainWindow.isDestroyed()) return
          mainWindow.webContents.send(IPC_CHANNELS.captivateProgress, presentation)
          mainWindow.flashFrame(presentation.requiresUserAction)
        },
        onFinish: (outcome: CaptivateAdapterActivityOutcome): void => {
          captivateActivity.hooks.onFinish(outcome)
          stopWindowFlashing()
        }
      }
    : undefined

  return {
    driverPath: resolveCaptivateClassicDriverPath({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    }),
    seedCptxPaths: defaultCaptivateSeedCandidates(
      app.getPath('documents'),
      app.getAppPath()
    ),
    ...(activityHooks ? { activityHooks } : {})
  }
}

function stopWindowFlashing(): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false)
  } catch {
    // A disappearing renderer must not turn a completed Captivate run into a failure.
  }
}

function courseServiceRuntime(): CourseServiceRuntime {
  return { captivate: captivateRuntime(true) }
}

function createWindow(): void {
  const shellConfiguration = desktopShellConfiguration()
  const rendererLocation = resolveTrustedRendererLocation({
    isPackaged: app.isPackaged,
    developmentUrl: process.env.ELECTRON_RENDERER_URL,
    productionFilePath: join(__dirname, '../renderer/index.html')
  })
  trustedRendererLocation = rendererLocation
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 800,
    minWidth: 940,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: 'Compos-a-toast',
    ...shellConfiguration.windowOptions,
    webPreferences: createSecureRendererPreferences(join(__dirname, '../preload/index.cjs'))
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const refreshSystemAppearance = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const nextConfiguration = desktopShellConfiguration()
    mainWindow.setBackgroundColor(nextConfiguration.windowOptions.backgroundColor ?? '#F3F3F3')

    if (
      nextConfiguration.windowsBuild !== null &&
      nextConfiguration.windowsBuild >= 22_621
    ) {
      mainWindow.setBackgroundMaterial(nextConfiguration.usesMica ? 'mica' : 'none')
    }

    const titleBarOverlay = nextConfiguration.windowOptions.titleBarOverlay
    if (typeof titleBarOverlay === 'object') mainWindow.setTitleBarOverlay(titleBarOverlay)
  }

  nativeTheme.on('updated', refreshSystemAppearance)
  mainWindow.on('closed', () => {
    nativeTheme.removeListener('updated', refreshSystemAppearance)
    mainWindow = null
    trustedRendererLocation = null
  })
  mainWindow.on('close', (event) => {
    if (!captivateActivity.isActive()) return
    event.preventDefault()
    deferQuitUntilCaptivateIsIdle()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererLocation)) event.preventDefault()
  })

  if (rendererLocation.kind === 'development') {
    void mainWindow.loadURL(rendererLocation.url)
  } else {
    void mainWindow.loadFile(rendererLocation.filePath)
  }
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const window = mainWindow
  const location = trustedRendererLocation
  if (
    !window ||
    !location ||
    !isTrustedMainFrame(event.sender, event.senderFrame, window.webContents) ||
    !event.senderFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, location)
  ) {
    throw new Error('Rejected privileged IPC from an untrusted renderer frame.')
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.selectCourse, async (event) => {
    assertTrustedIpcSender(event)
    const options: OpenDialogOptions = {
      title: 'Choose a published Composica course folder',
      properties: ['openDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.selectOutput, async (event) => {
    assertTrustedIpcSender(event)
    const options: OpenDialogOptions = {
      title: 'Choose an export destination',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.analyzeCourse, (event, sourcePath: string) => {
    assertTrustedIpcSender(event)
    return analyzeCourse(sourcePath)
  })

  ipcMain.handle(IPC_CHANNELS.exportCourse, (event, request: ExportRequestDto) => {
    assertTrustedIpcSender(event)
    return exportCourse(request, courseServiceRuntime())
  })

  ipcMain.handle(IPC_CHANNELS.environment, async (event) => {
    assertTrustedIpcSender(event)
    const captivate = await detectCaptivate()
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      captivate,
      captivateAdapter: (await probeCaptivateAdapter(captivate, captivateRuntime())).capability
    }
  })
}

app.enableSandbox()
nativeTheme.themeSource = 'system'

app.on('before-quit', (event) => {
  if (!captivateActivity.isActive()) return
  event.preventDefault()
  deferQuitUntilCaptivateIsIdle()
})

const ownsSingleInstanceLock = app.requestSingleInstanceLock()

if (!ownsSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Never steal foreground focus from the version-pinned Captivate driver.
    focusExistingWindow(mainWindow, { allowFocus: !captivateActivity.isActive() })
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.composatoast.desktop')
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
