import { z } from "zod";

export const videoFormats = {
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"],
} as const;

export const initializeSchema = z.object({
  title: z.string().trim().min(1).max(160),
  originalName: z.string().trim().min(1).max(255).refine(value => !/[\x00-\x1f\x7f/\\]/.test(value), "Use a filename without paths or control characters"),
  mimeType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  sizeBytes: z.number().int().positive().max(2147483647),
}).strict().refine(input => (videoFormats[input.mimeType] as readonly string[]).includes(input.originalName.split(".").pop()?.toLowerCase() ?? ""), {
  message: "The filename extension must match the video format", path: ["originalName"],
});

// Container identification only. Codec validation/transcoding belongs to a later phase.
export function matchesVideoContainer(bytes: Uint8Array, mimeType: string): boolean {
  const buffer = Buffer.from(bytes);
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
    return buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
  }
  return buffer.length >= 8 && buffer.readUInt32BE(0) === 0x1a45dfa3 && buffer.includes(Buffer.from("webm"));
}
