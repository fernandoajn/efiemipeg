import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Environment } from "./config/environment";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Environment, true>);
  app.setGlobalPrefix("api");
  app.enableCors({ origin: config.get("WEB_ORIGIN", { infer: true }) });
  app.enableShutdownHooks();
  const port = config.get("API_PORT", { infer: true });
  const host = config.get("API_HOST", { infer: true });
  await app.listen(port, host);
  Logger.log(`API listening at http://${host}:${port}/api`, "Bootstrap");
}

void bootstrap().catch(() => {
  Logger.error(
    "API startup failed. Check environment configuration and port availability.",
    undefined,
    "Bootstrap",
  );
  process.exitCode = 1;
});
