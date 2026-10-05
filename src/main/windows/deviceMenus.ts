import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { Menu } from 'electron'
import type { CaptureDevice, RecordingOptions } from '@shared/models/devices'

export interface DeviceMenuActions {
  setMicrophone: (deviceId: string | null) => void
  setCamera: (deviceId: string | null) => void
}

function deviceItems(
  devices: CaptureDevice[],
  selectedId: string | null,
  select: (deviceId: string | null) => void,
  offLabel: string
): MenuItemConstructorOptions[] {
  return [
    { label: offLabel, type: 'checkbox', checked: selectedId === null, click: () => select(null) },
    ...devices.map(
      (device): MenuItemConstructorOptions => ({
        label: device.name,
        type: 'checkbox',
        checked: device.id === selectedId,
        click: () => select(device.id)
      })
    )
  ]
}

/** Which microphone to record. What the computer plays has its own switch on the bar. */
export function showMicrophoneMenu(
  window: BrowserWindow,
  microphones: CaptureDevice[],
  options: RecordingOptions,
  actions: DeviceMenuActions
): void {
  Menu.buildFromTemplate([
    { label: 'Microfone', enabled: false },
    ...deviceItems(microphones, options.microphoneId, actions.setMicrophone, 'Sem microfone')
  ]).popup({ window })
}

export function showCameraMenu(
  window: BrowserWindow,
  cameras: CaptureDevice[],
  options: RecordingOptions,
  actions: DeviceMenuActions
): void {
  Menu.buildFromTemplate([
    { label: 'Câmera', enabled: false },
    ...deviceItems(cameras, options.cameraId, actions.setCamera, 'Sem câmera')
  ]).popup({ window })
}
