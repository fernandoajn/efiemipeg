import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { RedisService } from "../infrastructure/redis.service";

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = `auth:rate:${createHash("sha256")
      .update(request.ip ?? "unknown")
      .digest("hex")}`;
    let attempts: number;
    try {
      attempts = Number(
        await this.redis.client.eval(
          "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
          1,
          key,
        ),
      );
    } catch {
      throw new ServiceUnavailableException(
        "Sign-in is temporarily unavailable. Please try again shortly.",
      );
    }
    if (attempts > 10) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader("Retry-After", "60");
      throw new HttpException(
        "Too many attempts. Please wait a minute and try again.",
        429,
      );
    }
    return true;
  }
}
