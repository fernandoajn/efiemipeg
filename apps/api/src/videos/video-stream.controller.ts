import { Controller, Get, Logger, NotFoundException, Param, ParseUUIDPipe, Req, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AuthRequest } from "../auth/auth.types";
import { MEDIA_FILE, mediaContentType } from "../processing/hls-plan";
import { parseByteRange, rangeStillValid } from "./byte-range";
import { VideoStorageService } from "./video-storage.service";
import { VideosService } from "./videos.service";

const STORAGE_UNAVAILABLE = "The video could not be read from storage. Try again shortly.";
const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

// Seeking makes the browser abandon in-flight requests; stop pulling from storage as soon as it does.
function disconnectSignal(response: Response): AbortSignal {
  const disconnect = new AbortController();
  response.once("close", () => disconnect.abort());
  return disconnect.signal;
}

async function sendBody(body: Readable, response: Response): Promise<void> {
  let storageFailed = false;
  body.once("error", () => { storageFailed = !response.destroyed; });
  try { await pipeline(body, response); }
  catch {
    // A client disconnect is normal; a storage failure truncates the response and the player re-requests the rest.
    if (storageFailed) Logger.warn("A video response ended early while reading from storage.", "VideoStreamController");
  }
}

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
    const common = { "Accept-Ranges": "bytes", ...SECURITY_HEADERS };

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

    const signal = disconnectSignal(response);
    let object;
    try { object = await this.storage.read(video.objectKey, video.etag, partial, signal); }
    catch {
      if (signal.aborted) return;
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
    }
    const body = object.Body;
    if (!(body instanceof Readable) || object.ContentLength !== length) {
      (body as Readable | undefined)?.destroy?.();
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
    }
    // Headers are committed only now, so failures above still produce ordinary JSON error responses.
    response.status(partial ? 206 : 200).set(headers);
    await sendBody(body, response);
  }

  // HLS playlists, segments, and the thumbnail. Relative URIs inside the playlists resolve to these same routes,
  // so every request carries the session cookie and passes the ownership check. The version in the path makes
  // each URL immutable: reprocessing produces a new version rather than changing bytes behind an old URL.
  @Get(":id/media/:version/:file")
  media(@Req() request: AuthRequest, @Res() response: Response, @Param("id", ParseUUIDPipe) id: string,
    @Param("version", ParseUUIDPipe) version: string, @Param("file") file: string): Promise<void> {
    return this.sendMedia(request, response, id, version, file);
  }

  @Get(":id/media/:version/:variant/:file")
  variant(@Req() request: AuthRequest, @Res() response: Response, @Param("id", ParseUUIDPipe) id: string,
    @Param("version", ParseUUIDPipe) version: string, @Param("variant") variant: string, @Param("file") file: string): Promise<void> {
    return this.sendMedia(request, response, id, version, `${variant}/${file}`);
  }

  private async sendMedia(request: AuthRequest, response: Response, id: string, version: string, path: string): Promise<void> {
    if (!MEDIA_FILE.test(path)) throw new NotFoundException("Video not found.");
    const prefix = await this.videos.media(request.user.id, id, version);
    const signal = disconnectSignal(response);
    let object;
    try { object = await this.storage.readObject(`${prefix}/${path}`, signal); }
    catch (error) {
      if (signal.aborted) return;
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) throw new NotFoundException("Video not found.");
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
    }
    if (!(object.Body instanceof Readable)) throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
    response.status(200).set({
      ...SECURITY_HEADERS, "Content-Type": mediaContentType(path), "Cache-Control": "private, max-age=31536000, immutable",
      ...(object.ContentLength !== undefined ? { "Content-Length": String(object.ContentLength) } : {}),
      ...(object.ETag ? { ETag: object.ETag } : {}),
    });
    if (request.method === "HEAD") { object.Body.destroy(); response.end(); return; }
    await sendBody(object.Body, response);
  }
}
