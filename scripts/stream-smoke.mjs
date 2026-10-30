import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

// Exercises progressive playback and HLS processing through the Vite proxy, exactly as the browser reaches them.
// Requires the API, the web dev server, and the processing worker to be running.
const web = `http://127.0.0.1:${process.env.WEB_PORT || 4200}/api`;
const origin = process.env.WEB_ORIGIN || "http://localhost:4200";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
const emails = [`stream-smoke-${randomUUID()}@example.test`, `stream-smoke-${randomUUID()}@example.test`];
const directory = mkdtempSync(join(tmpdir(), "efiemipeg-stream-"));
const userIds = [];

async function call(path, { body, cookie, headers = {}, method } = {}) {
  return fetch(`${web}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "X-Requested-With": "efiemipeg", Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
}
async function register(email) {
  const response = await call("/auth/register", { body: { name: "Stream Smoke", email, password: `smoke-${randomUUID()}` } });
  assert.equal(response.status, 201);
  userIds.push((await response.json()).user.id);
  return response.headers.get("set-cookie").split(";")[0];
}

try {
  const file = join(directory, "smoke.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "10", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-movflags", "+faststart", file]);
  const bytes = readFileSync(file);
  const [owner, stranger] = [await register(emails[0]), await register(emails[1])];

  const initialized = await call("/videos/uploads", { cookie: owner, body: { title: "Stream smoke", originalName: "smoke.mp4", mimeType: "video/mp4", sizeBytes: bytes.length } });
  assert.equal(initialized.status, 201);
  const { video, upload } = await initialized.json();
  const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
  assert.equal(put.status, 200);
  assert.equal((await call(`/videos/${video.id}/complete`, { cookie: owner, body: {} })).status, 200);
  const stream = `/videos/${video.id}/stream`;
  console.log(`PASS uploaded a ${bytes.length}-byte MP4 and verified it`);

  const full = await call(stream, { cookie: owner });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes));
  console.log("PASS 200 returns the complete original and advertises Accept-Ranges: bytes");

  const middle = Math.floor(bytes.length / 2);
  for (const [range, start, end] of [["bytes=0-1023", 0, 1023], [`bytes=${middle}-`, middle, bytes.length - 1], ["bytes=-512", bytes.length - 512, bytes.length - 1]]) {
    const response = await call(stream, { cookie: owner, headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(start, end + 1)), range);
  }
  console.log("PASS 206 returns byte-exact slices for bounded, open-ended (seek), and suffix ranges");

  const unsatisfiable = await call(stream, { cookie: owner, headers: { Range: `bytes=${bytes.length}-` } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${bytes.length}`);
  console.log("PASS 416 rejects ranges beyond the end with Content-Range: bytes */size");

  // Abandon a request mid-body, like a seek does, then confirm the API still serves.
  const abandoned = new AbortController();
  const partial = await fetch(`${web}${stream}`, { headers: { Cookie: owner }, signal: abandoned.signal });
  await partial.body.getReader().read();
  abandoned.abort();
  assert.equal((await call(stream, { cookie: owner, headers: { Range: "bytes=0-0" } })).status, 206);
  console.log("PASS an abandoned mid-stream request does not disturb later requests");

  assert.equal((await call(stream)).status, 401);
  assert.equal((await call(stream, { cookie: stranger })).status, 404);
  console.log("PASS streams require a session and are private to their owner");

  let processed = video;
  for (const deadline = Date.now() + 180000; processed.processing?.status !== "READY"; ) {
    assert.notEqual(processed.processing?.status, "FAILED", processed.processing?.error);
    assert.ok(Date.now() < deadline, "Processing did not finish in time. Is the worker running (npm run dev)?");
    await new Promise(resolve => setTimeout(resolve, 1000));
    processed = (await (await call(`/videos/${video.id}`, { cookie: owner })).json()).video;
  }
  assert.equal(processed.metadata.width, 1920);
  assert.equal(processed.metadata.audioCodec, "aac");
  console.log(`PASS the worker probed and processed the upload (${processed.metadata.durationSeconds.toFixed(1)} s, ${processed.metadata.videoCodec})`);

  const media = `/videos/${video.id}/media/${processed.mediaVersion}`;
  const master = await call(`${media}/master.m3u8`, { cookie: owner });
  assert.equal(master.status, 200);
  assert.equal(master.headers.get("content-type"), "application/vnd.apple.mpegurl");
  const variants = [...(await master.text()).matchAll(/RESOLUTION=(\d+x\d+),CODECS="([^"]+)"\s+(\S+)/g)];
  assert.deepEqual(variants.map(([, resolution]) => resolution), ["640x360", "1280x720", "1920x1080"]);
  for (const [, , codecs] of variants) assert.match(codecs, /^avc1\.[0-9a-f]+,mp4a\.40\.2$/);
  console.log("PASS master playlist lists the 360p, 720p, and 1080p ladder with H.264/AAC codecs");

  const timelines = [];
  for (const [, , , uri] of variants) {
    const playlist = await (await call(`${media}/${uri}`, { cookie: owner })).text();
    assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    timelines.push([...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(([, duration]) => Number(duration).toFixed(2)));
  }
  for (const timeline of timelines.slice(1)) assert.deepEqual(timeline, timelines[0]);
  console.log(`PASS segment boundaries align across renditions (${timelines[0].join(" + ")} s)`);

  const segment = await call(`${media}/${variants[1][3].replace("index.m3u8", "segment_0000.ts")}`, { cookie: owner });
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get("content-type"), "video/mp2t");
  const segmentFile = join(directory, "segment.ts");
  writeFileSync(segmentFile, Buffer.from(await segment.arrayBuffer()));
  const codecs = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", segmentFile], { encoding: "utf8" })).streams.map(stream => stream.codec_name);
  assert.deepEqual(codecs.sort(), ["aac", "h264"]);
  const thumbnail = await call(`${media}/thumbnail.jpg`, { cookie: owner });
  assert.equal(thumbnail.headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await thumbnail.arrayBuffer()).slice(0, 2)], [0xff, 0xd8]);
  console.log("PASS segments decode as H.264 + AAC and the thumbnail is a JPEG");

  assert.equal((await call(`${media}/master.m3u8`)).status, 401);
  assert.equal((await call(`${media}/master.m3u8`, { cookie: stranger })).status, 404);
  assert.equal((await call(`/videos/${video.id}/media/${randomUUID()}/master.m3u8`, { cookie: owner })).status, 404);
  console.log("PASS HLS delivery requires the owner’s session and the current media version");
} finally {
  if (userIds.length) {
    for (const userId of userIds) {
      for (const prefix of [`uploads/${userId}/`, `originals/${userId}/`, `media/${userId}/`]) {
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, Prefix: prefix }));
        if (listed.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: process.env.S3_BUCKET, Delete: { Objects: listed.Contents.map(({ Key }) => ({ Key })) } }));
      }
    }
    await pool.query('DELETE FROM "User" WHERE id = ANY($1::uuid[])', [userIds]);
  }
  await pool.end();
  s3.destroy();
  rmSync(directory, { recursive: true, force: true });
  console.log("Removed this run’s temporary accounts, videos, and stored objects.");
}
