import { statSync } from "node:fs";
import { basename } from "node:path";
import { nativeImage } from "electron";

/**
 * Image attachment intake for the composer.
 *
 * Downscaled and re-encoded AT INTAKE rather than at send: a modern phone
 * photo is ~4000px of base64 that would bloat every turn's context for no
 * visual gain in a chat transcript. Everything becomes a JPEG of known type,
 * so the wire media type is always "image/jpeg" regardless of source format.
 *
 * PROVENANCE (for the extraction pass): the constants and the content-part
 * builder below deliberately mirror coda/agents-chat
 * src/lib/letta/attachments.ts (the Android pane this desktop pane derives
 * from). They are duplicated here only because desktop's projection is
 * local by design (see transcript.ts); when that extraction pass unifies the
 * projections, these move to @angus/letta-client-core as their shared home.
 */

/** Longest edge kept after downscaling; matches the Android pane. */
export const MAX_EDGE = 1600;
/** JPEG re-encode quality on Electron's 0–100 scale (Android's 0.8). */
export const JPEG_QUALITY = 80;
/** Source files above this are refused before decoding. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Per-message attachment cap; matches the Android pane. */
export const MAX_ATTACHMENTS = 4;

/** An image ready to send: base64 data plus what the UI needs to stage it. */
export interface AttachmentView {
  id: string;
  /** Original file name, for the chip label. */
  name: string;
  /** Base64 JPEG payload, ready for the SDK's multimodal content array. */
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

/** Intake one image file: size-guard, downscale, re-encode to JPEG base64. */
export function intakeImage(path: string): AttachmentView {
  const name = basename(path);
  const size = statSync(path).size;
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(`${name} is ${(size / 1024 / 1024).toFixed(0)}MB — over the 25MB limit`);
  }
  const source = nativeImage.createFromPath(path);
  if (source.isEmpty()) {
    throw new Error(`${name} could not be read as an image`);
  }
  const { width, height } = source.getSize();
  const longest = Math.max(width, height);
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
  // Animated formats (gif, webp) decode to their first frame — consistent
  // with the re-encode-to-JPEG doctrine.
  const encoded =
    scale < 1
      ? source.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
      : source;
  const data = encoded.toJPEG(JPEG_QUALITY).toString("base64");
  const sized = encoded.getSize();
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    data,
    mediaType: "image/jpeg",
    width: sized.width,
    height: sized.height,
  };
}

/** Attachment views as SDK image content parts (base64, no data: prefix). */
export function toImageContent(attachments: readonly AttachmentView[]): Array<{
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}> {
  return attachments.map((attachment) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: attachment.mediaType, data: attachment.data },
  }));
}

/**
 * Intake a batch of picked files: first MAX_ATTACHMENTS succeed, the rest
 * (and any unreadable/oversize ones) come back as human-readable skips so
 * the renderer can say why a pick did not land.
 */
export function intakeFiles(paths: readonly string[]): {
  attachments: AttachmentView[];
  skipped: string[];
} {
  const attachments: AttachmentView[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      skipped.push(`${basename(path)} — over the ${MAX_ATTACHMENTS}-image limit`);
      continue;
    }
    try {
      attachments.push(intakeImage(path));
    } catch (error) {
      skipped.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { attachments, skipped };
}
