/**
 * Compress Video's conversion, run in Node with stand-in coders: there's no
 * WebCodecs here, so fake VP8/Vorbis decoders and H.264/Opus encoders pass
 * frames through, and the test checks what reaches the MP4. As in Firefox or
 * Chrome on Linux, nothing here can make AAC.
 */
import { createRequire } from "node:module";
import type { AudioSample as Audio, EncodedPacket as Packet, VideoSample as Sample } from "mediabunny";
import { compressVideo } from "../lib/video-compress.ts";

// lib/video-compress.ts loads as CommonJS here: the coders must be registered with that copy of mediabunny.
const {
  ALL_FORMATS, AudioSample, BufferSource, BufferTarget, CustomAudioDecoder, CustomAudioEncoder, CustomVideoDecoder,
  CustomVideoEncoder, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input,
  Output, registerDecoder, registerEncoder, VideoSample, WebMOutputFormat,
} = createRequire(import.meta.url)("mediabunny") as typeof import("mediabunny");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const W = 320, H = 180, RATE = 44_100, FRAMES = 1024;

class FakeVp8Decoder extends CustomVideoDecoder {
  static override supports(codec: string) {
    return codec === "vp8";
  }
  init() {}
  decode(packet: Packet) {
    const { timestamp, duration } = packet;
    this.onSample(new VideoSample(new Uint8Array((W * H * 3) / 2), { format: "I420", codedWidth: W, codedHeight: H, timestamp, duration }));
  }
  flush() {}
  close() {}
}

// A well-formed AVCDecoderConfigurationRecord (Baseline 3.0), enough for the muxer.
const AVCC = new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xc0, 0x1e, 1, 0, 2, 0x68, 0xce]);
class FakeAvcEncoder extends CustomVideoEncoder {
  static override supports(codec: string) {
    return codec === "avc";
  }
  n = 0;
  init() {}
  encode(sample: Sample, options: { keyFrame?: boolean }) {
    const key = this.n++ === 0 || !!options.keyFrame;
    const packet = new EncodedPacket(new Uint8Array([0, 0, 0, 1, key ? 0x65 : 0x41]), key ? "key" : "delta", sample.timestamp, sample.duration);
    this.onPacket(packet, this.n === 1 ? { decoderConfig: { codec: "avc1.42c01e", codedWidth: W, codedHeight: H, description: AVCC } } : undefined);
  }
  flush() {}
  close() {}
}

class FakeVorbisDecoder extends CustomAudioDecoder {
  static override supports(codec: string) {
    return codec === "vorbis";
  }
  init() {}
  decode(packet: Packet) {
    const data = new Float32Array(FRAMES * 2);
    this.onSample(new AudioSample({ format: "f32", sampleRate: RATE, numberOfChannels: 2, timestamp: packet.timestamp, data }));
  }
  flush() {}
  close() {}
}

// An OpusHead: version 1, stereo, 312 samples pre-skip, 48 kHz.
const OPUS_HEAD = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
class FakeOpusEncoder extends CustomAudioEncoder {
  static override supports(codec: string) {
    return codec === "opus";
  }
  n = 0;
  init() {}
  encode(sample: Audio) {
    const meta = this.n++ ? undefined : { decoderConfig: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2, description: OPUS_HEAD } };
    this.onPacket(new EncodedPacket(new Uint8Array([0xfc]), "key", sample.timestamp, sample.duration), meta);
  }
  flush() {}
  close() {}
}
registerDecoder(FakeVp8Decoder);
registerDecoder(FakeVorbisDecoder);
registerEncoder(FakeAvcEncoder);
registerEncoder(FakeOpusEncoder);

/** Vorbis's three headers, Xiph-laced as WebM's CodecPrivate holds them. */
function vorbisPrivate() {
  const id = new Uint8Array(30);
  id.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);
  const v = new DataView(id.buffer);
  v.setUint8(11, 2);
  v.setUint32(12, RATE, true);
  v.setInt32(20, 128_000, true);
  id[28] = 0xb8;
  id[29] = 1;
  const comment = new Uint8Array([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const setup = new Uint8Array([5, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0]);
  return new Uint8Array([2, id.length, comment.length, ...id, ...comment, ...setup]);
}

/**
 * A VP8 WebM as MediaRecorder writes it: SimpleBlocks with no frame
 * durations and a cluster a second. With `vorbis`, it has Vorbis sound.
 */
async function recordingLike(frames: number, { fps = 30, vorbis = false } = {}): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const video = new EncodedVideoPacketSource("vp8");
  output.addVideoTrack(video);
  const audio = vorbis ? new EncodedAudioPacketSource("vorbis") : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  let heard = 0;
  for (let i = 0; i < frames; i++) {
    const key = i % fps === 0;
    // A VP8 frame tag (key or inter frame, shown), then a key frame's start code and size.
    const data = key ? new Uint8Array([0x10, 0, 0, 0x9d, 0x01, 0x2a, W & 255, W >> 8, H & 255, H >> 8]) : new Uint8Array([0x11, 0, 0, i & 255]);
    await video.add(new EncodedPacket(data, key ? "key" : "delta", i / fps, 1 / fps), i ? undefined : { decoderConfig: { codec: "vp8", codedWidth: W, codedHeight: H } });
    for (; audio && heard * FRAMES <= ((i + 1) / fps) * RATE; heard++) {
      const meta = heard ? undefined : { decoderConfig: { codec: "vorbis", sampleRate: RATE, numberOfChannels: 2, description: vorbisPrivate() } };
      await audio.add(new EncodedPacket(new Uint8Array([0]), "key", (heard * FRAMES) / RATE, FRAMES / RATE), meta);
    }
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: "video/webm" });
}

async function read(blob: Blob) {
  const input = new Input({ source: new BufferSource(await blob.arrayBuffer()), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const frames: { t: number; d: number }[] = [];
  for await (const p of new EncodedPacketSink(track!).packets(undefined, undefined, { metadataOnly: true })) frames.push({ t: p.timestamp, d: p.duration });
  const audio = (await (await input.getPrimaryAudioTrack())?.getCodec()) ?? null;
  input.dispose();
  return { frames, audio };
}

// ---------- every frame of a MediaRecorder-style WebM is kept ----------
{
  const src = await recordingLike(150);
  const before = (await read(src)).frames;
  const untimed = before.filter((p) => p.d === 0).length;
  check("the stand-in WebM has frames with no duration, as MediaRecorder's do", untimed >= 4, `${untimed} of ${before.length}`);
  const out = await compressVideo(src);
  const after = (await read(out.blob)).frames;
  check("it's re-encoded to H.264", out.action === "encode");
  check("no frame is dropped (last of each cluster, last of the video)", after.length === before.length, `${before.length} in, ${after.length} out`);
  const ts = after.map((p) => p.t).sort((a, b) => a - b);
  check("frames keep their times", ts.every((t, i) => Math.abs(t - i / 30) < 0.002), JSON.stringify(ts.slice(28, 32)));
  check("each frame lasts until the next", after.every((p) => Math.abs(p.d - 1 / 30) < 0.002), JSON.stringify(after.filter((p) => Math.abs(p.d - 1 / 30) >= 0.002).slice(0, 3)));
}

// ---------- Vorbis doesn't go into the MP4 ----------
{
  const src = await recordingLike(60, { vorbis: true });
  check("the stand-in WebM has Vorbis sound", (await read(src)).audio === "vorbis");
  const out = await read((await compressVideo(src)).blob);
  check("without AAC, Vorbis becomes Opus (Safari and QuickTime don't play Vorbis in MP4)", out.audio === "opus", String(out.audio));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
