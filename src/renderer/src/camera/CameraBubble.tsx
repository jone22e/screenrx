import { useEffect, useRef, useState } from 'react'
import { useRecordingState } from '../common/recordingStore'

/**
 * A floating self-view of the selected camera, so the user can frame
 * themselves before and while recording. It is only a mirror: the recording
 * is made natively to its own file, and this window — like every window of
 * the app — is excluded from the screen capture.
 */
export function CameraBubble() {
  const { cameraName } = useRecordingState().options
  return cameraName ? <CameraView key={cameraName} cameraName={cameraName} /> : null
}

function CameraView({ cameraName }: { cameraName: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    const release = (media: MediaStream | null): void => media?.getTracks().forEach((track) => track.stop())

    void (async () => {
      try {
        // Device names are only readable once access is granted, so open the
        // default camera first and switch if another one was chosen.
        let media = await navigator.mediaDevices.getUserMedia({ video: true })
        const cameras = await navigator.mediaDevices.enumerateDevices()
        const wanted = cameras.find((device) => device.kind === 'videoinput' && device.label.includes(cameraName))
        if (wanted && wanted.deviceId !== media.getVideoTracks()[0]?.getSettings().deviceId) {
          release(media)
          media = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: wanted.deviceId } } })
        }
        if (cancelled) {
          release(media)
          return
        }
        stream = media
        if (video.current) video.current.srcObject = media
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      release(stream)
    }
  }, [cameraName])

  return (
    <div className="bubble" title={cameraName}>
      {failed ? (
        <span className="bubble-note">Câmera indisponível</span>
      ) : (
        <video ref={video} className="bubble-video" autoPlay muted playsInline />
      )}
    </div>
  )
}
