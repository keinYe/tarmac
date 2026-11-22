import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEvent, DesktopRequest, HookRequest, HostRequest, ShellRcRequest, WorkspaceRequest } from './bridge.ts';

const bridge: DesktopBridge = {
  ready: () => ipcRenderer.invoke('m0:ready'),
  workspace: (request: WorkspaceRequest) => ipcRenderer.invoke('m0:workspace', request),
  request: <T>(request: DesktopRequest): Promise<T> => ipcRenderer.invoke('m0:request', request),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent): void => listener(event);
    ipcRenderer.on('m0:event', handler);
    return () => ipcRenderer.removeListener('m0:event', handler);
  },
  shellRc: (request: ShellRcRequest) => ipcRenderer.invoke('m0:shell-rc', request),
  hooks: ((request: HookRequest) => ipcRenderer.invoke('m0:hooks', request)) as DesktopBridge['hooks'],
  hosts: ((request: HostRequest) => ipcRenderer.invoke('m0:hosts', request)) as DesktopBridge['hosts'],
  uploadImage: request => ipcRenderer.invoke('m0:upload-image', request),
};

contextBridge.exposeInMainWorld('tarmac', bridge);
