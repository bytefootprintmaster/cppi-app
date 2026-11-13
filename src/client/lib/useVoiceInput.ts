import { useCallback, useEffect, useRef, useState } from 'react'
import type { Transcriber } from '@moonshine-ai/moonshine-js'

/**
 * On-device speech-to-text for the chat composer, powered by Moonshine.
 *
 * Everything runs in the browser: the microphone stream is transcribed locally
 * and the recognized phrases are handed to `onPhrase`. Nothing about the audio
 * or the transcript leaves the device.
 *
 * The model and the VAD/ONNX runtime are fetched from their public CDNs the
 * first time dictation starts, so the first sentence may take a moment.
 */
export type VoicePhase = 'idle' | 'loading' | 'listening' | 'error'

export interface VoiceInput {
  /** False when the browser lacks the microphone APIs Moonshine needs. */
  supported: boolean
  phase: VoicePhase
  /** A human-readable reason the last attempt failed, if any. */
  error: string | null
  listening: boolean
  /** True while the model is being downloaded/initialized. */
  loading: boolean
  /** Start dictating, or stop if already listening. */
  toggle: () => void
  stop: () => void
}

/** Bundled Moonshine model, resolved against the library's `download.moonshine.ai` CDN. */
const MODEL_URL = 'model/tiny'

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access was blocked. Allow the microphone for this site and try again.'
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'No usable microphone was found on this device.'
    }
  }
  return 'Voice input could not start. Check your microphone and connection, then try again.'
}

export function useVoiceInput(onPhrase: (phrase: string) => void): VoiceInput {
  const onPhraseRef = useRef(onPhrase)
  const transcriberRef = useRef<Transcriber | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [error, setError] = useState<string | null>(null)

  const supported =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    'AudioContext' in window

  useEffect(() => {
    onPhraseRef.current = onPhrase
  }, [onPhrase])

  /** Tears down the transcriber and releases the microphone. No state updates. */
  const release = useCallback(() => {
    const transcriber = transcriberRef.current
    transcriberRef.current = null
    if (transcriber) {
      try {
        transcriber.stop()
      } catch {
        // Already torn down.
      }
    }
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
  }, [])

  const stop = useCallback(() => {
    release()
    setPhase('idle')
    setError(null)
  }, [release])

  const start = useCallback(async () => {
    if (!supported) {
      setPhase('error')
      setError('Voice input is not supported in this browser.')
      return
    }
    setError(null)
    setPhase('loading')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
          sampleRate: 16000
        }
      })
      streamRef.current = stream

      // Loaded lazily so the chat page never pays for the speech bundle up front.
      const Moonshine = await import('@moonshine-ai/moonshine-js')
      const transcriber = new Moonshine.Transcriber(
        MODEL_URL,
        {
          onModelLoadStarted: () => setPhase('loading'),
          onTranscribeStarted: () => setPhase('listening'),
          onTranscribeStopped: () => setPhase('idle'),
          onTranscriptionCommitted: (text: string) => {
            const phrase = text.trim()
            if (phrase) onPhraseRef.current(phrase)
          },
          onError: () => {
            setPhase('error')
            setError('Voice input stopped unexpectedly. Try again.')
          }
        },
        true // VAD mode: commit each phrase after a pause in speech.
      )
      transcriberRef.current = transcriber
      transcriber.attachStream(stream)
      await transcriber.start()
    } catch (err) {
      release()
      setError(describeError(err))
      setPhase('error')
    }
  }, [release, supported])

  const toggle = useCallback(() => {
    if (phase === 'listening') stop()
    else if (phase === 'idle' || phase === 'error') void start()
  }, [phase, start, stop])

  // Never leave the microphone hot when the composer unmounts.
  useEffect(() => release, [release])

  return {
    supported,
    phase,
    error,
    listening: phase === 'listening',
    loading: phase === 'loading',
    toggle,
    stop
  }
}
