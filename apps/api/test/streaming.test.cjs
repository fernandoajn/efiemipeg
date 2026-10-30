require("reflect-metadata");
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { Readable } = require("node:stream");
const { Test } = require("@nestjs/testing");
const { ConfigModule } = require("@nestjs/config");
const { JwtService } = require("@nestjs/jwt");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { AuthModule } = require("../../../dist/apps/api/auth/auth.module");
const { VideosModule } = require("../../../dist/apps/api/videos/videos.module");
const { AUTH_COOKIE, JWT_ISSUER, JWT_AUDIENCE } = require("../../../dist/apps/api/auth/auth.types");
const { PrismaService } = require("../../../dist/apps/api/infrastructure/prisma.service");
const { RedisService } = require("../../../dist/apps/api/infrastructure/redis.service");
const { StorageService } = require("../../../dist/apps/api/infrastructure/storage.service");
const { ProcessingQueue } = require("../../../dist/apps/api/processing/processing-queue.service");
const { parseByteRange, rangeStillValid } = require("../../../dist/apps/api/videos/byte-range");

describe("Byte range parsing", () => {
  const size = 1000;
  it("parses bounded, open-ended, and suffix ranges", () => {
    assert.deepEqual(parseByteRange("bytes=0-99", size), { type: "partial", start: 0, end: 99 });
    assert.deepEqual(parseByteRange("bytes=500-", size), { type: "partial", start: 500, end: 999 });
    assert.deepEqual(parseByteRange("bytes=-100", size), { type: "partial", start: 900, end: 999 });
    assert.deepEqual(parseByteRange("BYTES = 10-10", size), { type: "partial", start: 10, end: 10 });
  });
  it("clamps ranges that run past the end", () => {
    assert.deepEqual(parseByteRange("bytes=900-5000", size), { type: "partial", start: 900, end: 999 });
    assert.deepEqual(parseByteRange("bytes=-5000", size), { type: "partial", start: 0, end: 999 });
  });
  it("rejects unsatisfiable and malformed byte ranges", () => {
    for (const header of ["bytes=1000-", "bytes=1000-1001", "bytes=-0", "bytes=5-2", "bytes=-", "bytes=a-b", "bytes=1.5-2", "bytes= ", "bytes"])
      assert.deepEqual(parseByteRange(header, size), { type: header === "bytes" ? "full" : "unsatisfiable" }, header);
  });
  it("ignores absent headers, unknown units, and multiple ranges", () => {
    for (const header of [undefined, "items=0-5", "bytes=0-1,5-6"]) assert.deepEqual(parseByteRange(header, size), { type: "full" });
  });
  it("honors If-Range only when the strong validator still matches", () => {
    const date = new Date(0).toUTCString();
    assert.equal(rangeStillValid(undefined, '"a"', date), true);
    assert.equal(rangeStillValid('"a"', '"a"', date), true);
    assert.equal(rangeStillValid(date, '"a"', date), true);
    assert.equal(rangeStillValid('"b"', '"a"', date), false);
    assert.equal(rangeStillValid('W/"a"', '"a"', date), false);
  });
});

describe("Video streaming HTTP contract", () => {
  let app;
  const secret = "s".repeat(64);
  const bytes = randomBytes(10000);
  const users = [randomUUID(), randomUUID()];
  const sessions = new Map(users.map(userId => [randomUUID(), userId]));
  const videos = new Map();
  let reads = [];
  let failStorage = false;
  const uploaded = (overrides = {}) => {
    const video = {
      id: randomUUID(), userId: users[0], title: "Clip", originalName: "clip.mp4", mimeType: "video/mp4", sizeBytes: bytes.length,
      status: "UPLOADED", objectKey: `originals/${users[0]}/x/y`, etag: '"etag-1"', uploadedAt: new Date("2026-10-30T12:00:00Z"), ...overrides,
    };
    videos.set(video.id, video);
    return video;
  };
  const prisma = {
    session: { findUnique: async ({ where }) => {
      const userId = sessions.get(where.id);
      return userId ? { id: where.id, userId, expiresAt: new Date(Date.now() + 60000), user: { id: userId, email: "a@example.com", name: "A", createdAt: new Date() } } : null;
    } },
    video: { findFirst: async ({ where }) => { const video = videos.get(where.id); return video?.userId === where.userId ? video : null; } },
  };
  const mediaObjects = new Map();
  const storage = { bucket: "videos", client: { send: async command => {
    reads.push(command.input);
    if (failStorage) throw Object.assign(new Error("down"), { $metadata: { httpStatusCode: 500 } });
    if (command.input.Key.startsWith("media/")) {
      const object = mediaObjects.get(command.input.Key);
      if (!object) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([object]), ContentLength: object.length, ETag: '"m"' };
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? "");
    const slice = match ? bytes.subarray(Number(match[1]), Number(match[2]) + 1) : bytes;
    return { Body: Readable.from([slice]), ContentLength: slice.length };
  } } };
  const cookieFor = userId => {
    const jti = [...sessions].find(([, owner]) => owner === userId)[0];
    const token = new JwtService({ secret }).sign({ sub: userId, jti }, { algorithm: "HS256", issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 3600 });
    return `${AUTH_COOKIE}=${token}`;
  };
  const get = (id, userId = users[0]) => request(app.getHttpServer()).get(`/api/videos/${id}/stream`).set("Cookie", cookieFor(userId)).buffer(true).parse((res, done) => {
    const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks)));
  });

  before(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({
          JWT_SECRET: secret, JWT_TTL_SECONDS: 3600, NODE_ENV: "test", WEB_ORIGIN: "http://localhost:4200", UPLOAD_URL_TTL_SECONDS: 3600, MAX_VIDEO_BYTES: 1073741824,
        })] }),
        AuthModule, VideosModule,
      ],
    })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(RedisService).useValue({})
      .overrideProvider(StorageService).useValue(storage)
      .overrideProvider(ProcessingQueue).useValue({ enqueue: async () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(cookieParser());
    await app.init();
  });
  beforeEach(() => { videos.clear(); mediaObjects.clear(); reads = []; failStorage = false; });
  after(async () => { await app?.close(); });

  it("requires a signed-in session", async () => {
    const video = uploaded();
    await request(app.getHttpServer()).get(`/api/videos/${video.id}/stream`).expect(401);
    assert.equal(reads.length, 0);
  });

  it("serves the whole verified original with 200 and advertises range support", async () => {
    const video = uploaded();
    const response = await get(video.id).expect(200);
    assert.ok(response.body.equals(bytes));
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(response.headers["content-length"], String(bytes.length));
    assert.equal(response.headers["content-type"], "video/mp4");
    assert.equal(response.headers["etag"], '"etag-1"');
    assert.equal(response.headers["content-range"], undefined);
    assert.equal(reads[0].Range, undefined);
    assert.equal(reads[0].IfMatch, '"etag-1"');
    assert.equal(reads[0].Key, video.objectKey);
  });

  it("returns 206 with exactly the requested bytes for bounded, open-ended, and suffix ranges", async () => {
    const video = uploaded();
    for (const [header, start, end] of [["bytes=0-1", 0, 1], ["bytes=9000-", 9000, 9999], ["bytes=-10", 9990, 9999], ["bytes=9990-99999", 9990, 9999]]) {
      const response = await get(video.id).set("Range", header).expect(206);
      assert.ok(response.body.equals(bytes.subarray(start, end + 1)), header);
      assert.equal(response.headers["content-range"], `bytes ${start}-${end}/${bytes.length}`);
      assert.equal(response.headers["content-length"], String(end - start + 1));
      assert.equal(reads.at(-1).Range, `bytes=${start}-${end}`);
    }
  });

  it("supports seeking to any offset", async () => {
    const video = uploaded();
    for (const offset of [7321, 0, 4096, 9999]) {
      const response = await get(video.id).set("Range", `bytes=${offset}-`).expect(206);
      assert.equal(response.body[0], bytes[offset]);
      assert.equal(response.body.length, bytes.length - offset);
    }
  });

  it("returns 416 with the representation size for unsatisfiable ranges without reading storage", async () => {
    const video = uploaded();
    for (const header of ["bytes=10000-", "bytes=-0", "bytes=50-10", "bytes=x-y"]) {
      const response = await get(video.id).set("Range", header).expect(416);
      assert.equal(response.headers["content-range"], `bytes */${bytes.length}`, header);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal(reads.length, 0);
  });

  it("ignores ranges it cannot serve and ranges for a changed representation", async () => {
    const video = uploaded();
    await get(video.id).set("Range", "bytes=0-1,4-5").expect(200);
    await get(video.id).set("Range", "items=0-1").expect(200);
    await get(video.id).set("Range", "bytes=0-1").set("If-Range", '"old"').expect(200);
    await get(video.id).set("Range", "bytes=0-1").set("If-Range", '"etag-1"').expect(206);
    await get(video.id).set("Range", "bytes=0-1").set("If-Range", video.uploadedAt.toUTCString()).expect(206);
  });

  it("answers HEAD with headers only and no storage read", async () => {
    const video = uploaded();
    const response = await request(app.getHttpServer()).head(`/api/videos/${video.id}/stream`).set("Cookie", cookieFor(users[0])).set("Range", "bytes=100-199").expect(206);
    assert.equal(response.headers["content-range"], `bytes 100-199/${bytes.length}`);
    assert.equal(response.headers["content-length"], "100");
    assert.equal(reads.length, 0);
  });

  it("hides other accounts' videos and refuses videos that are not uploaded", async () => {
    const video = uploaded();
    await get(video.id, users[1]).expect(404);
    await get(uploaded({ status: "VERIFYING", objectKey: null, etag: null, uploadedAt: null }).id).expect(409);
    await get(randomUUID()).expect(404);
    await request(app.getHttpServer()).get("/api/videos/not-a-uuid/stream").set("Cookie", cookieFor(users[0])).expect(400);
    assert.equal(reads.length, 0);
  });

  it("returns a JSON 503 without media headers when storage is unavailable", async () => {
    failStorage = true;
    const response = await get(uploaded().id).set("Range", "bytes=0-1").expect(503);
    assert.equal(response.headers["content-range"], undefined);
    assert.match(response.headers["content-type"], /application\/json/);
  });

  describe("authorized HLS delivery", () => {
    const version = randomUUID();
    const ready = () => {
      const video = uploaded({ processingStatus: "READY", mediaVersion: version, mediaPrefix: `media/${users[0]}/v/${version}` });
      mediaObjects.set(`${video.mediaPrefix}/master.m3u8`, Buffer.from("#EXTM3U\nv0/index.m3u8\n"));
      mediaObjects.set(`${video.mediaPrefix}/v0/segment_0000.ts`, Buffer.from("segment"));
      mediaObjects.set(`${video.mediaPrefix}/thumbnail.jpg`, Buffer.from("jpeg"));
      return video;
    };
    const media = (video, path, userId = users[0]) => request(app.getHttpServer()).get(`/api/videos/${video.id}/media/${version}/${path}`).set("Cookie", cookieFor(userId));

    it("serves playlists, segments, and thumbnails with immutable private caching and correct types", async () => {
      const video = ready();
      for (const [path, type] of [["master.m3u8", "application/vnd.apple.mpegurl"], ["v0/segment_0000.ts", "video/mp2t"], ["thumbnail.jpg", "image/jpeg"]]) {
        const response = await media(video, path).buffer(true).expect(200);
        assert.equal(response.headers["content-type"], type, path);
        assert.equal(response.headers["cache-control"], "private, max-age=31536000, immutable");
        assert.equal(reads.at(-1).Key, `${video.mediaPrefix}/${path}`);
      }
    });

    it("requires a session, ownership, a ready video, and the current media version", async () => {
      const video = ready();
      await request(app.getHttpServer()).get(`/api/videos/${video.id}/media/${version}/master.m3u8`).expect(401);
      await media(video, "master.m3u8", users[1]).expect(404);
      await request(app.getHttpServer()).get(`/api/videos/${video.id}/media/${randomUUID()}/master.m3u8`).set("Cookie", cookieFor(users[0])).expect(404);
      const processing = uploaded({ processingStatus: "PROCESSING", mediaVersion: version, mediaPrefix: "media/x" });
      await media(processing, "master.m3u8").expect(404);
      assert.equal(reads.length, 0);
    });

    it("serves only known HLS file names and maps a missing object to 404", async () => {
      const video = ready();
      for (const path of ["source", "v0/..%2F..%2Fsecret.ts", "v0/segment_0000.mp4", "v0/index.m3u8.bak", "originals.m3u8"]) await media(video, path).expect(404);
      assert.equal(reads.length, 0);
      await media(video, "v1/index.m3u8").expect(404);
    });
  });
});
