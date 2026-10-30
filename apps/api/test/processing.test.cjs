const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { planRenditions, readProbe, hlsArguments, thumbnailArguments, MEDIA_FILE } = require("../../../dist/apps/api/processing/hls-plan");

describe("Encoding ladder", () => {
  const sizes = renditions => renditions.map(({ width, height }) => `${width}x${height}`);
  it("generates 360p, 720p, and 1080p only when the source has that resolution", () => {
    assert.deepEqual(sizes(planRenditions(3840, 2160)), ["640x360", "1280x720", "1920x1080"]);
    assert.deepEqual(sizes(planRenditions(1920, 1080)), ["640x360", "1280x720", "1920x1080"]);
    assert.deepEqual(sizes(planRenditions(1280, 720)), ["640x360", "1280x720"]);
    assert.deepEqual(sizes(planRenditions(640, 360)), ["640x360"]);
  });
  it("uses the short side so portrait video gets the same quality steps", () => {
    assert.deepEqual(sizes(planRenditions(1080, 1920)), ["360x640", "720x1280", "1080x1920"]);
  });
  it("keeps an in-between or tiny source at its own resolution instead of upscaling", () => {
    assert.deepEqual(sizes(planRenditions(960, 540)), ["640x360", "960x540"]);
    assert.deepEqual(sizes(planRenditions(320, 240)), ["320x240"]);
    assert.deepEqual(sizes(planRenditions(1280, 750)), ["614x360", "1228x720"]);
  });
  it("produces even dimensions and increasing bitrates", () => {
    for (const [width, height] of [[1279, 719], [853, 480], [1918, 1078], [321, 241]]) {
      const plan = planRenditions(width, height);
      for (const rendition of plan) assert.ok(rendition.width % 2 === 0 && rendition.height % 2 === 0, `${width}x${height}`);
      for (let index = 1; index < plan.length; index++) assert.ok(plan[index].videoKbps > plan[index - 1].videoKbps);
    }
  });
});

describe("FFprobe report", () => {
  const report = (stream, extra = {}) => ({ format: { duration: "12.5" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", ...stream }, ...(extra.audio ? [{ codec_type: "audio", codec_name: "aac" }] : [])] });
  it("reads duration, codecs, and frame rate", () => {
    const probed = readProbe(report({}, { audio: true }));
    assert.equal(probed.durationSeconds, 12.5);
    assert.equal(probed.audioCodec, "aac");
    assert.ok(Math.abs(probed.frameRate - 29.97) < 0.01);
  });
  it("swaps dimensions for rotated phone video", () => {
    assert.deepEqual([readProbe(report({ side_data_list: [{ rotation: -90 }] })).width, readProbe(report({ tags: { rotate: "270" } })).height], [1080, 1920]);
  });
  it("rejects files without a video stream or duration", () => {
    assert.equal(readProbe({ format: { duration: "3" }, streams: [{ codec_type: "audio" }] }), null);
    assert.equal(readProbe({ format: {}, streams: report({}).streams }), null);
  });
});

describe("FFmpeg arguments", () => {
  const renditions = planRenditions(1920, 1080);
  it("aligns keyframes to segment boundaries and maps one audio track per variant", () => {
    const args = hlsArguments("/in", "/out", renditions, true);
    assert.equal(args[args.indexOf("-force_key_frames") + 1], "expr:gte(t,n_forced*4)");
    assert.equal(args[args.indexOf("-sc_threshold") + 1], "0");
    assert.equal(args[args.indexOf("-var_stream_map") + 1], "v:0,a:0 v:1,a:1 v:2,a:2");
    assert.equal(args.filter(arg => arg === "0:a:0").length, 3);
    assert.equal(args[args.indexOf("-master_pl_name") + 1], "master.m3u8");
    assert.equal(args.at(-1), "/out/v%v/index.m3u8");
  });
  it("omits audio options for silent video", () => {
    const args = hlsArguments("/in", "/out", renditions, false);
    assert.ok(!args.includes("-c:a") && !args.includes("0:a:0"));
    assert.equal(args[args.indexOf("-var_stream_map") + 1], "v:0 v:1 v:2");
  });
  it("scales thumbnails to at most 640 pixels on the long side", () => {
    const args = thumbnailArguments("/in", "/t.jpg", { width: 1080, height: 1920, durationSeconds: 5 }, 0.5);
    assert.equal(args[args.indexOf("-vf") + 1], "scale=360:640");
  });
  it("allows only generated file names to be served", () => {
    for (const path of ["master.m3u8", "thumbnail.jpg", "v0/index.m3u8", "v2/segment_0012.ts"]) assert.ok(MEDIA_FILE.test(path), path);
    for (const path of ["source", "../x.ts", "v0/../../x.ts", "v0/segment_1.ts", "v0/a/index.m3u8"]) assert.ok(!MEDIA_FILE.test(path), path);
  });
});
