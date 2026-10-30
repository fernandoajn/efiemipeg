import { Controller, Get, Logger, Param, ParseUUIDPipe, Req, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AuthRequest } from "../auth/auth.types";
import { parseByteRange, rangeStillValid } from "./byte-range";
import { VideoStorageService } from "./video-storage.service";
import { VideosService } from "./videos.service";

const STORAGE_UNAVAILABLE = "The video could not be read from storage. Try again shortly.";

@Controller("videos")
export class VideoStreamController {
  constructor(private readonly videos: VideosService, private readonly storage: VideoStorageService) {}

  // Express routes HEAD to GET handlers too; HEAD answers with headers only and never touches storage.
  @Get(":id/stream")
  async stream(@Req() request: AuthRequest, @Res() response: Response, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    const video = await this.videos.playable(request.user.id, id);
    const lastModified = video.uploadedAt.toUTCString();
    const range = rangeStillValid(request.get("If-Range"), video.etag, lastModified)
      ? parseByteRange(request.get("Range"), video.sizeBytes) : { type: "full" as const };
    const common = { "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

    if (range.type === "unsatisfiable") {
      response.status(416).set({ ...common, "Cache-Control": "no-store", "Content-Range": `bytes */${video.sizeBytes}` })
        .json({ statusCode: 416, message: "The requested byte range is outside this video." });
      return;
    }
    const partial = range.type === "partial" ? range : undefined;
    const length = partial ? partial.end - partial.start + 1 : video.sizeBytes;
    const headers = {
      ...common, "Cache-Control": "private, no-cache", "Content-Type": video.mimeType, "Content-Length": String(length),
      ETag: video.etag, "Last-Modified": lastModified,
      ...(partial ? { "Content-Range": `bytes ${partial.start}-${partial.end}/${video.sizeBytes}` } : {}),
    };
    if (request.method === "HEAD") { response.status(partial ? 206 : 200).set(headers).end(); return; }

    // Seeking makes the browser abandon in-flight requests; stop pulling from storage as soon as it does.
    const disconnect = new AbortController();
    response.once("close", () => disconnect.abort());
    let object;
    try { object = await this.storage.read(video.objectKey, video.etag, partial, disconnect.signal); }
    catch {
      if (disconnect.signal.aborted) return;
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
    }
    const body = object.Body;
    if (!(body instanceof Readable) || object.ContentLength !== length) {
      (body as Readable | undefined)?.destroy?.();
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
    }
    // Headers are committed only now, so failures above still produce ordinary JSON error responses.
    response.status(partial ? 206 : 200).set(headers);
    let storageFailed = false;
    body.once("error", () => { storageFailed = !response.destroyed; });
    try { await pipeline(body, response); }
    catch {
      // A client disconnect is normal; a storage failure truncates the response and the player re-requests the rest.
      if (storageFailed) Logger.warn("A video stream ended early while reading from storage.", "VideoStreamController");
    }
  }
}
