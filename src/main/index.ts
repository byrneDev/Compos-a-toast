import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type OpenDialogOptions
} from 'electron'
import { detectCaptivate } from '../core/captivate/detect'
import { analyzeCourse, exportCourse } from './course-service'
import { IPC_CHANNELS, type ExportRequestDto } from '../shared/contracts'
import {
  createDesktopShellConfiguration,
  createSecureRendererPreferences,
  type NativeThemeSnapshot
} from './windows-shell'

let mainWindow: BrowserWindow | null = null

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

function createWindow(): void {
  const shellConfiguration = desktopShellConfiguration()
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
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (!developmentUrl || !url.startsWith(developmentUrl)) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.selectCourse, async () => {
    const options: OpenDialogOptions = {
      title: 'Choose a published Composica course folder',
      properties: ['openDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.selectOutput, async () => {
    const options: OpenDialogOptions = {
      title: 'Choose an export destination',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.analyzeCourse, (_event, sourcePath: string) =>
    analyzeCourse(sourcePath)
  )

  ipcMain.handle(IPC_CHANNELS.exportCourse, (_event, request: ExportRequestDto) =>
    exportCourse(request)
  )

  ipcMain.handle(IPC_CHANNELS.environment, async () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    captivate: await detectCaptivate()
  }))
}

app.enableSandbox()
nativeTheme.themeSource = 'system'

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.composatoast.desktop')
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
