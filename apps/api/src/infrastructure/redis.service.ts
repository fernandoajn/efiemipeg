import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { Environment } from "../config/environment";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<Environment, true>) {
    this.client = new Redis(config.get("REDIS_URL", { infer: true }), {
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2000),
    });
    // Readiness reports connection errors without logging credentials or flooding logs.
    this.client.on("error", () => undefined);
  }

  onModuleInit(): void {
    void this.client.connect().catch(() => undefined);
  }

  async ping(): Promise<void> {
    if ((await this.client.ping()) !== "PONG")
      throw new Error("Unexpected Redis response");
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
