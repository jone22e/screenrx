/** The app's version, put in by the web build (vite.web.config.ts). */
declare const __APP_VERSION__: string

/** Chromium's reader of a media track's frames (the Insertable Streams API); not in the DOM typings yet. */
declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame | AudioData> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number })
  readonly readable: ReadableStream<T>
}
