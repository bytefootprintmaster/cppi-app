/**
 * Minimal typings for `@moonshine-ai/moonshine-js`.
 *
 * The package ships a single bundled `dist/moonshine.min.js` with no bundled
 * declarations, so TypeScript cannot infer the API. We only declare the surface
 * the portal actually uses — on-device speech-to-text over a MediaStream.
 */
declare module '@moonshine-ai/moonshine-js' {
  export interface TranscriberCallbacks {
    onPermissionsRequested: () => void
    onError: (error: unknown) => void
    onModelLoadStarted: () => void
    onModelLoaded: () => void
    onTranscribeStarted: () => void
    onTranscribeStopped: () => void
    onTranscriptionUpdated: (text: string) => void
    onTranscriptionCommitted: (text: string, buffer?: AudioBuffer) => void
    onFrame: (probability: number, frame: Float32Array, ema: number) => void
    onSpeechStart: () => void
    onSpeechEnd: () => void
  }

  /** Transcribes a WebAudio MediaStream, e.g. from the user's microphone. */
  export class Transcriber {
    constructor(
      modelURL: string,
      callbacks?: Partial<TranscriberCallbacks>,
      useVAD?: boolean,
      precision?: string
    )
    isActive: boolean
    attachStream(stream: MediaStream): void
    load(): Promise<void>
    start(): Promise<void>
    stop(): void
  }

  export const Settings: {
    BASE_ASSET_PATH: {
      MOONSHINE: string
      ONNX_RUNTIME: string
      SILERO_VAD: string
    }
    VERBOSE_LOGGING: boolean
  }
}
