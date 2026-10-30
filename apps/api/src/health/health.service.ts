import { Injectable } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { PrismaService } from "../infrastructure/prisma.service";
import { RedisService } from "../infrastructure/redis.service";
import { StorageService } from "../infrastructure/storage.service";

export interface DependencyHealth {
  status: "up" | "down";
  latencyMs: number;
}

export interface Readiness {
  status: "ok" | "error";
  timestamp: string;
  services: Record<"postgres" | "redis" | "minio", DependencyHealth>;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  async readiness(): Promise<Readiness> {
    const [postgres, redis, minio] = await Promise.all([
      this.check(() => this.prisma.ping()),
      this.check(() => this.redis.ping()),
      this.check(() => this.storage.ping()),
    ]);
    const services = { postgres, redis, minio };
    return {
      status: Object.values(services).every(
        (service) => service.status === "up",
      )
        ? "ok"
        : "error",
      timestamp: new Date().toISOString(),
      services,
    };
  }

  private async check(ping: () => Promise<void>): Promise<DependencyHealth> {
    const start = performance.now();
    try {
      await ping();
      return { status: "up", latencyMs: Math.round(performance.now() - start) };
    } catch {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }
}
