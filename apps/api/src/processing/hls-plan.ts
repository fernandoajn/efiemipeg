import { join } from "node:path";

// Everything here is pure: the job turns an FFprobe report into FFmpeg arguments without touching disk or storage.
export const SEGMENT_SECONDS = 4;
const LADDER = [
  { shortSide: 360, videoKbps: 800 },
  { shortSide: 720, videoKbps: 2800 },
  { shortSide: 1080, videoKbps: 5000 },
];
const THUMBNAIL_LONG_SIDE = 640;

export interface Rendition { width: number; height: number; videoKbps: number }
export interface ProbedVideo {
  durationSeconds: number; width: number; height: number;
  videoCodec: string; audioCodec: string | null; frameRate: number | null;
}
interface ProbeStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string;
  tags?: { rotate?: string }; side_data_list?: { rotation?: number }[];
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function readProbe(report: { streams?: ProbeStream[]; format?: { duration?: string } }): ProbedVideo | null {
  const video = report.streams?.find(stream => stream.codec_type === "video" && stream.width && stream.height);
  const durationSeconds = Number(report.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  // Phones record portrait video as rotated landscape frames; FFmpeg auto-rotates, so plan for the displayed shape.
  const rotation = Math.abs(Number(video.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180;
  const [numerator, denominator] = (video.avg_frame_rate ?? "").split("/").map(Number);
  const audio = report.streams?.find(stream => stream.codec_type === "audio");
  return {
    durationSeconds,
    width: rotation === 90 ? video.height : video.width,
    height: rotation === 90 ? video.width : video.height,
    videoCodec: video.codec_name ?? "unknown",
    audioCodec: audio?.codec_name ?? null,
    frameRate: numerator > 0 && denominator > 0 ? numerator / denominator : null,
  };
}

// Rungs are defined by their short side so portrait and landscape sources get the same quality steps.
// Never upscale. A source well between two rungs (say 540p) also keeps its own resolution as the top rung,
// with a bitrate scaled from the rung below by pixel count.
export function planRenditions(width: number, height: number): Rendition[] {
  const shortSide = even(Math.min(width, height));
  const chosen = LADDER.filter(rung => rung.shortSide <= shortSide);
  const top = chosen.at(-1);
  if (!top || (shortSide >= top.shortSide * 1.2 && top !== LADDER.at(-1))) {
    const base = top ?? LADDER[0];
    chosen.push({ shortSide, videoKbps: Math.max(200, Math.round(base.videoKbps * (shortSide / base.shortSide) ** 2 / 100) * 100) });
  }
  return chosen.map(rung => ({ width: even(width * rung.shortSide / shortSide), height: even(height * rung.shortSide / shortSide), videoKbps: rung.videoKbps }));
}

export function thumbnailArguments(input: string, output: string, video: ProbedVideo, atSeconds: number): string[] {
  const scale = Math.min(1, THUMBNAIL_LONG_SIDE / Math.max(video.width, video.height));
  return ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", atSeconds.toFixed(3), "-i", input,
    "-frames:v", "1", "-vf", `scale=${even(video.width * scale)}:${even(video.height * scale)}`, "-q:v", "3", output];
}

export function hlsArguments(input: string, outputDir: string, renditions: Rendition[], hasAudio: boolean): string[] {
  const split = `[0:v:0]split=${renditions.length}${renditions.map((_, index) => `[s${index}]`).join("")}`;
  const scales = renditions.map((rendition, index) => `[s${index}]scale=${rendition.width}:${rendition.height},setsar=1,format=yuv420p[v${index}]`);
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", input,
    "-filter_complex", [split, ...scales].join(";"),
    ...renditions.flatMap((_, index) => ["-map", `[v${index}]`, ...(hasAudio ? ["-map", "0:a:0"] : [])]),
    // Keyframes exactly on segment boundaries let every rendition switch cleanly at any segment.
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main",
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, "-sc_threshold", "0",
    ...renditions.flatMap((rendition, index) => [
      `-b:v:${index}`, `${rendition.videoKbps}k`, `-maxrate:v:${index}`, `${Math.round(rendition.videoKbps * 1.07)}k`, `-bufsize:v:${index}`, `${rendition.videoKbps * 1.5}k`,
    ]),
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"] : []),
    "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod", "-hls_flags", "independent_segments",
    "-hls_segment_type", "mpegts", "-hls_segment_filename", join(outputDir, "v%v", "segment_%04d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", renditions.map((_, index) => hasAudio ? `v:${index},a:${index}` : `v:${index}`).join(" "),
    join(outputDir, "v%v", "index.m3u8"),
  ];
}

// The only object names the delivery endpoint will serve, which also rules out path traversal.
export const MEDIA_FILE = /^(thumbnail\.jpg|master\.m3u8|v\d{1,2}\/(index\.m3u8|segment_\d{4,6}\.ts))$/;
export function mediaContentType(path: string): string {
  return path.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : path.endsWith(".ts") ? "video/mp2t" : "image/jpeg";
}
