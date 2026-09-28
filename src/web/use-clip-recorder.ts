// Recording a clip for the sound menu's custom sounds (#1207): the microphone,
// the MediaRecorder, the cut-off under the five-second limit, and the clip
// handed on to the import as a file.
//
// Lifted out of CustomSoundsSection.tsx unchanged. The section keeps what a
// recording is for — the library's ceiling, the error line and the import —
// and passes them in under the names the body already used.
import { useEffect, useRef, useState } from "react";

/** The containers a recording is asked for, most wanted first. The first the
 *  browser can write is the one it records in; if it can write none of them,
 *  the recorder is built without one and the browser chooses. */
export const RECORDING_FORMATS = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;

/** The first of RECORDING_FORMATS this browser can record, or undefined. */
export function recordingFormat(isTypeSupported: (type: string) => boolean): string | undefined {
  return RECORDING_FORMATS.find(type => isTypeSupported(type));
}

/** How long a recording runs before it stops on its own. Stop just before the
 *  five-second limit to allow encoder/container overhead. */
export const RECORDING_LIMIT_MS = 4400;

/** The name and type a finished recording is imported under: the container's
 *  own extension, and its MIME type without the codec parameter. */
export function recordedClipName(mimeType: string): { name: string; type: string } {
  const mime = mimeType.split(";")[0];
  const extension = mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm";
  return { name: `Recorded voice.${extension}`, type: mime };
}

export function useClipRecorder({ full, setCustomError, runCustom, onImportCustom }: {
  /** The library is at its ceiling, so a press records nothing. */
  full: boolean;
  setCustomError: (message: string) => void;
  /** Clears the error, runs the work, and says why it failed. */
  runCustom: (work: () => Promise<void>) => Promise<void>;
  onImportCustom: (file: File) => Promise<void>;
}) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopRecording = () => {
    if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current);
    recordingTimerRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const startRecording = async () => {
    if (full) return;
    setCustomError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setCustomError("Microphone recording is unavailable in this browser.");
      return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setCustomError("Microphone access was denied or unavailable."); return; }
    if (recorderRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
    try {
      const format = recordingFormat(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, format ? { mimeType: format } : undefined);
      const chunks: Blob[] = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => setCustomError("Recording failed. Please try again.");
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        const shouldSave = recorderRef.current === recorder;
        if (shouldSave) recorderRef.current = null;
        setRecording(false);
        if (!shouldSave || !chunks.length) return;
        const clip = recordedClipName(recorder.mimeType);
        const file = new File(chunks, clip.name, { type: clip.type });
        void runCustom(() => onImportCustom(file));
      };
      recorder.start(200);
      setRecording(true);
      recordingTimerRef.current = setTimeout(stopRecording, RECORDING_LIMIT_MS);
    } catch {
      recorderRef.current = null;
      stream.getTracks().forEach(track => track.stop());
      setCustomError("This browser cannot record a supported audio format.");
    }
  };

  useEffect(() => () => {
    if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current);
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  return { recording, startRecording, stopRecording };
}
