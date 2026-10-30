import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { Environment } from "../config/environment";

export const PROCESSING_QUEUE = "video-processing";
export interface ProcessingJob { videoId: string }

// PostgreSQL is the source of truth for what needs processing; the queue only delivers work.
// A lost enqueue is repaired by the worker's sweep, so callers may treat enqueue as best effort.
@Injectable()
export class ProcessingQueue implements OnModuleDestroy {
  private readonly queue: Queue<ProcessingJob>;

  constructor(config: ConfigService<Environment, true>) {
    this.queue = new Queue<ProcessingJob>(PROCESSING_QUEUE, {
      connection: { url: config.get("REDIS_URL", { infer: true }), connectTimeout: 2000, enableOfflineQueue: false, maxRetriesPerRequest: 1 },
      defaultJobOptions: {
        attempts: 3, backoff: { type: "exponential", delay: 15000 },
        removeOnComplete: true, removeOnFail: true,
      },
    });
    this.queue.on("error", () => undefined);
  }

  // The video ID is the job ID, so a video can have at most one waiting or active job; repeated adds are no-ops.
  async enqueue(videoId: string): Promise<boolean> {
    try {
      await this.queue.add("transcode", { videoId }, { jobId: videoId });
      return true;
    } catch {
      Logger.warn("A processing job could not be queued; the worker sweep will retry it.", "ProcessingQueue");
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }
}
