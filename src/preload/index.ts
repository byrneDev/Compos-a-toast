import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type CaptivateProgressDto,
  type CourseSummaryDto,
  type DesktopApi,
  type EnvironmentDto,
  type ExportRequestDto,
  type ExportResultDto
} from '../shared/contracts'

const api: DesktopApi = {
  selectCourse: () => ipcRenderer.invoke(IPC_CHANNELS.selectCourse) as Promise<string | null>,
  selectOutput: () => ipcRenderer.invoke(IPC_CHANNELS.selectOutput) as Promise<string | null>,
  analyzeCourse: (sourcePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.analyzeCourse, sourcePath) as Promise<CourseSummaryDto>,
  exportCourse: (request: ExportRequestDto) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportCourse, request) as Promise<ExportResultDto>,
  getEnvironment: () =>
    ipcRenderer.invoke(IPC_CHANNELS.environment) as Promise<EnvironmentDto>,
  onCaptivateProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, progress: CaptivateProgressDto): void =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.captivateProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.captivateProgress, handler)
  },
  onQuitDeferred: (listener) => {
    const handler = (_event: IpcRendererEvent, message: string): void => listener(message)
    ipcRenderer.on(IPC_CHANNELS.quitDeferred, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.quitDeferred, handler)
  }
}

contextBridge.exposeInMainWorld('composAToast', api)
