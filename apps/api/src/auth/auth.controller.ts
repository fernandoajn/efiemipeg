import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { CookieOptions, Response } from "express";
import { Environment } from "../config/environment";
import { AuthService } from "./auth.service";
import { AuthRequest, AUTH_COOKIE } from "./auth.types";
import { AuthRateLimitGuard } from "./auth-rate-limit.guard";
import { Public } from "./public.decorator";
import { loginSchema, registerSchema, validateBody } from "./auth.validation";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post("register")
  @Header("Cache-Control", "no-store")
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.register(validateBody(registerSchema, body));
    response.cookie(AUTH_COOKIE, result.token, {
      ...this.cookieOptions(),
      expires: result.expiresAt,
    });
    return { user: result.user, expiresAt: result.expiresAt };
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post("login")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(validateBody(loginSchema, body));
    response.cookie(AUTH_COOKIE, result.token, {
      ...this.cookieOptions(),
      expires: result.expiresAt,
    });
    return { user: result.user, expiresAt: result.expiresAt };
  }

  @Get("me")
  @Header("Cache-Control", "no-store")
  me(@Req() request: AuthRequest) {
    return { user: request.user };
  }

  @Post("logout")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async logout(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(request.sessionId);
    response.clearCookie(AUTH_COOKIE, this.cookieOptions());
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get("NODE_ENV", { infer: true }) === "production",
      sameSite: "lax",
      path: "/api",
    };
  }
}
