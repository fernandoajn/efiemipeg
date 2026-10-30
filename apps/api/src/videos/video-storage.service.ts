import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Environment } from "../config/environment";
import { StorageService } from "../infrastructure/storage.service";

@Injectable()
export class VideoStorageService {
  constructor(private readonly storage: StorageService, private readonly config: ConfigService<Environment, true>) {}

  async presign(input: { key: string; mimeType: string; sizeBytes: number; userId: string; videoId: string }) {
    const signer = new S3Client({
      endpoint: this.config.get("S3_PUBLIC_ENDPOINT", { infer: true }) ?? this.config.get("S3_ENDPOINT", { infer: true }),
      region: this.config.get("S3_REGION", { infer: true }), forcePathStyle: true,
      credentials: { accessKeyId: this.config.get("S3_ACCESS_KEY_ID", { infer: true }), secretAccessKey: this.config.get("S3_SECRET_ACCESS_KEY", { infer: true }) },
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    const headers = { "Content-Type": input.mimeType, "x-amz-meta-user-id": input.userId, "x-amz-meta-video-id": input.videoId };
    try {
      const url = await getSignedUrl(signer, new PutObjectCommand({
        Bucket: this.storage.bucket, Key: input.key, ContentType: input.mimeType, ContentLength: input.sizeBytes,
        Metadata: { "user-id": input.userId, "video-id": input.videoId },
      }), {
        expiresIn: this.config.get("UPLOAD_URL_TTL_SECONDS", { infer: true }),
        signableHeaders: new Set(["content-type", "content-length"]),
        unhoistableHeaders: new Set(["x-amz-meta-user-id", "x-amz-meta-video-id"]),
      });
      return { url, headers };
    } finally { signer.destroy(); }
  }

  head(key: string) {
    return this.storage.client.send(new HeadObjectCommand({ Bucket: this.storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) });
  }

  async prefix(key: string, etag: string) {
    const result = await this.storage.client.send(new GetObjectCommand({ Bucket: this.storage.bucket, Key: key, Range: "bytes=0-4095", IfMatch: etag }), { abortSignal: AbortSignal.timeout(5000) });
    return result.Body?.transformToByteArray() ?? new Uint8Array();
  }

  // The caller validated the range against the stored size; IfMatch guarantees bytes from the verified original.
  read(key: string, etag: string, range: { start: number; end: number } | undefined, signal: AbortSignal) {
    return this.storage.client.send(new GetObjectCommand({
      Bucket: this.storage.bucket, Key: key, IfMatch: etag, Range: range && `bytes=${range.start}-${range.end}`,
    }), { abortSignal: signal });
  }

  readObject(key: string, signal: AbortSignal) {
    return this.storage.client.send(new GetObjectCommand({ Bucket: this.storage.bucket, Key: key }), { abortSignal: signal });
  }

  async download(key: string, etag: string, path: string, signal: AbortSignal): Promise<void> {
    const object = await this.storage.client.send(new GetObjectCommand({ Bucket: this.storage.bucket, Key: key, IfMatch: etag }), { abortSignal: signal });
    if (!(object.Body instanceof Readable)) throw new Error("Storage returned no body");
    await pipeline(object.Body, createWriteStream(path), { signal });
  }

  async upload(key: string, path: string, contentType: string, signal: AbortSignal): Promise<void> {
    const { size } = await stat(path);
    await this.storage.client.send(new PutObjectCommand({
      Bucket: this.storage.bucket, Key: key, Body: createReadStream(path), ContentLength: size, ContentType: contentType,
    }), { abortSignal: signal });
  }

  async removePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const listed = await this.storage.client.send(new ListObjectsV2Command({ Bucket: this.storage.bucket, Prefix: prefix, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(10000) });
      if (listed.Contents?.length) {
        await this.storage.client.send(new DeleteObjectsCommand({
          Bucket: this.storage.bucket, Delete: { Objects: listed.Contents.map(({ Key }) => ({ Key })), Quiet: true },
        }), { abortSignal: AbortSignal.timeout(10000) });
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }

  async copy(source: string, target: string, etag: string) {
    return this.storage.client.send(new CopyObjectCommand({
      Bucket: this.storage.bucket, Key: target,
      CopySource: `${this.storage.bucket}/${source.split("/").map(encodeURIComponent).join("/")}`,
      CopySourceIfMatch: etag, MetadataDirective: "COPY",
    }), { abortSignal: AbortSignal.timeout(60000) });
  }

  async remove(key: string): Promise<void> {
    await this.storage.client.send(new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) });
  }
}
