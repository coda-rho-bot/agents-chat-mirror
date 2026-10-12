import { statSync } from "node:fs";
import { basename } from "node:path";
import { nativeImage } from "electron";
import {
  downscaleDimensions,
  intakeBatch,
  JPEG_QUALITY as CORE_JPEG_QUALITY,
  overSourceLimit,
  toImageContent as coreToImageContent,
  wireContent as coreWireContent,
} from "@angus/letta-client-core";
import type { ImageContent, SendMessage } from "@letta-ai/letta-agent-sdk";

/**
 * Image attachment intake for the composer — the Electron SHELL over the
 * core's intake policy (@angus/letta-client-core src/attachments.ts, tier 3
 * extraction from this file's lineage; PROVENANCE.md there pins the commit).
 * The policy — limits, downscale math, batch cap, wire projections — lives in
 * the core; this file is the platform decode (nativeImage) plus the thin
 * adapters that keep the existing export sites stable for call sites.
 *
 * Downscaled and re-encoded AT INTAKE rather than at send: a modern phone
 * photo is ~4000px of base64 that would bloat every turn's context for no
 * visual gain in a chat transcript. Everything becomes a JPEG of known type,
 * so the wire media type is always "image/jpeg" regardless of source format.
 */

/** Core intake policy, re-exported at the existing sites. */
export { MAX_EDGE, MAX_SOURCE_BYTES, MAX_ATTACHMENTS } from "@angus/letta-client-core";
/** JPEG re-encode quality on Electron's 0–100 scale (the core's canonical 0.8). */
export const JPEG_QUALITY = Math.round(CORE_JPEG_QUALITY * 100);

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
  if (overSourceLimit(size)) {
    throw new Error(`${name} is ${(size / 1024 / 1024).toFixed(0)}MB — over the 25MB limit`);
  }
  const source = nativeImage.createFromPath(path);
  if (source.isEmpty()) {
    throw new Error(`${name} could not be read as an image`);
  }
  const { width, height } = source.getSize();
  // Animated formats (gif, webp) decode to their first frame — consistent
  // with the re-encode-to-JPEG doctrine.
  const target = downscaleDimensions(width, height);
  const encoded = target ? source.resize(target) : source;
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
export function toImageContent(attachments: readonly AttachmentView[]): ImageContent[] {
  return coreToImageContent(attachments);
}

/**
 * The wire payload for a send: images LEAD the content array so the model
 * reads them as context for the instruction (Android order); plain text
 * stays a plain string.
 */
export function wireContent(
  text: string,
  attachments: readonly AttachmentView[],
): SendMessage {
  return coreWireContent(text, attachments);
}

/**
 * Intake a batch of picked files: the core's cap policy over this shell's
 * decode — first MAX_ATTACHMENTS succeed, the rest (and any unreadable/
 * oversize ones) come back as human-readable skips so the renderer can say
 * why a pick did not land.
 */
export function intakeFiles(paths: readonly string[]): {
  attachments: AttachmentView[];
  skipped: string[];
} {
  return intakeBatch(paths, intakeImage, basename);
}
