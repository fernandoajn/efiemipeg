// HTTP range handling for a single representation of known size (RFC 9110 §14).
export type ByteRange =
  | { type: "full" }
  | { type: "partial"; start: number; end: number }
  | { type: "unsatisfiable" };

export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { type: "full" };
  const separator = header.indexOf("=");
  // Unknown range units must be ignored, not rejected.
  if (separator < 0 || header.slice(0, separator).trim().toLowerCase() !== "bytes") return { type: "full" };
  const specs = header.slice(separator + 1).split(",").map(spec => spec.trim());
  // Multipart/byteranges responses are not implemented; servers may ignore Range and send the whole file.
  if (specs.length !== 1) return { type: "full" };
  const match = /^(\d*)-(\d*)$/.exec(specs[0]);
  if (!match || (!match[1] && !match[2])) return { type: "unsatisfiable" };
  if (!match[1]) {
    // Suffix range: "bytes=-500" means the final 500 bytes.
    const length = Number(match[2]);
    return length > 0 ? { type: "partial", start: Math.max(0, size - length), end: size - 1 } : { type: "unsatisfiable" };
  }
  const start = Number(match[1]);
  const last = match[2] ? Number(match[2]) : size - 1;
  if (last < start || start >= size) return { type: "unsatisfiable" };
  return { type: "partial", start, end: Math.min(last, size - 1) };
}

// If-Range makes a range conditional: when the validator no longer matches, send the whole new file instead.
export function rangeStillValid(ifRange: string | undefined, etag: string, lastModified: string): boolean {
  if (ifRange === undefined) return true;
  const value = ifRange.trim();
  return value.startsWith("W/") ? false : value === etag || value === lastModified;
}
