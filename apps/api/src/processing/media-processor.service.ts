import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { UnrecoverableError } from "bullmq";
import { Environment } from "../config/environment";
import { PrismaService } from "../infrastructure/prisma.service";
import { VideoStorageService } from "../videos/video-storage.service";
import { runTool } from "./ffmpeg";
import { hlsArguments, mediaContentType, planRenditions, ProbedVideo, readProbe, thumbnailArguments } from "./hls-plan";

const HEARTBEAT_MS = 2000;
const UPLOAD_CONCURRENCY = 6;

export interface Attempt { videoId: string; final: boolean; signal: AbortSignal }

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
}

@Injectable()
export class MediaProcessor {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;

  constructor(private readonly prisma: PrismaService, private readonly storage: VideoStorageService, config: ConfigService<Environment, true>) {
    this.ffmpeg = config.get("FFMPEG_PATH", { infer: true });
    this.ffprobe = config.get("FFPROBE_PATH", { infer: true });
  }

  async checkTools(): Promise<void> {
    const signal = AbortSignal.timeout(10000);
    await runTool(this.ffmpeg, ["-hide_banner", "-version"], { signal });
    await runTool(this.ffprobe, ["-hide_banner", "-version"], { signal });
  }

  async process({ videoId, final, signal }: Attempt): Promise<void> {
    // Claim the video with a fresh token. A stale attempt that wakes up later can no longer write its results.
    const token = randomUUID();
    const claimed = await this.prisma.video.updateManyAndReturn({
      where: { id: videoId, status: "UPLOADED", processingStatus: { in: ["QUEUED", "PROCESSING"] } },
      data: { processingStatus: "PROCESSING", processingToken: token, processingHeartbeatAt: new Date(), processingProgress: 0, processingError: null },
    });
    const video = claimed[0];
    if (!video?.objectKey || !video.etag) return;
    const prefix = `media/${video.userId}/${video.id}/${token}`;
    const workdir = await mkdtemp(join(tmpdir(), "efiemipeg-"));
    const owns = { id: video.id, processingToken: token };
    let lastBeat = 0;
    const progress = async (percent: number) => {
      if (Date.now() - lastBeat < HEARTBEAT_MS) return;
      lastBeat = Date.now();
      await this.prisma.video.updateMany({ where: owns, data: { processingProgress: Math.min(99, Math.max(0, Math.floor(percent))), processingHeartbeatAt: new Date() } });
    };
    let uploaded = false;
    try {
      const source = join(workdir, "source");
      const output = join(workdir, "output");
      await mkdir(output);
      await this.storage.download(video.objectKey, video.etag, source, signal);
      await progress(2);

      const probed = readProbe(JSON.parse(await runTool(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", source], { signal })));
      if (!probed) throw new UnrecoverableError("This file does not contain a playable video stream.");
      await this.thumbnail(source, join(output, "thumbnail.jpg"), probed, signal);
      const renditions = planRenditions(probed.width, probed.height);
      await runTool(this.ffmpeg, hlsArguments(source, output, renditions, probed.audioCodec !== null), {
        signal, onProgress: seconds => void progress(5 + seconds / probed.durationSeconds * 85).catch(() => undefined),
      });
      await progress(90);

      uploaded = true;
      const files = await filesUnder(output);
      for (let index = 0; index < files.length; index += UPLOAD_CONCURRENCY) {
        await Promise.all(files.slice(index, index + UPLOAD_CONCURRENCY).map(file => {
          const path = relative(output, file).split("\\").join("/");
          return this.storage.upload(`${prefix}/${path}`, file, mediaContentType(path), signal);
        }));
      }
      // Switch playback to the new version in one write, guarded by the token so only the current attempt can.
      const saved = await this.prisma.video.updateMany({ where: owns, data: {
        processingStatus: "READY", processingProgress: 100, processingToken: null, processingError: null, processingHeartbeatAt: new Date(),
        mediaVersion: token, mediaPrefix: prefix, processedAt: new Date(),
        durationSeconds: probed.durationSeconds, width: probed.width, height: probed.height, videoCodec: probed.videoCodec, audioCodec: probed.audioCodec,
        renditions: renditions.map(rendition => ({ ...rendition })),
      } });
      if (!saved.count) throw new Error("A newer processing attempt replaced this one.");
      if (video.mediaPrefix) await this.storage.removePrefix(`${video.mediaPrefix}/`).catch(() => undefined);
    } catch (error) {
      if (uploaded) await this.storage.removePrefix(`${prefix}/`).catch(() => Logger.warn("Partial HLS output could not be removed.", "MediaProcessor"));
      if (!signal.aborted) {
        const permanent = final || error instanceof UnrecoverableError;
        Logger.warn(`Processing ${video.id} failed${permanent ? "" : "; it will be retried"}: ${error instanceof Error ? error.message : error}`, "MediaProcessor");
        await this.prisma.video.updateMany({ where: owns, data: permanent
          ? { processingStatus: "FAILED", processingToken: null, processingError: error instanceof UnrecoverableError ? error.message : "The video could not be converted for streaming." }
          : { processingStatus: "QUEUED", processingToken: null, processingError: "The first attempt failed. Retrying shortly." },
        });
      }
      throw error;
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private async thumbnail(source: string, output: string, probed: ProbedVideo, signal: AbortSignal): Promise<void> {
    try { await runTool(this.ffmpeg, thumbnailArguments(source, output, probed, Math.min(probed.durationSeconds * 0.1, 10)), { signal }); }
    // Very short or oddly encoded clips may have no frame at the chosen time; the first frame always exists.
    catch { await runTool(this.ffmpeg, thumbnailArguments(source, output, probed, 0), { signal }); }
  }
}
