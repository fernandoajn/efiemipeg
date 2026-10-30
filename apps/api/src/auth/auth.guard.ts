import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { AuthRequest, AUTH_COOKIE } from "./auth.types";
import { IS_PUBLIC } from "./public.decorator";
import { Environment } from "../config/environment";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    // A custom header forces CORS preflight; validate Origin as defense in depth.
    // Also protects public sign-in endpoints against login CSRF.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (
        request.get("X-Requested-With") !== "efiemipeg" ||
        (request.get("Origin") &&
          request.get("Origin") !==
            this.config.get("WEB_ORIGIN", { infer: true }))
      ) {
        throw new ForbiddenException("Request origin is not allowed.");
      }
    }
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const token: unknown = request.cookies?.[AUTH_COOKIE];
    if (typeof token !== "string" || token.length > 4096)
      throw new UnauthorizedException("Please sign in to continue.");
    Object.assign(request, await this.auth.authenticate(token));
    return true;
  }
}
