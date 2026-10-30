import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { Environment } from "../config/environment";
import { PrismaService } from "../infrastructure/prisma.service";
import { Video } from "../generated/prisma/client";
import { ProcessingQueue } from "../processing/processing-queue.service";
import { VideoStorageService } from "./video-storage.service";
import { matchesVideoContainer } from "./video.validation";

const LEASE_MS = 120000;
function publicVideo(video: Video) {
  return {
    id: video.id, title: video.title, originalName: video.originalName, mimeType: video.mimeType,
    sizeBytes: video.sizeBytes, status: video.status, error: video.error,
    uploadExpiresAt: video.uploadExpiresAt, createdAt: video.createdAt, uploadedAt: video.uploadedAt,
    processing: video.processingStatus && { status: video.processingStatus, progress: video.processingProgress, error: video.processingError },
    // Clients build media URLs from the version; a new version means new URLs, so cached segments never go stale.
    mediaVersion: video.processingStatus === "READY" ? video.mediaVersion : null,
    metadata: video.durationSeconds === null ? null : {
      durationSeconds: video.durationSeconds, width: video.width, height: video.height,
      videoCodec: video.videoCodec, audioCodec: video.audioCodec, renditions: video.renditions,
    },
  };
}
function storageStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService, private readonly storage: VideoStorageService,
    private readonly queue: ProcessingQueue, private readonly config: ConfigService<Environment, true>,
  ) {}

  options() {
    return { maxVideoBytes: this.config.get("MAX_VIDEO_BYTES", { infer: true }), formats: ["video/mp4", "video/quicktime", "video/webm"] };
  }

  async initialize(userId: string, input: { title: string; originalName: string; mimeType: string; sizeBytes: number }) {
    if (input.sizeBytes > this.options().maxVideoBytes) throw new BadRequestException("This file exceeds the upload size limit.");
    const id = randomUUID();
    const uploadKey = `uploads/${userId}/${id}/original`;
    const signed = await this.storage.presign({ key: uploadKey, ...input, userId, videoId: id });
    const video = await this.prisma.video.create({ data: {
      id, userId, ...input, uploadKey,
      uploadExpiresAt: new Date(Date.now() + this.config.get("UPLOAD_URL_TTL_SECONDS", { infer: true }) * 1000),
    } });
    return { video: publicVideo(video), upload: { ...signed, method: "PUT", expiresAt: video.uploadExpiresAt } };
  }

  async list(userId: string, cursor?: string) {
    if (cursor) await this.owned(userId, cursor);
    const rows = await this.prisma.video.findMany({
      where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 25,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return { videos: rows.slice(0, 24).map(publicVideo), nextCursor: rows.length > 24 ? rows[23].id : null };
  }

  async get(userId: string, id: string) { return { video: publicVideo(await this.owned(userId, id)) }; }

  async complete(userId: string, id: string) {
    const video = await this.owned(userId, id);
    if (video.status === "UPLOADED") return { video: publicVideo(video) };
    if (video.status === "FAILED" || video.status === "CANCELED") throw new ConflictException("This upload is closed. Choose the file again to start a new upload.");
    const token = randomUUID();
    const claimed = await this.prisma.video.updateMany({ where: {
      id, userId, OR: [{ status: "UPLOADING" }, { status: "VERIFYING", verificationStartedAt: { lt: new Date(Date.now() - LEASE_MS) } }],
    }, data: { status: "VERIFYING", verificationToken: token, verificationStartedAt: new Date(), error: null } });
    if (!claimed.count) throw new ConflictException("Verification is already running. Try again shortly.");
    const finalKey = `originals/${userId}/${id}/${token}`;
    let promoted = false;
    try {
      const object = await this.storage.head(video.uploadKey);
      if (object.ContentLength !== video.sizeBytes || object.ContentType !== video.mimeType ||
          object.Metadata?.["user-id"] !== userId || object.Metadata?.["video-id"] !== id || !object.ETag) {
        throw new BadRequestException("The uploaded object does not match the declared file. Please upload it again.");
      }
      if (!matchesVideoContainer(await this.storage.prefix(video.uploadKey, object.ETag), video.mimeType)) {
        throw new BadRequestException("The file is not a supported MP4, MOV, or WebM container.");
      }
      await this.storage.copy(video.uploadKey, finalKey, object.ETag);
      const stored = await this.storage.head(finalKey);
      if (stored.ContentLength !== video.sizeBytes || stored.ContentType !== video.mimeType || !stored.ETag) throw new Error("Copy verification failed");
      const saved = await this.prisma.video.updateMany({ where: { id, userId, status: "VERIFYING", verificationToken: token }, data: {
        status: "UPLOADED", objectKey: finalKey, etag: stored.ETag, uploadedAt: new Date(), error: null, verificationToken: null, verificationStartedAt: null,
        processingStatus: "QUEUED", processingProgress: 0, processingError: null,
      } });
      if (!saved.count) throw new ConflictException("Verification was retried. Refresh your library.");
      promoted = true;
      await this.queue.enqueue(id);
      await this.cleanup(video.uploadKey);
      return this.get(userId, id);
    } catch (error) {
      if (!promoted) {
        const invalid = error instanceof BadRequestException;
        const message = invalid ? error.message : storageStatus(error) === 404
          ? "The file has not arrived in storage yet. Finish the upload, then check again."
          : "Verification could not finish. Check the upload again shortly.";
        await this.prisma.video.updateMany({ where: { id, userId, status: "VERIFYING", verificationToken: token }, data: {
          status: invalid ? "FAILED" : "UPLOADING", error: message, verificationToken: null, verificationStartedAt: null,
        } });
        await this.cleanup(finalKey);
        if (invalid) { await this.cleanup(video.uploadKey); throw error; }
        if (storageStatus(error) === 404 || error instanceof ConflictException) throw new ConflictException(message);
        throw new ServiceUnavailableException(message);
      }
      throw error;
    }
  }

  async cancel(userId: string, id: string) {
    const video = await this.owned(userId, id);
    if (video.status === "CANCELED") return { video: publicVideo(video) };
    const changed = await this.prisma.video.updateMany({ where: { id, userId, status: { in: ["UPLOADING", "FAILED"] } }, data: { status: "CANCELED", error: null } });
    if (!changed.count) throw new ConflictException("An uploaded video or active verification cannot be canceled.");
    await this.cleanup(video.uploadKey);
    return this.get(userId, id);
  }

  async reprocess(userId: string, id: string) {
    const changed = await this.prisma.video.updateMany({
      where: { id, userId, status: "UPLOADED", processingStatus: "FAILED" },
      data: { processingStatus: "QUEUED", processingProgress: 0, processingError: null },
    });
    if (!changed.count) { await this.owned(userId, id); throw new ConflictException("Only a video whose processing failed can be retried."); }
    await this.queue.enqueue(id);
    return this.get(userId, id);
  }

  async media(userId: string, id: string, version: string) {
    const video = await this.owned(userId, id);
    if (video.processingStatus !== "READY" || video.mediaVersion !== version || !video.mediaPrefix) throw new NotFoundException("Video not found.");
    return video.mediaPrefix;
  }

  async playable(userId: string, id: string) {
    const video = await this.owned(userId, id);
    if (video.status !== "UPLOADED" || !video.objectKey || !video.etag || !video.uploadedAt) {
      throw new ConflictException("This video is not ready for playback.");
    }
    return { ...video, objectKey: video.objectKey, etag: video.etag, uploadedAt: video.uploadedAt };
  }

  private async owned(userId: string, id: string) {
    const video = await this.prisma.video.findFirst({ where: { id, userId } });
    if (!video) throw new NotFoundException("Video not found.");
    return video;
  }

  private async cleanup(key: string) {
    try { await this.storage.remove(key); }
    catch { Logger.warn("An upload object could not be cleaned up; it may require later cleanup.", "VideosService"); }
  }
}
