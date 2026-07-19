import { Buffer } from "buffer";
import { Decoder, Reader, tools } from "ts-ebml";

globalThis.Buffer = Buffer;

function trimEncodedMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const signature = [0x1a, 0x45, 0xdf, 0xa3];
  for (let index = 0; index <= bytes.length - signature.length; index++) {
    if (!signature.every((value, offset) => bytes[index + offset] === value)) continue;
    const start = index;
    const decoder = new Decoder();
    try {
      for (; index < bytes.length; index++) {
        for (const element of decoder.decode(bytes.subarray(index, index + 1))) {
          if (element.name === "Cues" && element.isEnd) {
            return bytes.slice(start, start + element.dataEnd);
          }
        }
      }
    } catch {
      index = start;
    }
  }
  throw new Error("Remuxed WebM metadata did not contain a complete Cues element");
}

async function makeSeekable(blob) {
  const buffer = await blob.arrayBuffer();
  const reader = new Reader();
  const decoder = new Decoder();

  for (const element of decoder.decode(buffer)) reader.read(element);
  reader.stop();

  if (!reader.metadatas.length || !reader.metadataSize || !reader.duration) {
    throw new Error("WebM recording did not contain enough metadata to remux");
  }

  const encodedMetadata = tools.makeMetadataSeekable(reader.metadatas, reader.duration, reader.cues);
  const metadata = trimEncodedMetadata(encodedMetadata);
  const remuxed = new Blob([metadata, buffer.slice(reader.metadataSize)], {
    type: blob.type || "video/webm"
  });

  return {
    blob: remuxed,
    durationMs: Math.round(reader.duration * reader.timestampScale / 1_000_000),
    originalSize: blob.size
  };
}

globalThis.WebMRemux = { makeSeekable };
