import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import { Environment } from "../config/environment";
import { PrismaService } from "../infrastructure/prisma.service";
import { MediaProcessor } from "./media-processor.service";
import { PROCESSING_QUEUE, ProcessingJob, ProcessingQueue } from "./processing-queue.service";

const SWEEP_MS = 60000;
const QUIET_MS = 5 * 60000;

@Injectable()
export class ProcessingWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker<ProcessingJob>;
  private sweeper?: NodeJS.Timeout;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly processor: MediaProcessor, private readonly queue: ProcessingQueue,
    private readonly prisma: PrismaService, private readonly config: ConfigService<Environment, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.processor.checkTools();
    this.worker = new Worker<ProcessingJob>(PROCESSING_QUEUE, job => this.run(job), {
      connection: { url: this.config.get("REDIS_URL", { infer: true }), maxRetriesPerRequest: null },
      concurrency: this.config.get("PROCESSING_CONCURRENCY", { infer: true }),
      // A crashed worker's job is picked up again after its lock expires.
      maxStalledCount: 3,
    });
    this.worker.on("error", () => undefined);
    this.worker.on("completed", job => Logger.log(`Video ${job.data.videoId} is ready for streaming.`, "ProcessingWorker"));
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    void this.sweep();
    Logger.log(`Processing worker listening on "${PROCESSING_QUEUE}" with concurrency ${this.worker.opts.concurrency}.`, "ProcessingWorker");
  }

  private run(job: Job<ProcessingJob>): Promise<void> {
    return this.processor.process({
      videoId: job.data.videoId, signal: this.shutdown.signal,
      final: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
  }

  // Re-queue videos the queue lost: an enqueue that failed while Redis was down, or uploads from before this phase.
  // Adding an existing job ID is a no-op, so the sweep is safe to run from every worker.
  private async sweep(): Promise<void> {
    try {
      const quiet = new Date(Date.now() - QUIET_MS);
      const stranded = await this.prisma.video.findMany({
        where: { status: "UPLOADED", OR: [
          { processingStatus: "QUEUED", updatedAt: { lt: new Date(Date.now() - SWEEP_MS) } },
          { processingStatus: "PROCESSING", processingHeartbeatAt: { lt: quiet } },
        ] },
        select: { id: true }, take: 100,
      });
      for (const { id } of stranded) await this.queue.enqueue(id);
    } catch {
      Logger.warn("The processing sweep could not run; it will try again.", "ProcessingWorker");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.sweeper);
    // Stop FFmpeg now rather than finishing a long encode; the job's lock lapses and it runs again on restart.
    this.shutdown.abort(new Error("Worker shutting down"));
    await this.worker?.close(true).catch(() => undefined);
  }
}
