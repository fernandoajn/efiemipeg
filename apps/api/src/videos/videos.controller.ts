import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthRequest } from "../auth/auth.types";
import { validateBody } from "../auth/auth.validation";
import { initializeSchema } from "./video.validation";
import { VideosService } from "./videos.service";

@Controller("videos")
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Get("upload-options")
  @Header("Cache-Control", "no-store")
  options() { return this.videos.options(); }

  @Post("uploads")
  @Header("Cache-Control", "no-store")
  initialize(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.videos.initialize(request.user.id, validateBody(initializeSchema, body));
  }

  @Get()
  @Header("Cache-Control", "no-store")
  list(@Req() request: AuthRequest, @Query("cursor") cursor?: string) {
    if (cursor !== undefined) validateBody(z.uuid(), cursor);
    return this.videos.list(request.user.id, cursor);
  }

  @Get(":id")
  @Header("Cache-Control", "no-store")
  get(@Req() request: AuthRequest, @Param("id", ParseUUIDPipe) id: string) { return this.videos.get(request.user.id, id); }

  @Post(":id/complete")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  complete(@Req() request: AuthRequest, @Param("id", ParseUUIDPipe) id: string) { return this.videos.complete(request.user.id, id); }

  @Post(":id/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  cancel(@Req() request: AuthRequest, @Param("id", ParseUUIDPipe) id: string) { return this.videos.cancel(request.user.id, id); }
}
