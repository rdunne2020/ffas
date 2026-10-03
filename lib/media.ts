import { resolveEncoding } from '../shared/encoding.js';
import type { MediaMetadata, Edit } from '../shared/model.js';
import { isRecord, isClip, isOutputFormat, isQuality, isResolution } from '../shared/model.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Deliberately exclude playlists and demuxers that load external resources.
export const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts,flv,aiff,asf'];
export const formats = {
  mkv: { extension: 'mkv', mime: 'video/x-matroska', video: true },
  mp4: { extension: 'mp4', mime: 'video/mp4', video: true },
  webm: { extension: 'webm', mime: 'video/webm', video: true },
  mp3: { extension: 'mp3', mime: 'audio/mpeg', video: false },
  wav: { extension: 'wav', mime: 'audio/wav', video: false },
  flac: { extension: 'flac', mime: 'audio/flac', video: false },
  m4a: { extension: 'm4a', mime: 'audio/mp4', video: false },
};
export async function probe(path: string): Promise<MediaMetadata> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', ...inputOptions, '-show_format', '-show_streams', '-of', 'json', path], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const info: unknown = JSON.parse(stdout);
  if (!isRecord(info) || !Array.isArray(info.streams) || !isRecord(info.format)) throw new Error('Invalid FFprobe response.');
  const streams = info.streams.filter(isRecord);
  const video = streams.find(s => s.codec_type === 'video' && !(isRecord(s.disposition) && s.disposition.attached_pic));
  const audio = streams.find(s => s.codec_type === 'audio');
  const duration = Number(info.format.duration || video?.duration || audio?.duration);
  if ((!video && !audio) || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600) throw new Error('Choose a playable video or audio file under 24 hours long.');
  const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  if ((video && number(video.index) === undefined) || (audio && number(audio.index) === undefined)) throw new Error('Invalid stream index.');
  return { duration, hasVideo: !!video, hasAudio: !!audio, videoIndex: number(video?.index), audioIndex: number(audio?.index), width: number(video?.width), height: number(video?.height), videoCodec: text(video?.codec_name), audioCodec: text(audio?.codec_name) };
}
export function validateEdit(body: unknown, media: MediaMetadata): Edit {
  if (!isRecord(body)) throw new Error('Invalid edit request.');
  const format = body.preview ? (media.hasVideo ? 'mp4' : 'm4a') : body.format;
  if (!isOutputFormat(format)) throw new Error('Choose a supported output format.');
  if (formats[format].video && !media.hasVideo) throw new Error('This file has no video. Choose an audio format.');
  if (!formats[format].video && !media.hasAudio) throw new Error('This file has no audio to export.');
  const quality = body.quality ?? 'balanced';
  const resolution = body.preview ? '720' : (body.resolution ?? 'original');
  if (!isQuality(quality)) throw new Error('Invalid quality.');
  if (!isResolution(resolution)) throw new Error('Invalid resolution.');
  for (const key of ['flipH', 'flipV', 'mute', 'preview']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new Error(`Invalid ${key} setting.`);
  const clips = body.clips;
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 32) throw new Error('Select between 1 and 32 clips.');
  const normalized = clips.map(clip => {
    if (!isClip(clip)) throw new Error('Clip times must be numbers.');
    const { start, end } = clip;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > media.duration + 0.02 || end - start < 0.04) throw new Error('Each clip must be at least 0.04 seconds and stay within the source.');
    return { start, end: Math.min(end, media.duration) };
  });
  const duration = normalized.reduce((sum, c) => sum + c.end - c.start, 0);
  if (duration > 24 * 3600) throw new Error('The combined result must be under 24 hours.');
  return { ...resolveEncoding(body, format, quality, !!body.preview), format, quality, resolution, clips: normalized, duration, flipH: !!body.flipH, flipV: !!body.flipV, mute: formats[format].video && !!body.mute, preview: !!body.preview };
}
export function buildCommand(media: MediaMetadata, edit: Edit, input: string, output: string): string[] {
  const encoding = resolveEncoding({ ...edit }, edit.format, edit.quality, edit.preview);
  const video = formats[edit.format].video;
  const audio = media.hasAudio && !edit.mute;
  const count = edit.clips.length;
  const graph: string[] = [];
  const inputs: string[] = [];
  if (video) graph.push(`[0:${media.videoIndex}]setpts=PTS-STARTPTS,split=${count}${edit.clips.map((_, i) => `[vs${i}]`).join('')}`);
  if (audio) graph.push(`[0:${media.audioIndex}]asetpts=PTS-STARTPTS,asplit=${count}${edit.clips.map((_, i) => `[as${i}]`).join('')}`);
  edit.clips.forEach((clip, i) => {
    const range = `start=${clip.start}:end=${clip.end}`;
    if (video) {
      graph.push(`[vs${i}]trim=${range},setpts=PTS-STARTPTS[v${i}]`);
      inputs.push(`[v${i}]`);
    }
    if (audio) {
      graph.push(`[as${i}]atrim=${range},asetpts=PTS-STARTPTS,apad,atrim=duration=${clip.end - clip.start}[a${i}]`);
      inputs.push(`[a${i}]`);
    }
  });
  graph.push(`${inputs.join('')}concat=n=${count}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}${video ? '[joinedv]' : ''}${audio ? '[outa]' : ''}`);
  if (video) {
    const filters = [];
    if (edit.flipH) filters.push('hflip');
    if (edit.flipV) filters.push('vflip');
    // Preserve display aspect ratio, avoid upscaling, and produce even dimensions.
    const height = edit.resolution === 'original' ? 'ih' : `min(ih,${edit.resolution})`;
    filters.push(`scale=w='trunc((${height})*dar/2)*2':h='trunc((${height})/2)*2'`, 'setsar=1', 'format=yuv420p');
    if (encoding.frameRate !== undefined) filters.push(`fps=${encoding.frameRate}`);
    graph.push(`[joinedv]${filters.join(',')}[outv]`);
  }
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputOptions, '-i', input, '-filter_complex_threads', '2', '-filter_complex', graph.join(';')];
  if (video) args.push('-map', '[outv]');
  if (audio) args.push('-map', '[outa]');
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-threads', '2');
  if (video) {
    const codec = encoding.videoCodec;
    if (!codec) throw new Error('Choose a video codec.');
    args.push('-c:v', codec);
    if (encoding.rateControl === 'bitrate') args.push('-b:v', `${encoding.videoBitrateKbps}k`);
    else {
      args.push('-crf', String(encoding.crf));
      if (codec === 'libvpx-vp9') args.push('-b:v', '0');
    }
    if (codec === 'libvpx-vp9') args.push('-deadline', 'good', '-cpu-used', String(encoding.cpuUsed));
    else args.push('-preset', encoding.preset ?? 'medium');
    if (codec === 'libx265') {
      args.push('-x265-params', 'pools=2:frame-threads=2:log-level=error');
      if (edit.format === 'mp4') args.push('-tag:v', 'hvc1');
    }
    if (edit.format === 'mp4') args.push('-movflags', '+faststart');
  }
  if (audio) {
    const codec = encoding.audioCodec;
    if (!codec) throw new Error('Choose an audio codec.');
    args.push('-c:a', codec);
    if (!['pcm_s16le', 'flac'].includes(codec)) args.push('-b:a', `${encoding.audioBitrateKbps}k`);
  }
  args.push('-progress', 'pipe:1', '-nostats', output);
  return args;
}
