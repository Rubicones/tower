"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioEngine } from "./engine";
import type { AtcStatus, DebugEvent, DebugSnapshot, TimerPreset } from "./types";

/** The fade-out occupies the final minute of the sleep timer. */
const FADE_SECONDS = 60;

const DEFAULT_RADIO_VOLUME = 47; // was 70; x1.5 quieter by default
const DEFAULT_MUSIC_VOLUME = 45;

export interface UseAudioEngineResult {
  isPlaying: boolean;
  toggle: () => void;
  radioVolume: number;
  setRadioVolume: (value: number) => void;
  musicVolume: number;
  setMusicVolume: (value: number) => void;
  timer: TimerPreset;
  setTimer: (preset: TimerPreset) => void;
  /** Seconds until the sleep timer stops playback; null when no timer runs. */
  remainingSeconds: number | null;
  /** Which rung of the ATC failover ladder is currently playing. */
  status: AtcStatus;
  /**
   * Dev-only telemetry (see `components/debug-panel.tsx`). Safe to call
   * before playback starts — snapshot/waveform just return null until the
   * engine is built.
   */
  debug: {
    enable: () => void;
    getSnapshot: () => DebugSnapshot | null;
    getWaveform: () => Float32Array | null;
    subscribe: (cb: (event: DebugEvent) => void) => () => void;
  };
}

/**
 * The only place the UI touches audio. All Tone.js state lives in
 * `AudioEngine`; this hook owns the React-facing state (play state,
 * slider values, sleep-timer countdown) and keeps the two in sync.
 */
export function useAudioEngine(): UseAudioEngineResult {
  const engineRef = useRef<AudioEngine | null>(null);
  const startingRef = useRef(false);
  const fadingRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [radioVolume, setRadioVolumeState] = useState(DEFAULT_RADIO_VOLUME);
  const [musicVolume, setMusicVolumeState] = useState(DEFAULT_MUSIC_VOLUME);
  const [timer, setTimerState] = useState<TimerPreset>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(
    null,
  );
  const [status, setStatus] = useState<AtcStatus>("streaming");

  const getEngine = useCallback((): AudioEngine => {
    if (!engineRef.current) {
      const engine = new AudioEngine();
      engine.onStatus = (next) => setStatus(next);
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    engineRef.current?.pause();
    fadingRef.current = false;
    setIsPlaying(false);
    setRemainingSeconds(null);
  }, []);

  const toggle = useCallback(() => {
    if (startingRef.current) return;
    if (isPlaying) {
      stopPlayback();
      return;
    }
    const engine = getEngine();
    startingRef.current = true;
    void engine
      .start()
      .then(() => {
        engine.setRadioVolume(radioVolume);
        engine.setMusicVolume(musicVolume);
        fadingRef.current = false;
        setIsPlaying(true);
        setRemainingSeconds(timer === null ? null : timer * 60);
      })
      .finally(() => {
        startingRef.current = false;
      });
  }, [getEngine, isPlaying, musicVolume, radioVolume, stopPlayback, timer]);

  const setRadioVolume = useCallback((value: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    setRadioVolumeState(clamped);
    engineRef.current?.setRadioVolume(clamped);
  }, []);

  const setMusicVolume = useCallback((value: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    setMusicVolumeState(clamped);
    engineRef.current?.setMusicVolume(clamped);
  }, []);

  const setTimer = useCallback(
    (preset: TimerPreset) => {
      setTimerState(preset);
      if (fadingRef.current) {
        engineRef.current?.cancelFade();
        fadingRef.current = false;
      }
      setRemainingSeconds(preset !== null && isPlaying ? preset * 60 : null);
    },
    [isPlaying],
  );

  // Sleep-timer countdown. The fade starts FADE_SECONDS before zero, so the
  // total time from arming to silence equals the chosen preset.
  useEffect(() => {
    if (!isPlaying || remainingSeconds === null) return;
    if (remainingSeconds <= FADE_SECONDS && !fadingRef.current) {
      fadingRef.current = true;
      engineRef.current?.beginFade(remainingSeconds);
    }
    const id = setTimeout(() => {
      if (remainingSeconds <= 1) {
        stopPlayback();
      } else {
        setRemainingSeconds(remainingSeconds - 1);
      }
    }, 1_000);
    return () => clearTimeout(id);
  }, [isPlaying, remainingSeconds, stopPlayback]);

  // Lock-screen / hardware-key controls via the Media Session API.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: "tower",
      artist: "airport at 3 am",
      artwork: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
    session.playbackState = isPlaying ? "playing" : "paused";
    session.setActionHandler("play", () => {
      if (!isPlaying) toggle();
    });
    session.setActionHandler("pause", () => {
      if (isPlaying) toggle();
    });
    return () => {
      session.setActionHandler("play", null);
      session.setActionHandler("pause", null);
    };
  }, [isPlaying, toggle]);

  // Dispose the whole audio graph on unmount (also keeps hot reload clean).
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const debugEnable = useCallback(() => {
    getEngine().enableDebug();
  }, [getEngine]);

  const debugGetSnapshot = useCallback((): DebugSnapshot | null => {
    return engineRef.current?.getDebugSnapshot() ?? null;
  }, []);

  const debugGetWaveform = useCallback((): Float32Array | null => {
    return engineRef.current?.getDebugWaveform() ?? null;
  }, []);

  const debugSubscribe = useCallback(
    (cb: (event: DebugEvent) => void) => {
      const engine = getEngine();
      engine.enableDebug();
      engine.onDebugEvent = cb;
      return () => {
        if (engineRef.current) engineRef.current.onDebugEvent = null;
      };
    },
    [getEngine],
  );

  const debug = useMemo(
    () => ({
      enable: debugEnable,
      getSnapshot: debugGetSnapshot,
      getWaveform: debugGetWaveform,
      subscribe: debugSubscribe,
    }),
    [debugEnable, debugGetSnapshot, debugGetWaveform, debugSubscribe],
  );

  return {
    isPlaying,
    toggle,
    radioVolume,
    setRadioVolume,
    musicVolume,
    setMusicVolume,
    timer,
    setTimer,
    remainingSeconds,
    status,
    debug,
  };
}
