// Recording a clip for the sound menu's custom sounds (#1207): the microphone,
// the MediaRecorder, the cut-off under the five-second limit, and the clip
// handed on to the import as a file.
//
// Lifted out of CustomSoundsSection.tsx unchanged. The section keeps what a
// recording is for — the library's ceiling, the error line and the import —
// and passes them in under the names the body already used.
import { useEffect, useRef, useState } from "react";

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
      const format = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
        .find(type => MediaRecorder.isTypeSupported(type));
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
        const mime = recorder.mimeType.split(";")[0];
        const extension = mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm";
        const file = new File(chunks, `Recorded voice.${extension}`, { type: mime });
        void runCustom(() => onImportCustom(file));
      };
      recorder.start(200);
      setRecording(true);
      // Stop just before the five-second limit to allow encoder/container overhead.
      recordingTimerRef.current = setTimeout(stopRecording, 4400);
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
