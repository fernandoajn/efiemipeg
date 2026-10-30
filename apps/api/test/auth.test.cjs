require("reflect-metadata");
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Test } = require("@nestjs/testing");
const { ConfigModule, ConfigService } = require("@nestjs/config");
const { Controller, Get } = require("@nestjs/common");
const { JwtService } = require("@nestjs/jwt");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const argon2 = require("argon2");
const { AuthModule } = require("../../../dist/apps/api/auth/auth.module");
const {
  InfrastructureModule,
} = require("../../../dist/apps/api/infrastructure/infrastructure.module");
const {
  AUTH_COOKIE,
  JWT_ISSUER,
  JWT_AUDIENCE,
} = require("../../../dist/apps/api/auth/auth.types");
const {
  PrismaService,
} = require("../../../dist/apps/api/infrastructure/prisma.service");
const {
  RedisService,
} = require("../../../dist/apps/api/infrastructure/redis.service");
const {
  StorageService,
} = require("../../../dist/apps/api/infrastructure/storage.service");
const {
  HealthController,
} = require("../../../dist/apps/api/health/health.controller");
const {
  HealthService,
} = require("../../../dist/apps/api/health/health.service");

class PrivateController {
  get() {
    return { protected: true };
  }
}
Controller("private")(PrivateController);
Get()(
  PrivateController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(PrivateController.prototype, "get"),
);

describe("Authentication HTTP contract", () => {
  let app;
  let attempts = 1;
  let redisOffline = false;
  const users = new Map();
  const sessions = new Map();
  const secret = "a".repeat(64);
  const password = "my private film collection";
  const origin = "http://localhost:4200";
  const select = (user, selection) =>
    user && selection
      ? Object.fromEntries(
          Object.keys(selection).map((key) => [key, user[key]]),
        )
      : user;
  const prisma = {
    ping: async () => {},
    user: {
      create: async ({ data, select: selection }) => {
        if ([...users.values()].some((user) => user.email === data.email))
          throw { code: "P2002" };
        const user = {
          ...data,
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.set(user.id, user);
        return select(user, selection);
      },
      findUnique: async ({ where }) =>
        [...users.values()].find((user) => user.email === where.email) ?? null,
    },
    session: {
      create: async ({ data }) => {
        sessions.set(data.id, data);
        return data;
      },
      findUnique: async ({ where }) => {
        const session = sessions.get(where.id);
        const user = session && users.get(session.userId);
        return user
          ? {
              ...session,
              user: select(user, {
                id: true,
                email: true,
                name: true,
                createdAt: true,
              }),
            }
          : null;
      },
      deleteMany: async ({ where }) => {
        for (const [id, session] of sessions) {
          if (
            (where.id && where.id === id) ||
            (where.userId === session.userId &&
              session.expiresAt <= where.expiresAt.lte)
          )
            sessions.delete(id);
        }
        return { count: 1 };
      },
    },
    $transaction: async (work) =>
      typeof work === "function" ? work(prisma) : Promise.all(work),
  };
  const redis = {
    ping: async () => {},
    client: {
      eval: async () => {
        if (redisOffline) throw new Error("Offline");
        return attempts;
      },
    },
  };
  const cookie = (response) => response.headers["set-cookie"][0].split(";")[0];
  const post = (path) =>
    request(app.getHttpServer())
      .post(`/api/auth/${path}`)
      .set("X-Requested-With", "efiemipeg")
      .set("Origin", origin);
  const register = (email = "alice@example.com") =>
    post("register").send({ name: "Alice", email, password }).expect(201);
  const signToken = (record, overrides = {}, options = {}) =>
    new JwtService({ secret }).sign(
      { sub: record.userId, jti: record.id, ...overrides },
      {
        algorithm: "HS256",
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: 3600,
        ...options,
      },
    );

  before(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: secret,
              JWT_TTL_SECONDS: 3600,
              NODE_ENV: "test",
              WEB_ORIGIN: origin,
            }),
          ],
        }),
        AuthModule,
        InfrastructureModule,
      ],
      controllers: [HealthController, PrivateController],
      providers: [HealthService],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(StorageService)
      .useValue({ ping: async () => {} })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(cookieParser());
    await app.init();
  });
  beforeEach(() => {
    users.clear();
    sessions.clear();
    attempts = 1;
    redisOffline = false;
    app.get(ConfigService).set("NODE_ENV", "test");
  });
  after(async () => {
    await app?.close();
  });

  it("registers a normalized unique account, hashes the password, and issues an HttpOnly JWT cookie", async () => {
    const response = await register(" Alice@EXAMPLE.com ");
    assert.deepEqual(Object.keys(response.body.user).sort(), [
      "createdAt",
      "email",
      "id",
      "name",
    ]);
    assert.equal(response.body.user.email, "alice@example.com");
    assert.equal(response.body.token, undefined);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["set-cookie"][0], /HttpOnly/);
    assert.match(response.headers["set-cookie"][0], /SameSite=Lax/);
    assert.match(response.headers["set-cookie"][0], /Path=\/api/);
    const stored = [...users.values()][0];
    assert.match(stored.passwordHash, /^\$argon2id\$/);
    assert.ok(await argon2.verify(stored.passwordHash, password));
    assert.ok(!response.text.includes(stored.passwordHash));
    const me = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(response))
      .expect(200);
    assert.equal(me.body.user.id, stored.id);
  });

  it("rejects duplicate emails regardless of case", async () => {
    await register();
    await post("register")
      .send({ name: "Other", email: "ALICE@example.com", password })
      .expect(409);
    assert.equal(users.size, 1);
  });

  it("validates input, caps password size, and rejects injected ownership fields", async () => {
    for (const data of [
      { name: "Alice", email: "invalid", password },
      { name: "Alice", email: "alice@example.com", password: "short" },
      { name: "Alice", email: "alice@example.com", password: "a".repeat(129) },
      { name: " ", email: "alice@example.com", password },
      { name: "Alice", email: "alice@example.com", password, id: randomUUID() },
    ])
      await post("register").send(data).expect(400);
    assert.equal(users.size, 0);
  });

  it("uses different salts for identical passwords", async () => {
    await register();
    await register("bob@example.com");
    const hashes = [...users.values()].map((user) => user.passwordHash);
    assert.notEqual(hashes[0], hashes[1]);
  });

  it("logs in with normalized email and rejects wrong passwords or unknown accounts identically", async () => {
    await register();
    const good = await post("login")
      .send({ email: "ALICE@example.com", password })
      .expect(200);
    await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(good))
      .expect(200);
    const wrong = await post("login")
      .send({ email: "alice@example.com", password: "wrong password" })
      .expect(401);
    const unknown = await post("login")
      .send({ email: "unknown@example.com", password })
      .expect(401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it("protects all undecorated routes by default and leaves health checks public", async () => {
    await request(app.getHttpServer()).get("/api/auth/me").expect(401);
    await request(app.getHttpServer()).get("/api/private").expect(401);
    await request(app.getHttpServer()).get("/api/health/live").expect(200);
    await request(app.getHttpServer()).get("/api/health/ready").expect(200);
    const response = await register();
    await request(app.getHttpServer())
      .get("/api/private")
      .set("Cookie", cookie(response))
      .expect(200);
  });

  it("takes identity from the verified session, never query parameters", async () => {
    const alice = await register();
    const bob = await register("bob@example.com");
    const response = await request(app.getHttpServer())
      .get(`/api/auth/me?userId=${bob.body.user.id}`)
      .set("Cookie", cookie(alice))
      .expect(200);
    assert.equal(response.body.user.id, alice.body.user.id);
    const second = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(bob))
      .expect(200);
    assert.equal(second.body.user.id, bob.body.user.id);
  });

  it("rejects invalid, expired, wrong-audience, wrong-algorithm, and unknown-session tokens", async () => {
    await register();
    const record = [...sessions.values()][0];
    const invalid = [
      "malformed.token",
      signToken(record, {}, { expiresIn: -1 }),
      signToken(record, {}, { audience: "another-service" }),
      signToken(record, {}, { issuer: "another-issuer" }),
      signToken(record, {}, { algorithm: "HS384" }),
      signToken(record, { jti: randomUUID() }),
      signToken(record, { sub: randomUUID() }),
      signToken(record, {}, { secret: "b".repeat(64) }),
    ];
    for (const token of invalid)
      await request(app.getHttpServer())
        .get("/api/auth/me")
        .set("Cookie", `${AUTH_COOKIE}=${token}`)
        .expect(401);
  });

  it("rejects expired database sessions and deleted users even with a valid JWT", async () => {
    const response = await register();
    const session = [...sessions.values()][0];
    session.expiresAt = new Date(0);
    await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(response))
      .expect(401);
    session.expiresAt = new Date(Date.now() + 3600000);
    users.clear();
    await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(response))
      .expect(401);
  });

  it("revokes logout immediately, clears the cookie, and rejects replay", async () => {
    const response = await register();
    const logout = await post("logout")
      .set("Cookie", cookie(response))
      .send({})
      .expect(204);
    assert.match(logout.headers["set-cookie"][0], /Expires=Thu, 01 Jan 1970/);
    await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(response))
      .expect(401);
  });

  it("requires CSRF headers and a trusted browser origin including on public login", async () => {
    const body = { email: "alice@example.com", password };
    await request(app.getHttpServer())
      .post("/api/auth/login")
      .send(body)
      .expect(403);
    await post("login")
      .set("Origin", "https://untrusted.example")
      .send(body)
      .expect(403);
    const response = await register();
    await request(app.getHttpServer())
      .post("/api/auth/logout")
      .set("Cookie", cookie(response))
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie(response))
      .expect(200);
  });

  it("limits auth attempts and fails closed when the rate limiter is unavailable", async () => {
    attempts = 11;
    const result = await post("login")
      .send({ email: "alice@example.com", password })
      .expect(429);
    assert.equal(result.headers["retry-after"], "60");
    redisOffline = true;
    await post("register")
      .send({ name: "Alice", email: "alice@example.com", password })
      .expect(503);
    assert.equal(users.size, 0);
  });

  it("marks production cookies Secure", async () => {
    app.get(ConfigService).set("NODE_ENV", "production");
    const response = await register();
    assert.match(response.headers["set-cookie"][0], /; Secure/);
  });
});
