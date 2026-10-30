import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Environment } from "../config/environment";

@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(config: ConfigService<Environment, true>) {
    this.bucket = config.get("S3_BUCKET", { infer: true });
    this.client = new S3Client({
      endpoint: config.get("S3_ENDPOINT", { infer: true }),
      region: config.get("S3_REGION", { infer: true }),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get("S3_ACCESS_KEY_ID", { infer: true }),
        secretAccessKey: config.get("S3_SECRET_ACCESS_KEY", { infer: true }),
      },
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 2500,
      }),
    });
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(3000),
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
