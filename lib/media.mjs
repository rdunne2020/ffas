import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Deliberately exclude playlists and demuxers that load external resources.
export const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts,flv,aiff,asf'];
export const formats = {
  mp4: { extension: 'mp4', mime: 'video/mp4', video: true },
  webm: { extension: 'webm', mime: 'video/webm', video: true },
  mp3: { extension: 'mp3', mime: 'audio/mpeg', video: false },
  wav: { extension: 'wav', mime: 'audio/wav', video: false },
  flac: { extension: 'flac', mime: 'audio/flac', video: false },
  m4a: { extension: 'm4a', mime: 'audio/mp4', video: false },
};
export async function probe(path) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', ...inputOptions, '-show_format', '-show_streams', '-of', 'json', path], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const video = info.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = info.streams.find(s => s.codec_type === 'audio');
  const duration = Number(info.format.duration || video?.duration || audio?.duration);
  if ((!video && !audio) || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600) throw new Error('Choose a playable video or audio file under 24 hours long.');
  return { duration, hasVideo: !!video, hasAudio: !!audio, videoIndex: video?.index, audioIndex: audio?.index, width: video?.width, height: video?.height, videoCodec: video?.codec_name, audioCodec: audio?.codec_name };
}
export function validateEdit(body, media) {
  const format = body.preview ? (media.hasVideo ? 'mp4' : 'm4a') : body.format;
  if (!Object.hasOwn(formats, format)) throw new Error('Choose a supported output format.');
  if (formats[format].video && !media.hasVideo) throw new Error('This file has no video. Choose an audio format.');
  if (!formats[format].video && !media.hasAudio) throw new Error('This file has no audio to export.');
  const quality = body.quality ?? 'balanced';
  const resolution = body.preview ? '720' : (body.resolution ?? 'original');
  if (!['high', 'balanced', 'small'].includes(quality)) throw new Error('Invalid quality.');
  if (!['original', '1080', '720', '480'].includes(resolution)) throw new Error('Invalid resolution.');
  for (const key of ['flipH', 'flipV', 'mute', 'preview']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new Error(`Invalid ${key} setting.`);
  const clips = body.clips;
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 32) throw new Error('Select between 1 and 32 clips.');
  const normalized = clips.map(clip => {
    if (!clip || typeof clip.start !== 'number' || typeof clip.end !== 'number') throw new Error('Clip times must be numbers.');
    const { start, end } = clip;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > media.duration + 0.02 || end - start < 0.04) throw new Error('Each clip must be at least 0.04 seconds and stay within the source.');
    return { start, end: Math.min(end, media.duration) };
  });
  const duration = normalized.reduce((sum, c) => sum + c.end - c.start, 0);
  if (duration > 24 * 3600) throw new Error('The combined result must be under 24 hours.');
  return { format, quality, resolution, clips: normalized, duration, flipH: !!body.flipH, flipV: !!body.flipV, mute: formats[format].video && !!body.mute, preview: !!body.preview };
}
export function buildCommand(media, edit, input, output) {
  const video = formats[edit.format].video;
  const audio = media.hasAudio && !edit.mute;
  const count = edit.clips.length;
  const graph = [];
  const inputs = [];
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
    graph.push(`[joinedv]${filters.join(',')}[outv]`);
  }
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputOptions, '-i', input, '-filter_complex_threads', '2', '-filter_complex', graph.join(';')];
  if (video) args.push('-map', '[outv]');
  if (audio) args.push('-map', '[outa]');
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-threads', '2');
  const quality = { high: 18, balanced: 23, small: 30 }[edit.quality];
  if (edit.format === 'mp4') args.push('-c:v', 'libx264', '-preset', edit.preview ? 'ultrafast' : 'medium', '-crf', String(quality), '-movflags', '+faststart');
  if (edit.format === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', String(quality + 9), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4');
  if (audio) {
    const codec = { mp4: 'aac', webm: 'libopus', mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac', m4a: 'aac' }[edit.format];
    args.push('-c:a', codec);
    if (!['wav', 'flac'].includes(edit.format)) args.push('-b:a', { high: '256k', balanced: '192k', small: '128k' }[edit.quality]);
  }
  args.push('-progress', 'pipe:1', '-nostats', output);
  return args;
}
