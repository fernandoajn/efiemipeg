import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { ProcessingQueueModule } from "../processing/processing-queue.module";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";
import { VideoStorageService } from "./video-storage.service";
import { VideoStreamController } from "./video-stream.controller";

@Module({ imports: [InfrastructureModule, ProcessingQueueModule], controllers: [VideosController, VideoStreamController], providers: [VideosService, VideoStorageService] })
export class VideosModule {}
