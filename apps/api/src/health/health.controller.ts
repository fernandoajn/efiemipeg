import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HealthService, Readiness } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  @Header("Cache-Control", "no-store")
  live() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  @Get(["", "ready"])
  @Header("Cache-Control", "no-store")
  async ready(): Promise<Readiness> {
    const result = await this.health.readiness();
    if (result.status === "error")
      throw new ServiceUnavailableException(result);
    return result;
  }
}
