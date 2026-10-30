require("reflect-metadata");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Test } = require("@nestjs/testing");
const request = require("supertest");
const {
  HealthController,
} = require("../../../dist/apps/api/health/health.controller");
const {
  HealthService,
} = require("../../../dist/apps/api/health/health.service");
const {
  PrismaService,
} = require("../../../dist/apps/api/infrastructure/prisma.service");
const {
  RedisService,
} = require("../../../dist/apps/api/infrastructure/redis.service");
const {
  StorageService,
} = require("../../../dist/apps/api/infrastructure/storage.service");

describe("Health HTTP contract", () => {
  let app;
  const failing = new Set();
  const dependency = (name) => ({
    ping: async () => {
      if (failing.has(name)) throw new Error("secret-connection-string");
    },
  });

  before(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: dependency("postgres") },
        { provide: RedisService, useValue: dependency("redis") },
        { provide: StorageService, useValue: dependency("minio") },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  after(async () => {
    await app.close();
  });

  it("reports all services, timing, and no-store when ready", async () => {
    const { body, headers } = await request(app.getHttpServer())
      .get("/api/health/ready")
      .expect(200);
    assert.equal(body.status, "ok");
    assert.equal(headers["cache-control"], "no-store");
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    assert.deepEqual(Object.keys(body.services).sort(), [
      "minio",
      "postgres",
      "redis",
    ]);
    for (const service of Object.values(body.services)) {
      assert.equal(service.status, "up");
      assert.ok(service.latencyMs >= 0);
    }
  });

  it("exposes the readiness alias", async () => {
    await request(app.getHttpServer()).get("/api/health").expect(200);
  });

  for (const name of ["postgres", "redis", "minio"]) {
    it(`returns 503 for a ${name} outage, keeps liveness healthy, and recovers`, async () => {
      failing.add(name);
      try {
        const { body, text } = await request(app.getHttpServer())
          .get("/api/health/ready")
          .expect(503);
        assert.equal(body.status, "error");
        assert.equal(body.services[name].status, "down");
        assert.ok(!text.includes("secret-connection-string"));
        for (const other of ["postgres", "redis", "minio"].filter(
          (item) => item !== name,
        )) {
          assert.equal(body.services[other].status, "up");
        }
        const live = await request(app.getHttpServer())
          .get("/api/health/live")
          .expect(200);
        assert.equal(live.body.status, "ok");
      } finally {
        failing.delete(name);
      }
      await request(app.getHttpServer()).get("/api/health/ready").expect(200);
    });
  }
});
