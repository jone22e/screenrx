import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload of the meeting window only (a page of the meeting app, not one of ours). It exposes one
 * write-only bridge, `screenrxMeetAudio`, through which the page hands over the meeting's mixed audio
 * for the recording. Nothing is ever read back and no other channel is reachable from the page.
 */
contextBridge.exposeInMainWorld('screenrxMeetAudio', {
  begin: (startedAtMs: number, mimeType: string): void => {
    ipcRenderer.send('meet-audio:begin', startedAtMs, mimeType)
  },
  chunk: (data: ArrayBuffer): void => {
    ipcRenderer.send('meet-audio:chunk', data)
  },
  end: (): void => {
    ipcRenderer.send('meet-audio:end')
  },
  onStopRequest: (callback: () => void): void => {
    ipcRenderer.once('meet-audio:stop', () => callback())
  }
})
