import type { EncodingOptions } from './encoding.js';
import { isEncodingOptions } from './encoding.js';
/** JSON contracts shared by the HTTP server and browser editor. */
export type OutputFormat = 'mp4' | 'mkv' | 'webm' | 'mp3' | 'wav' | 'flac' | 'm4a';
export type Quality = 'high' | 'balanced' | 'small';
export type Resolution = 'original' | '1080' | '720' | '480';
export type ClipEdge = 'start' | 'end';
export interface Clip { start: number; end: number }
export interface MediaMetadata {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoIndex?: number;
  audioIndex?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}
export interface MediaFile extends MediaMetadata {
  id: string;
  name: string;
  extension: string;
  bytes: number;
  createdAt: string;
}
export interface EditRequest extends EncodingOptions {
  uploadId: string;
  clips: Clip[];
  format: OutputFormat;
  quality?: Quality;
  resolution?: Resolution;
  flipH?: boolean;
  flipV?: boolean;
  mute?: boolean;
  preview?: boolean;
}
export interface Edit extends EncodingOptions {
  format: OutputFormat;
  quality: Quality;
  resolution: Resolution;
  clips: Clip[];
  duration: number;
  flipH: boolean;
  flipV: boolean;
  mute: boolean;
  preview: boolean;
}
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Job {
  id: string;
  uploadId: string;
  name: string;
  edit: Edit;
  status: JobStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  bytes?: number;
  error?: string;
}
export interface HealthResponse { available: boolean; maxUploadBytes: number; encoders?: string[] }
export interface ApiError { error: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}
export function isOutputFormat(value: unknown): value is OutputFormat {
  return value === 'mp4' || value === 'mkv' || value === 'webm' || value === 'mp3' || value === 'wav' || value === 'flac' || value === 'm4a';
}
export function isQuality(value: unknown): value is Quality {
  return value === 'high' || value === 'balanced' || value === 'small';
}
export function isResolution(value: unknown): value is Resolution {
  return value === 'original' || value === '1080' || value === '720' || value === '480';
}
export function isJobStatus(value: unknown): value is JobStatus {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled';
}
export function isClip(value: unknown): value is Clip {
  return isRecord(value) && typeof value.start === 'number' && Number.isFinite(value.start) && typeof value.end === 'number' && Number.isFinite(value.end);
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown): boolean => value === undefined || finite(value);
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
export function parseMediaFile(value: unknown): MediaFile {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
    || typeof value.name !== 'string' || typeof value.extension !== 'string' || !/^\.[a-z0-9]{1,8}$/.test(value.extension)
    || !finite(value.bytes) || !finite(value.duration) || value.duration <= 0
    || typeof value.hasVideo !== 'boolean' || typeof value.hasAudio !== 'boolean'
    || typeof value.createdAt !== 'string' || !optionalNumber(value.videoIndex) || !optionalNumber(value.audioIndex)
    || !optionalNumber(value.width) || !optionalNumber(value.height) || !optionalString(value.videoCodec) || !optionalString(value.audioCodec)) {
    throw new Error('Invalid media metadata.');
  }
  // Every member of this external JSON contract has been checked above.
  return value as unknown as MediaFile;
}
export function parseJob(value: unknown): Job {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
    || typeof value.uploadId !== 'string' || typeof value.name !== 'string' || !isJobStatus(value.status)
    || !finite(value.progress) || typeof value.createdAt !== 'string'
    || !optionalString(value.startedAt) || !optionalString(value.finishedAt) || !optionalString(value.error) || !optionalNumber(value.bytes)) {
    throw new Error('Invalid job metadata.');
  }
  const edit = value.edit;
  if (!isRecord(edit) || !isEncodingOptions(edit) || !isOutputFormat(edit.format) || !isQuality(edit.quality) || !isResolution(edit.resolution)
    || !Array.isArray(edit.clips) || !edit.clips.every(isClip) || !finite(edit.duration)
    || typeof edit.flipH !== 'boolean' || typeof edit.flipV !== 'boolean' || typeof edit.mute !== 'boolean' || typeof edit.preview !== 'boolean') {
    throw new Error('Invalid job settings.');
  }
  return value as unknown as Job;
}
export function parseHealth(value: unknown): HealthResponse {
  if (!isRecord(value) || typeof value.available !== 'boolean' || !finite(value.maxUploadBytes)) throw new Error('Invalid engine response.');
  if (value.encoders !== undefined && (!Array.isArray(value.encoders) || !value.encoders.every(item => typeof item === 'string'))) throw new Error('Invalid encoder list.');
  return { available: value.available, maxUploadBytes: value.maxUploadBytes, encoders: value.encoders as string[] | undefined };
}
export function parseList<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Expected a list from the server.');
  return value.map(parse);
}
