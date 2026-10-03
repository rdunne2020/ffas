import type { OutputFormat, Quality } from './model.js';

export const videoCodecs = ['libx264', 'libx265', 'libvpx-vp9'] as const;
export type VideoCodec = typeof videoCodecs[number];
export const audioCodecs = ['aac', 'libopus', 'libmp3lame', 'flac', 'pcm_s16le'] as const;
export type AudioCodec = typeof audioCodecs[number];
export const presets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;
export type EncoderPreset = typeof presets[number];
export interface EncodingOptions {
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  rateControl?: 'crf' | 'bitrate';
  crf?: number;
  preset?: EncoderPreset;
  cpuUsed?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  frameRate?: number;
}
export const videoChoices: Record<OutputFormat, readonly VideoCodec[]> = {
  mp4: ['libx264', 'libx265'], mkv: videoCodecs, webm: ['libvpx-vp9'], mp3: [], m4a: [], wav: [], flac: [],
};
export const audioChoices: Record<OutputFormat, readonly AudioCodec[]> = {
  mp4: ['aac'], mkv: audioCodecs, webm: ['libopus'], mp3: ['libmp3lame'], m4a: ['aac'], wav: ['pcm_s16le'], flac: ['flac'],
};
export const codecLabels: Record<VideoCodec | AudioCodec, string> = {
  libx264: 'H.264 / x264', libx265: 'H.265 / x265', 'libvpx-vp9': 'VP9 / libvpx',
  aac: 'AAC', libopus: 'Opus', libmp3lame: 'MP3', flac: 'FLAC', pcm_s16le: 'PCM 16-bit',
};
export const isVideoCodec = (value: unknown): value is VideoCodec => videoCodecs.some(codec => codec === value);
export const isAudioCodec = (value: unknown): value is AudioCodec => audioCodecs.some(codec => codec === value);
export const isPreset = (value: unknown): value is EncoderPreset => presets.some(preset => preset === value);
export function defaultCrf(codec: VideoCodec, quality: Quality): number {
  return { libx264: { high: 18, balanced: 23, small: 30 }, libx265: { high: 23, balanced: 28, small: 32 }, 'libvpx-vp9': { high: 27, balanced: 32, small: 39 } }[codec][quality];
}
export function isEncodingOptions(value: Record<string, unknown>): boolean {
  return (value.videoCodec === undefined || isVideoCodec(value.videoCodec))
    && (value.audioCodec === undefined || isAudioCodec(value.audioCodec))
    && (value.preset === undefined || isPreset(value.preset))
    && (value.rateControl === undefined || value.rateControl === 'crf' || value.rateControl === 'bitrate')
    && ['crf', 'cpuUsed', 'videoBitrateKbps', 'audioBitrateKbps', 'frameRate'].every(key => value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])));
}
/** Resolve defaults here so the UI, new jobs and pre-existing saved jobs agree. */
export function resolveEncoding(body: Record<string, unknown>, format: OutputFormat, quality: Quality, preview = false): EncodingOptions {
  if (!isEncodingOptions(body)) throw new Error('Invalid encoding options.');
  const videoCodec = preview ? (format === 'mp4' ? 'libx264' : undefined) : body.videoCodec ?? videoChoices[format][0];
  const audioCodec = preview ? 'aac' : body.audioCodec ?? audioChoices[format][0];
  if (videoCodec !== undefined && (!isVideoCodec(videoCodec) || !videoChoices[format].includes(videoCodec))) throw new Error('The video codec is not supported by this container.');
  if (!isAudioCodec(audioCodec) || !audioChoices[format].includes(audioCodec)) throw new Error('The audio codec is not supported by this container.');
  const number = (key: string, fallback: number, min: number, max: number, integer = false): number => {
    const value = body[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${key} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
    return value;
  };
  const rateControl = preview ? 'crf' : body.rateControl ?? 'crf';
  if (rateControl !== 'crf' && rateControl !== 'bitrate') throw new Error('Invalid rate control.');
  const preset = preview ? 'ultrafast' : body.preset ?? 'medium';
  if (!isPreset(preset)) throw new Error('Invalid encoder preset.');
  const crf = preview ? 23 : number('crf', defaultCrf(videoCodec ?? 'libx264', quality), 0, videoCodec === 'libvpx-vp9' ? 63 : 51, videoCodec === 'libvpx-vp9');
  const videoBitrateKbps = number('videoBitrateKbps', 2500, 100, 100000, true);
  const audioBitrateKbps = preview ? 192 : number('audioBitrateKbps', { high: 256, balanced: 192, small: 128 }[quality], 16, audioCodec === 'libmp3lame' ? 320 : 512, true);
  const cpuUsed = number('cpuUsed', 4, 0, 5, true);
  const frameRate = body.frameRate === undefined ? undefined : number('frameRate', 30, 1, 120);
  return { videoCodec, audioCodec, rateControl, crf, preset, cpuUsed, videoBitrateKbps, audioBitrateKbps, ...(frameRate === undefined ? {} : { frameRate }) };
}
