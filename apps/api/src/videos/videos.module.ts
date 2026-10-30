import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";
import { VideoStorageService } from "./video-storage.service";

@Module({ imports: [InfrastructureModule], controllers: [VideosController], providers: [VideosService, VideoStorageService] })
export class VideosModule {}
