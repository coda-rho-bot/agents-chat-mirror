import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Attachments = typeof import("../../src/electron/libs/attachments");

let dir: string;
let attachments: Attachments;

/** Fake decoded image: records resize calls, encodes a recognizable payload. */
function fakeImage(width: number, height: number) {
  const image = {
    isEmpty: () => false,
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn((options: { width: number; height: number }) =>
      fakeImage(options.width, options.height),
    ),
    toJPEG: vi.fn((quality: number) => Buffer.from(`jpeg-q${quality}-${width}x${height}`)),
  };
  return image;
}

// nativeImage stand-in: paths ending .broken decode to an empty image.
vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: (path: string) =>
      path.endsWith(".broken")
        ? { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }
        : fakeImageFromPath(path),
  },
}));

const images = new Map<string, ReturnType<typeof fakeImage>>();
function fakeImageFromPath(path: string) {
  const existing = images.get(path);
  if (existing) return existing;
  const match = path.match(/(\d+)x(\d+)/);
  const image = fakeImage(match ? Number(match[1]) : 800, match ? Number(match[2]) : 600);
  images.set(path, image);
  return image;
}

function imageFile(name: string, bytes = 1000): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "attachments-"));
  images.clear();
  vi.resetModules();
  attachments = await import("../../src/electron/libs/attachments");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("intakeImage", () => {
  it("passes a small image through without resizing", () => {
    const path = imageFile("small-800x600.png");
    const view = attachments.intakeImage(path);
    const source = images.get(path)!;
    expect(source.resize).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      name: "small-800x600.png",
      mediaType: "image/jpeg",
      width: 800,
      height: 600,
    });
    expect(view.data).toBe(Buffer.from("jpeg-q80-800x600").toString("base64"));
  });

  it("downscales a large image to the 1600px longest edge", () => {
    const path = imageFile("photo-4000x3000.jpg");
    const view = attachments.intakeImage(path);
    const source = images.get(path)!;
    expect(source.resize).toHaveBeenCalledWith({ width: 1600, height: 1200 });
    expect(view.width).toBe(1600);
    expect(view.height).toBe(1200);
  });

  it("downscales portrait images on the height axis", () => {
    const path = imageFile("portrait-3000x4000.jpg");
    attachments.intakeImage(path);
    expect(images.get(path)!.resize).toHaveBeenCalledWith({ width: 1200, height: 1600 });
  });

  it("refuses source files over the 25MB guard", () => {
    const path = imageFile("huge-800x600.png", 26 * 1024 * 1024);
    expect(() => attachments.intakeImage(path)).toThrow(/25MB/);
  });

  it("refuses files that do not decode as images", () => {
    const path = imageFile("corrupt.broken");
    expect(() => attachments.intakeImage(path)).toThrow(/could not be read/);
  });
});

describe("intakeFiles", () => {
  it("intakes in order and reports nothing on a clean batch", () => {
    const { attachments: picked, skipped } = attachments.intakeFiles([
      imageFile("a-800x600.png"),
      imageFile("b-800x600.png"),
    ]);
    expect(picked.map((item) => item.name)).toEqual(["a-800x600.png", "b-800x600.png"]);
    expect(skipped).toEqual([]);
  });

  it("caps at four images and reports the overflow with reasons", () => {
    const paths = [1, 2, 3, 4, 5, 6].map((n) => imageFile(`img${n}-800x600.png`));
    const { attachments: picked, skipped } = attachments.intakeFiles(paths);
    expect(picked).toHaveLength(4);
    expect(skipped).toEqual([
      "img5-800x600.png — over the 4-image limit",
      "img6-800x600.png — over the 4-image limit",
    ]);
  });

  it("skips unreadable files without dropping the rest of the batch", () => {
    const { attachments: picked, skipped } = attachments.intakeFiles([
      imageFile("good-800x600.png"),
      imageFile("bad.broken"),
      imageFile("also-good-800x600.png"),
    ]);
    expect(picked.map((item) => item.name)).toEqual(["good-800x600.png", "also-good-800x600.png"]);
    expect(skipped).toEqual(["bad.broken could not be read as an image"]);
  });
});

describe("toImageContent", () => {
  it("builds SDK base64 image parts with no data: prefix", () => {
    const view = attachments.intakeImage(imageFile("shot-800x600.png"));
    const [part] = attachments.toImageContent([view]);
    expect(part).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: view.data },
    });
  });
});
