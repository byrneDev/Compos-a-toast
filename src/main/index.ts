import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { detectCaptivate } from '../core/captivate/detect'
import { analyzeCourse, exportCourse } from './course-service'
import { IPC_CHANNELS, type ExportRequestDto } from '../shared/contracts'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 680,
    show: false,
    backgroundColor: '#111827',
    title: 'Compos-a-toast',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

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

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
