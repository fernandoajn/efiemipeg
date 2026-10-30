import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./processing/worker.module";

// A separate process from the API: transcoding is CPU-heavy and must never slow down HTTP requests.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    `Worker startup failed. ${error instanceof Error && /FFmpeg|ffmpeg|ffprobe/.test(error.message) ? error.message : "Check environment configuration, Redis, and the FFmpeg installation."}`,
    undefined,
    "Bootstrap",
  );
  process.exitCode = 1;
});
