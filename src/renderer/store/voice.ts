// Voice in the renderer: what speech the box can do for each agent, recording from the microphone
// with MediaRecorder, sending a recording to be transcribed, playing voice memos, and reading
// replies aloud. Recordings are staged as attachments, so a remote box gets them the way it gets
// any attachment. One thing plays at a time: starting a memo stops a reply being read, and back.
import { useEffect } from "react";
import type { StagedAttachment } from "../../shared/edges";
import type { AgentSummary, SpokenAudio, VoiceCapabilities, VoiceTranscription } from "../../shared/model";
import { desktop, gateway, main } from "../bridge";
import { modelSettings } from "./models";
import { readSlice, sliceKey, writeSlice } from "./slices";
import { Store, useStore } from "./store";

// ---- what the box can do -------------------------------------------------------------------

/** By agent id; "*" for no agent in particular (a new agent's editor). */
export const voiceCapabilities = new Store<Record<string, VoiceCapabilities>>({});
const capabilityLoads = new Map<string, Promise<VoiceCapabilities>>();

const reason = (error: unknown) => (error instanceof Error ? error.message.replace(/^[\w/-]+: /, "") : String(error));

/** The box's answer for this agent; a box that can't be asked counts as no speech, with why. */
export function loadVoiceCapabilities(agentId: string | null, force = false): Promise<VoiceCapabilities> {
  const key = agentId ?? "*";
  const known = voiceCapabilities.get()[key];
  if (!force && known != null) return Promise.resolve(known);
  const running = capabilityLoads.get(key);
  if (running != null) return running;
  const load = gateway
    .getVoiceCapabilities(agentId != null ? { agentId } : {})
    .catch((error): VoiceCapabilities => {
      const why = /unknown-method/.test(String(error)) ? "Your box doesn’t do voice yet. Update the box server." : `The box can’t be reached right now (${reason(error)}).`;
      return { transcription: null, transcriptionUnavailable: why, speech: null, speechUnavailable: why, voices: [] };
    })
    .then((capabilities) => {
      voiceCapabilities.set((state) => ({ ...state, [key]: capabilities }));
      return capabilities;
    })
    .finally(() => capabilityLoads.delete(key));
  capabilityLoads.set(key, load);
  return load;
}

/** Asks the box again for one agent (its voice or model changed) or, with no agent, for all of them. */
export function forgetVoiceCapabilities(agentId?: string): void {
  voiceCapabilities.set((state) => {
    if (agentId == null) return {};
    const { [agentId]: _dropped, ...rest } = state;
    return rest;
  });
}

// Connecting or removing a provider changes what's possible.
modelSettings.subscribe(() => forgetVoiceCapabilities());

export function useVoiceCapabilities(agentId: string | null): VoiceCapabilities | undefined {
  const capabilities = useStore(voiceCapabilities, (state) => state[agentId ?? "*"]);
  useEffect(() => {
    if (capabilities == null) void loadVoiceCapabilities(agentId);
  }, [agentId, capabilities]);
  return capabilities;
}

// ---- recording -------------------------------------------------------------------------------

/** MP4 (AAC) first: both xAI and OpenAI take it. OpenAI also takes WebM, Chromium's fallback. */
const RECORDING_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];

export interface Recording {
  readonly mimeType: string;
  readonly startedAt: number;
  /** How loud the microphone is now, 0 to 1. */
  level(): number;
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (desktop.environment.platform === "win32") return "The microphone is blocked. Let desktop apps use it in Windows Settings → Privacy & security → Microphone, then try again.";
    if (desktop.environment.platform === "darwin") return "The microphone is blocked. Allow Wisp in System Settings → Privacy & Security → Microphone, then try again.";
    return "The microphone is blocked. Allow this app to use it, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy or unavailable. Close other apps that use it and try again.";
  return `The microphone couldn’t start: ${reason(error)}`;
}

export async function startRecording(): Promise<Recording> {
  if (navigator.mediaDevices?.getUserMedia == null || typeof MediaRecorder === "undefined") throw new Error("Recording isn’t available in this window.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    throw new Error(microphoneError(error));
  }
  const preferred = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { ...(preferred != null ? { mimeType: preferred } : {}), audioBitsPerSecond: 64_000 });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(`Recording couldn’t start: ${reason(error)}`);
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  // A level meter, so it's clear the microphone hears something.
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
  };
  const startedAt = Date.now();
  recorder.start();
  const mimeType = () => recorder.mimeType || preferred || "audio/webm";
  return {
    get mimeType() {
      return mimeType();
    },
    startedAt,
    level: () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
    stop: () =>
      new Promise<RecordedAudio>((resolve, reject) => {
        const durationMs = Date.now() - startedAt;
        const finished = () => {
          release();
          resolve({ blob: new Blob(chunks, { type: mimeType() }), mimeType: mimeType(), durationMs });
        };
        recorder.onstop = finished;
        recorder.onerror = () => {
          release();
          reject(new Error("The recording failed."));
        };
        if (recorder.state === "inactive") finished();
        else recorder.stop();
      }),
    cancel: () => {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}

/** A recording's file name, with the extension its format needs (OpenAI reads the format from it). */
export function recordingFileName(kind: "Dictation" | "Voice memo", mimeType: string): string {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}-${two(now.getMinutes())}`;
  return `${kind} ${stamp}.${/webm/i.test(mimeType) ? "webm" : /ogg/i.test(mimeType) ? "ogg" : "m4a"}`;
}

/** Stages a recording as an attachment, where a remote box gets its uploads from. */
export async function stageRecording(audio: RecordedAudio, kind: "Dictation" | "Voice memo"): Promise<StagedAttachment> {
  try {
    return await main.stageUploadBytes({ filename: recordingFileName(kind, audio.mimeType), bytes: new Uint8Array(await audio.blob.arrayBuffer()) });
  } catch (error) {
    throw new Error(`The recording couldn’t be saved: ${reason(error)}`);
  }
}

/** Has the box transcribe a staged recording, for this agent's provider; a dictation's file is deleted afterwards. */
export async function transcribeRecording(agentId: string, staged: StagedAttachment, mimeType: string, kind: "Dictation" | "Voice memo"): Promise<VoiceTranscription> {
  const keep = kind === "Voice memo";
  try {
    return await gateway.speechToText({ attachmentPath: staged.path, mimeType, language: navigator.language, agentId, ...(keep ? {} : { discard: true }) });
  } catch (error) {
    throw new Error(reason(error));
  } finally {
    if (!keep) void main.dropStagedUpload({ path: staged.path }).catch(() => undefined);
  }
}

// ---- playing: one thing at a time ---------------------------------------------------------

let stopPlaying: (() => void) | null = null;

/** Stops whatever plays now; `stop` is how to stop this one when something else starts. */
export function claimPlayback(stop: () => void): void {
  const previous = stopPlaying;
  stopPlaying = stop;
  if (previous != null && previous !== stop) previous();
}

export function releasePlayback(stop: () => void): void {
  if (stopPlaying === stop) stopPlaying = null;
}

const memoUrls = new Map<string, string>();

/** A voice memo as a blob: URL, which plays and seeks however the file was served. */
export async function memoAudioUrl(path: string): Promise<string> {
  const known = memoUrls.get(path);
  if (known != null) return known;
  const response = await fetch(desktop.local.mediaUrl(path));
  if (!response.ok) throw new Error(response.status === 404 ? "The recording isn’t on the box any more." : `The recording couldn’t be loaded (${response.status}).`);
  const url = URL.createObjectURL(await response.blob());
  memoUrls.set(path, url);
  for (const [stalePath, staleUrl] of [...memoUrls].slice(0, Math.max(0, memoUrls.size - 20))) {
    URL.revokeObjectURL(staleUrl);
    memoUrls.delete(stalePath);
  }
  return url;
}

const SPEED_SLICE = sliceKey("voice-memo-speed");
export const MEMO_SPEEDS = [1, 1.5, 2, 0.75] as const;
/** Voice memo playback speed, remembered in the `voice-memo-speed` slice. */
export const memoSpeed = new Store<number>(1);
void readSlice<{ rate: number }>(SPEED_SLICE, 1).then((saved) => {
  if (saved != null && (MEMO_SPEEDS as readonly number[]).includes(saved.rate)) memoSpeed.set(saved.rate);
});
export function setMemoSpeed(rate: number): void {
  memoSpeed.set(rate);
  writeSlice(SPEED_SLICE, 1, { rate });
}

// ---- reading replies aloud ------------------------------------------------------------------

export interface ReadingAloud {
  agentId: string;
  entryId: string;
  state: "loading" | "playing";
  part: number;
  parts: number | null;
}

export const readingAloud = new Store<ReadingAloud | null>(null);
/** Why reading a reply failed, by entry id. */
export const readAloudErrors = new Store<Record<string, string>>({});

let reading = 0;
let finishClip: (() => void) | null = null;

export function stopReadingAloud(): void {
  reading++;
  finishClip?.();
  readingAloud.set(null);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Plays one part; resolves when it ends or is stopped. */
function playClip(clip: SpokenAudio, rate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytesOf(clip.audioBase64)], { type: clip.mimeType }));
    const element = new Audio(url);
    element.playbackRate = rate;
    const done = (error?: Error) => {
      finishClip = null;
      element.pause();
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
      if (error != null) reject(error);
      else resolve();
    };
    finishClip = () => done();
    element.onended = () => done();
    element.onerror = () => done(new Error("The audio couldn’t be played."));
    element.play().catch((error: unknown) => done(new Error(`The audio couldn’t be played: ${reason(error)}`)));
  });
}

/** Reads an assistant reply aloud in the agent's voice, part by part, fetching the next part while one plays. */
export async function readAloud(agent: AgentSummary, entryId: string): Promise<void> {
  stopReadingAloud();
  const session = ++reading;
  claimPlayback(stopReadingAloud);
  readAloudErrors.set(({ [entryId]: _old, ...rest }) => rest);
  readingAloud.set({ agentId: agent.id, entryId, state: "loading", part: 0, parts: null });
  const fetchPart = (part: number) => {
    const request = gateway.speakMessage({ agentId: agent.id, entryId, part });
    request.catch(() => undefined); // awaited below; a stop before then shouldn't log
    return request;
  };
  try {
    let next: Promise<SpokenAudio> | null = fetchPart(0);
    while (next != null) {
      const clip: SpokenAudio = await next;
      if (session !== reading) return;
      next = clip.part + 1 < clip.parts ? fetchPart(clip.part + 1) : null;
      readingAloud.set({ agentId: agent.id, entryId, state: "playing", part: clip.part, parts: clip.parts });
      await playClip(clip, agent.voiceSpeed ?? 1);
      if (session !== reading) return;
      if (next != null) readingAloud.set({ agentId: agent.id, entryId, state: "loading", part: clip.part + 1, parts: clip.parts });
    }
  } catch (error) {
    if (session === reading) readAloudErrors.set((state) => ({ ...state, [entryId]: reason(error) }));
  } finally {
    if (session === reading) {
      readingAloud.set(null);
      releasePlayback(stopReadingAloud);
    }
  }
}

/** Plays `sampleVoice`'s greeting in a voice (the agent editor's Preview). */
export async function sampleVoice(voiceId: string): Promise<void> {
  stopReadingAloud();
  const session = ++reading;
  claimPlayback(stopReadingAloud);
  try {
    const audio = await gateway.sampleVoice({ voiceId, greetingId: "default" });
    if (session !== reading) return;
    await playClip({ ...audio, part: 0, parts: 1, voiceId }, 1);
  } catch (error) {
    throw new Error(reason(error));
  } finally {
    if (session === reading) releasePlayback(stopReadingAloud);
  }
}
