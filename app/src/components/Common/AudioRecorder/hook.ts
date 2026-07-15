import { useState, useCallback, useRef } from "react";

export interface recorderControls {
  startRecording: () => Promise<MediaStream | undefined>;
  stopRecording: () => void;
  togglePauseResume: () => void;
  recordingBlob?: Blob;
  isRecording: boolean;
  isPaused: boolean;
  recordingTime: number;
  mediaRecorder?: MediaRecorder;
}

export type MediaAudioTrackConstraints = Pick<
  MediaTrackConstraints,
  | "deviceId"
  | "groupId"
  | "autoGainControl"
  | "channelCount"
  | "echoCancellation"
  | "noiseSuppression"
  | "sampleRate"
  | "sampleSize"
>;

/**
 * @returns Controls for the recording. Details of returned controls are given below
 *
 * @param `audioTrackConstraints`: Takes a {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings#instance_properties_of_audio_tracks subset} of `MediaTrackConstraints` that apply to the audio track
 * @param `onNotAllowedOrFound`: A method that gets called when the getUserMedia promise is rejected. It receives the DOMException as its input.
 *
 * @details `startRecording`: Calling this method would result in the recording to start. Sets `isRecording` to true
 * @details `stopRecording`: This results in a recording in progress being stopped and the resulting audio being present in `recordingBlob`. Sets `isRecording` to false
 * @details `togglePauseResume`: Calling this method would pause the recording if it is currently running or resume if it is paused. Toggles the value `isPaused`
 * @details `recordingBlob`: This is the recording blob that is created after `stopRecording` has been called
 * @details `isRecording`: A boolean value that represents whether a recording is currently in progress
 * @details `isPaused`: A boolean value that represents whether a recording in progress is paused
 * @details `recordingTime`: Number of seconds that the recording has gone on. This is updated every second
 * @details `mediaRecorder`: The current mediaRecorder in use
 */
const useAudioRecorder: (
  audioTrackConstraints?: MediaAudioTrackConstraints,
  onNotAllowedOrFound?: (exception: DOMException) => any,
  mediaRecorderOptions?: MediaRecorderOptions
) => recorderControls = (
  audioTrackConstraints,
  onNotAllowedOrFound,
  mediaRecorderOptions
) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder>();
  const [timerInterval, setTimerInterval] = useState<NodeJS.Timer>();
  const [recordingBlob, setRecordingBlob] = useState<Blob>();
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const hasStoppedRef = useRef<boolean>(false);

  const _startTimer: () => void = useCallback(() => {
    const interval = setInterval(() => {
      setRecordingTime((time) => time + 1);
    }, 1000);
    setTimerInterval(interval);
  }, [setRecordingTime, setTimerInterval]);

  const _stopTimer: () => void = useCallback(() => {
    timerInterval != null && clearInterval(timerInterval);
    setTimerInterval(undefined);
  }, [timerInterval, setTimerInterval]);

  const cleanupResources = useCallback(() => {
    // Stop all audio tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => {
        if (track.readyState === 'live') {
          track.stop();
        }
      });
      mediaStreamRef.current = null;
    }
  }, []);

  /**
   * Calling this method would result in the recording to start. Sets `isRecording` to true
   */
  const startRecording: () => Promise<MediaStream | undefined> = useCallback(async () => {
    if (timerInterval != null) return undefined;
    hasStoppedRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: audioTrackConstraints ? audioTrackConstraints : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      
      mediaStreamRef.current = stream;

      localStorage.setItem('microphone_permission_granted', 'true');

      setIsRecording(true);
      
      let options: MediaRecorderOptions = mediaRecorderOptions || {};
      if (!options.mimeType) {
        const mimeTypes = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
          ''  // Default
        ];
        
        for (const type of mimeTypes) {
          if (!type || MediaRecorder.isTypeSupported(type)) {
            options.mimeType = type;
            break;
          }
        }
      }

      if (!options.audioBitsPerSecond) {
        options.audioBitsPerSecond = 128000; // 128kbps
      }

      const recorder = new MediaRecorder(stream, options);
      const dataChunks: Blob[] = [];
      
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          dataChunks.push(event.data);
        }
      };
      
      recorder.onstop = () => {
        const blob = new Blob(dataChunks, { type: options.mimeType || 'audio/webm' });
        setRecordingBlob(blob);
        
        // Only auto-cleanup resources if not manually stopped to avoid duplicated cleanup
        if (!hasStoppedRef.current) {
          cleanupResources();
        }
        
        setMediaRecorder(undefined);
      };
      
      recorder.onerror = (event) => {
        console.error("MediaRecorder error:", event);
      };
      
      // Set more frequent data collection for better visualization
      recorder.start(100); // Collect data every 100ms
      
      setMediaRecorder(recorder);
      _startTimer();
      
      // Return stream for use in AudioDialog
      return stream;
    } catch (err: any) {
      console.error("Failed to get microphone access:", err.name, err.message);

      // Clear cached permission on any error
      localStorage.removeItem('microphone_permission_granted');

      // Provide more detailed error information
      if (err.name === 'NotAllowedError') {
        console.error("User denied microphone permission");
      } else if (err.name === 'NotFoundError') {
        console.error("No microphone device found");
      } else if (err.name === 'NotReadableError') {
        console.error("Microphone may be in use by another application");
      }

      onNotAllowedOrFound?.(err);
      throw err; // Rethrow error for UI handling
    }
  }, [
    timerInterval,
    setIsRecording,
    setMediaRecorder,
    _startTimer,
    setRecordingBlob,
    onNotAllowedOrFound,
    mediaRecorderOptions,
    cleanupResources,
  ]);

  /**
   * Calling this method results in a recording in progress being stopped and the resulting audio being present in `recordingBlob`. Sets `isRecording` to false
   */
  const stopRecording: () => void = useCallback(() => {
    hasStoppedRef.current = true;
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
      } catch (err) {
        console.error("Failed to stop recording:", err);
      }
    } else {
      console.warn("Cannot stop recording: MediaRecorder doesn't exist or is already inactive");
    }
    
    _stopTimer();
    setRecordingTime(0);
    setIsRecording(false);
    setIsPaused(false);
    
    cleanupResources();
  }, [
    mediaRecorder,
    setRecordingTime,
    setIsRecording,
    setIsPaused,
    _stopTimer,
    cleanupResources,
  ]);

  /**
   * Calling this method would pause the recording if it is currently running or resume if it is paused. Toggles the value `isPaused`
   */
  const togglePauseResume: () => void = useCallback(() => {
    if (!mediaRecorder) {
      console.warn("Cannot pause/resume: MediaRecorder doesn't exist");
      return;
    }
    
    if (isPaused) {
      setIsPaused(false);
      try {
        mediaRecorder.resume();
        _startTimer();
      } catch (err) {
        console.error("Failed to resume recording:", err);
      }
    } else {
      setIsPaused(true);
      _stopTimer();
      try {
        mediaRecorder.pause();
      } catch (err) {
        console.error("Failed to pause recording:", err);
      }
    }
  }, [mediaRecorder, isPaused, setIsPaused, _startTimer, _stopTimer]);

  return {
    startRecording,
    stopRecording,
    togglePauseResume,
    recordingBlob,
    isRecording,
    isPaused,
    recordingTime,
    mediaRecorder,
  };
};

export default useAudioRecorder;
