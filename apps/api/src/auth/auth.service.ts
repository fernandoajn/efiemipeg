import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma.service";
import { Environment } from "../config/environment";
import { PasswordService } from "./password.service";
import { accountSelect, JWT_AUDIENCE, JWT_ISSUER } from "./auth.types";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async register(input: { name: string; email: string; password: string }) {
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: input.name, email: input.email, passwordHash },
          select: accountSelect,
        });
        const session = this.createToken(user.id);
        await tx.session.create({ data: session.record });
        return {
          user,
          token: session.token,
          expiresAt: session.record.expiresAt,
        };
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "An account with this email already exists.",
        );
      }
      throw error;
    }
  }

  async login(input: { email: string; password: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    if (
      !(await this.passwords.verify(user?.passwordHash, input.password)) ||
      !user
    ) {
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    const session = this.createToken(user.id);
    await this.prisma.$transaction([
      this.prisma.session.deleteMany({
        where: { userId: user.id, expiresAt: { lte: new Date() } },
      }),
      this.prisma.session.create({ data: session.record }),
    ]);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      },
      token: session.token,
      expiresAt: session.record.expiresAt,
    };
  }

  async authenticate(token: string) {
    let claims: { sub: string; jti: string; exp: number };
    try {
      claims = await this.jwt.verifyAsync(token, {
        algorithms: ["HS256"],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !uuid.test(claims.sub) ||
        !uuid.test(claims.jti) ||
        !Number.isFinite(claims.exp)
      )
        throw new Error();
    } catch {
      throw new UnauthorizedException("Please sign in to continue.");
    }
    const session = await this.prisma.session.findUnique({
      where: { id: claims.jti },
      include: { user: { select: accountSelect } },
    });
    if (
      !session ||
      session.userId !== claims.sub ||
      session.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException("Please sign in to continue.");
    }
    return { user: session.user, sessionId: session.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  private createToken(userId: string) {
    const id = randomUUID();
    const ttl = this.config.get("JWT_TTL_SECONDS", { infer: true });
    const token = this.jwt.sign(
      { sub: userId, jti: id },
      {
        algorithm: "HS256",
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: ttl,
      },
    );
    return {
      token,
      record: { id, userId, expiresAt: new Date(Date.now() + ttl * 1000) },
    };
  }
}
