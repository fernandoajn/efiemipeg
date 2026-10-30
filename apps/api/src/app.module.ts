import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "./config/environment";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { InfrastructureModule } from "./infrastructure/infrastructure.module";
import { AuthModule } from "./auth/auth.module";
import { VideosModule } from "./videos/videos.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    InfrastructureModule,
    AuthModule,
    VideosModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
