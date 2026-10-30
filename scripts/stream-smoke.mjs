import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

// Exercises progressive playback through the Vite proxy, exactly as the browser reaches it.
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
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24", "-t", "4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
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
} finally {
  if (userIds.length) {
    for (const userId of userIds) {
      for (const prefix of [`uploads/${userId}/`, `originals/${userId}/`]) {
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
