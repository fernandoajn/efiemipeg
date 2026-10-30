import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "../config/environment";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { VideoStorageService } from "../videos/video-storage.service";
import { MediaProcessor } from "./media-processor.service";
import { ProcessingQueueModule } from "./processing-queue.module";
import { ProcessingWorker } from "./processing.worker";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }), InfrastructureModule, ProcessingQueueModule],
  providers: [MediaProcessor, ProcessingWorker, VideoStorageService],
})
export class WorkerModule {}
