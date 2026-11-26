// Pictures pasted into Chat's box (chat-images.ts): what one paste carries,
// what the box keeps or refuses, and how a kept picture is pasted into the
// session and seen taken there. The composer's half is chat-compose-images.test.ts.
import { describe, expect, it } from "vitest";
import {
  CHAT_IMAGE_TYPES, IMAGE_TAKE_WAIT_MS, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES,
  addImages, focusAfterImage, imagePaste, imageTaken, imageToken, pastedImages, removeImage, takesImages, type ChatImage,
} from "../chat-images";
import { quoteDroppedPaths } from "../terminal-file-drop";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = (name = "image.png", type = "image/png", bytes: BlobPart = PNG, lastModified = 1_700_000_000_000) =>
  new File([bytes], name, { type, lastModified });

/** A clipboard as a browser lists it: items (each with getAsFile) and files. */
function clipboard({ items = [] as Array<{ kind: string; type: string; file?: File | null }>, files = [] as File[] } = {}) {
  return {
    items: items.map(item => ({ kind: item.kind, type: item.type, getAsFile: () => item.file ?? null })),
    files,
  };
}

describe("what one paste carries (pastedImages)", () => {
  it("a screenshot listed as an item and as a file is one picture, not two", () => {
    const shot = file();
    const pasted = pastedImages(clipboard({ items: [{ kind: "file", type: "image/png", file: shot }], files: [shot] }));
    expect(pasted).toEqual([shot]);
  });

  it("the same picture listed twice within one paste is kept once", () => {
    const pasted = pastedImages(clipboard({ items: [
      { kind: "file", type: "image/png", file: file() },
      { kind: "file", type: "image/png", file: file() },
    ] }));
    expect(pasted).toHaveLength(1);
  });

  it("two different pictures in one paste are both kept, in the clipboard's order", () => {
    const a = file("a.png");
    const b = file("b.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
    expect(pastedImages(clipboard({ items: [{ kind: "file", type: "image/png", file: a }, { kind: "file", type: "image/jpeg", file: b }] }))).toEqual([a, b]);
  });

  it("words, HTML and other files are not pictures", () => {
    const pasted = pastedImages(clipboard({
      items: [
        { kind: "string", type: "text/plain" },
        { kind: "string", type: "text/html" },
        { kind: "file", type: "application/pdf", file: file("doc.pdf", "application/pdf") },
      ],
      files: [file("doc.pdf", "application/pdf")],
    }));
    expect(pasted).toEqual([]);
  });

  it("reads the files when the items list none, as an older browser lists them", () => {
    const shot = file();
    expect(pastedImages(clipboard({ files: [shot] }))).toEqual([shot]);
    expect(pastedImages({ files: [shot] })).toEqual([shot]);
  });

  it("an item whose file cannot be had is skipped; no clipboard is no picture", () => {
    expect(pastedImages(clipboard({ items: [{ kind: "file", type: "image/png", file: null }] }))).toEqual([]);
    expect(pastedImages(null)).toEqual([]);
    expect(pastedImages(undefined)).toEqual([]);
  });
});

describe("what the box keeps (addImages, removeImage)", () => {
  it("adds after what is there, each with its own id", () => {
    const first = addImages([], [file("a.png")]);
    expect(first.refused).toBeNull();
    expect(first.images.map(image => image.id)).toEqual([1]);
    const second = addImages(first.images, [file("b.png"), file("c.png")]);
    expect(second.images.map(image => image.id)).toEqual([1, 2, 3]);
    expect(second.images[0]).toBe(first.images[0]);
  });

  it("takes the formats the agents read, and refuses any other with the reason", () => {
    expect(CHAT_IMAGE_TYPES).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const tiff = addImages([], [file("a.tiff", "image/tiff"), file("b.png")]);
    expect(tiff.refused).toBe("type");
    expect(tiff.images.map(image => (image.blob as File).name)).toEqual(["b.png"]);
  });

  it("refuses a picture over the deck's cap", () => {
    const big = { type: "image/png", size: MAX_CHAT_IMAGE_BYTES + 1 } as Blob;
    const added = addImages([], [big]);
    expect(added).toEqual({ images: [], refused: "size" });
  });

  it("keeps no more than a message carries, and says so", () => {
    const many = Array.from({ length: MAX_CHAT_IMAGES + 2 }, (_, i) => file(`${i}.png`));
    const added = addImages([], many);
    expect(added.images).toHaveLength(MAX_CHAT_IMAGES);
    expect(added.refused).toBe("count");
    expect(addImages(added.images, [file("more.png")]).refused).toBe("count");
  });

  it("removes the one named, and says where the focus goes after", () => {
    const images: ChatImage[] = [1, 2, 3].map(id => ({ id, blob: file(`${id}.png`) }));
    expect(removeImage(images, 2).map(image => image.id)).toEqual([1, 3]);
    expect(focusAfterImage(images, 2)).toBe(3);
    expect(focusAfterImage(images, 3), "the last: the one before it").toBe(2);
    expect(focusAfterImage(images.slice(0, 1), 1), "the only one: the box").toBeNull();
    expect(focusAfterImage(images, 9)).toBeNull();
  });
});

describe("into the session (imagePaste, imageTaken)", () => {
  const PATH = "/home/u/.local/share/ccdeck/chat-images/0123456789abcdef0123456789abcdef.png";

  it("pastes the path as Term pastes a dropped file, in the session's quoting", () => {
    expect(imagePaste(PATH, "Linux x86_64")).toBe(`'${PATH}' `);
    expect(imagePaste(PATH, "Linux x86_64")).toBe(quoteDroppedPaths([PATH], "Linux x86_64"));
    const mac = "/Users/o'neil/Library/Application Support/ccdeck/chat-images/ab.png";
    expect(imagePaste(mac, "macOS")).toBe("'/Users/o'\\''neil/Library/Application Support/ccdeck/chat-images/ab.png' ");
    expect(imagePaste("C:\\Users\\o'neil\\AppData\\Local\\ccdeck\\Data\\chat-images\\ab.png", "Windows"))
      .toBe("'C:\\Users\\o''neil\\AppData\\Local\\ccdeck\\Data\\chat-images\\ab.png' ");
    expect(imagePaste("relative.png", "Linux")).toBeNull();
    expect(imagePaste("/tmp/a\nb.png", "Linux")).toBeNull();
  });

  it("knows the file by its own name", () => {
    expect(imageToken(PATH)).toBe("0123456789abcdef0123456789abcdef");
    expect(imageToken("C:\\x\\Data\\chat-images\\abc.webp")).toBe("abc");
  });

  it("is taken once the screen shows one image placeholder more than before", () => {
    const token = imageToken(PATH);
    const before = "> [Image #1] what is this?\n\n╭──────╮\n│ >    │\n╰──────╯";
    expect(imageTaken(before, before, token), "the old one does not count").toBe(false);
    expect(imageTaken(before, before.replace("│ >    │", "│ > [Image #2] │"), token)).toBe(true);
    expect(imageTaken("", "│ > [image 1024x768 PNG] │", token), "Codex's own words for it").toBe(true);
  });

  it("is taken when the program kept the path as words, even wrapped over two rows", () => {
    const token = imageToken(PATH);
    const half = PATH.length - 20;
    expect(imageTaken("", `> '${PATH.slice(0, half)}\n${PATH.slice(half)}'`, token)).toBe(true);
  });

  it("is not taken while the screen shows neither", () => {
    expect(imageTaken("│ >  │", "│ >  │", imageToken(PATH))).toBe(false);
    expect(imageTaken("", "anything", "")).toBe(false);
  });

  it("waits long enough for a large picture to be read", () => {
    expect(IMAGE_TAKE_WAIT_MS).toBeGreaterThanOrEqual(5000);
  });

  it("Claude Code and Codex take pictures; an agent with no terminal does not", () => {
    expect(takesImages("claude")).toBe(true);
    expect(takesImages("codex")).toBe(true);
    expect(takesImages("opencode")).toBe(false);
    expect(takesImages("copilot")).toBe(false);
    expect(takesImages(undefined)).toBe(false);
  });
});
