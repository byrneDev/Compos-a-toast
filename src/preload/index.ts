import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
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
    ipcRenderer.invoke(IPC_CHANNELS.environment) as Promise<EnvironmentDto>
}

contextBridge.exposeInMainWorld('composAToast', api)
