// Pictures in Chat's box: a paste that carries one adds a thumbnail with its
// own remove button and leaves the words to the textarea; Send hands the
// draft and its pictures over together and clears both only once they went;
// a send that failed keeps both for another try; and an agent that takes no
// picture from Chat says so, with the way to Term where Term takes it.
//
// The pure half (what one paste carries, the quoting, the screen) is in
// chat-images.test.ts; the deck's half in chat-image.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer, { type ChatComposerProps, type ChatSendResult } from "../components/chat/ChatComposer";
import { MAX_CHAT_IMAGES, type ChatImage } from "../chat-images";
import { chatShown, pendingFor, type ChatFacts } from "../chat-progress";
import { OutgoingMessage } from "../components/chat/ChatTurn";
import { setLanguage } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { setLanguage("en"); vi.unstubAllGlobals(); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shot = (name = "image.png", type = "image/png") => new File([PNG], name, { type, lastModified: 1_700_000_000_000 });

/** A paste event as the browser hands it: its clipboard, and preventDefault. */
function pasteEvent({ files = [] as File[], text = "", twice = false } = {}) {
  const items = [
    ...(text ? [{ kind: "string", type: "text/plain", getAsFile: () => null }] : []),
    ...files.map(f => ({ kind: "file", type: f.type, getAsFile: () => f })),
  ];
  return {
    clipboardData: { items, files: twice ? files : [], getData: (type: string) => (type === "text/plain" ? text : "") },
    preventDefault: vi.fn(),
  };
}

function rig(initial: Partial<ChatComposerProps> = {}) {
  let finish: (result: ChatSendResult) => void = () => {};
  const onSendImages = vi.fn<NonNullable<ChatComposerProps["onSendImages"]>>(() => new Promise(resolve => { finish = resolve; }));
  const onSend = vi.fn<ChatComposerProps["onSend"]>(() => "sent");
  const onChange = vi.fn((value: string) => { props = { ...props, value }; view.rerender(props); });
  const onImagesChange = vi.fn((images: ChatImage[]) => { props = { ...props, images }; view.rerender(props); });
  const onShowTerm = vi.fn();
  let props: ChatComposerProps = { value: "", onSend, onChange, images: [], onImagesChange, onSendImages, imagesInTerm: true, onShowTerm, ...initial };
  const view = mount(ChatComposer, props);
  const element = (type: string) => one(view.tree, el => el.type === type)!;
  const invoke = (el: Drawn, name: string, event: unknown = {}) => (el.props[name] as (event: unknown) => void)(event);
  return {
    view, onSend, onSendImages, onChange, onImagesChange, onShowTerm,
    get props() { return props; },
    finish: (result: ChatSendResult) => finish(result),
    paste(options: Parameters<typeof pasteEvent>[0]) { const event = pasteEvent(options); invoke(element("textarea"), "onPaste", event); return event; },
    edit(value: string) { invoke(element("textarea"), "onChange", { currentTarget: { value } }); },
    submit() { invoke(element("form"), "onSubmit", { preventDefault: vi.fn() }); },
    textarea: () => element("textarea"),
    chips: () => all(view.tree, el => el.props.className === "chat-image"),
    thumbs: () => all(view.tree, el => el.props.className === "chat-image-thumb"),
    removes: () => all(view.tree, el => el.props.className === "chat-image-remove"),
    status: () => one(view.tree, el => el.props.role === "status")!,
    send: () => one(view.tree, el => el.props.type === "submit"),
    stop: () => one(view.tree, el => el.props.className === "btn chat-composer-stop"),
    term: () => one(view.tree, el => el.props.className === "chat-composer-term"),
  };
}

describe("a paste that carries a picture", () => {
  it("adds it as a thumbnail with a remove button, and types nothing", () => {
    const r = rig();
    const event = r.paste({ files: [shot()] });
    expect(event.preventDefault, "a picture alone is the box's, not the textarea's").toHaveBeenCalledOnce();
    expect(r.onImagesChange).toHaveBeenCalledOnce();
    expect(r.props.images).toHaveLength(1);
    expect(r.onChange).not.toHaveBeenCalled();
    expect(r.chips()).toHaveLength(1);
    const remove = r.removes()[0];
    expect(remove.type).toBe("button");
    expect(remove.props.type).toBe("button");
    expect(remove.props["aria-label"]).toBe("Remove image 1");
    expect(one(r.view.tree, el => el.props.className === "chat-images")!.props["aria-label"]).toBe("Images to send");
    r.view.unmount();
  });

  it("draws the thumbnail from the picture's own bytes in memory, and lets the URL go with it", () => {
    const made: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => { made.push(blob); return `blob:local/${made.length}`; },
      revokeObjectURL: (url: string) => { revoked.push(url); },
    });
    const r = rig();
    r.paste({ files: [shot()] });
    expect(made).toEqual([r.props.images![0].blob]);
    expect(r.thumbs()[0].type).toBe("img");
    expect(r.thumbs()[0].props.src).toBe("blob:local/1");
    expect(r.thumbs()[0].props.alt).toBe("Pasted image 1");
    (r.removes()[0].props.onClick as () => void)();
    expect(revoked).toEqual(["blob:local/1"]);
    expect(r.chips()).toHaveLength(0);
    r.view.unmount();
  });

  it("listed as an item and as a file, it is one picture", () => {
    const r = rig();
    const picture = shot();
    r.paste({ files: [picture], twice: true });
    expect(r.props.images).toHaveLength(1);
    r.view.unmount();
  });

  it("with words beside it: the words are the textarea's to type, and the picture is added", () => {
    const r = rig({ value: "before " });
    const event = r.paste({ files: [shot()], text: "the words" });
    expect(event.preventDefault, "the browser types the words, as for any paste").not.toHaveBeenCalled();
    expect(r.props.images).toHaveLength(1);
    // The browser's own typing of the words, as it reaches the composer.
    r.edit("before the words");
    expect(r.onChange).toHaveBeenLastCalledWith("before the words");
    expect(r.props.images, "typing keeps the picture").toHaveLength(1);
    r.view.unmount();
  });

  it("words alone are a paste like any other: nothing added, nothing prevented", () => {
    const r = rig();
    const event = r.paste({ text: "just words" });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(r.onImagesChange).not.toHaveBeenCalled();
    expect(r.chips()).toHaveLength(0);
    r.view.unmount();
  });

  it("pasted again, the same picture is added again: each paste is its own", () => {
    const r = rig();
    r.paste({ files: [shot()] });
    r.paste({ files: [shot()] });
    expect(r.props.images!.map(image => image.id)).toEqual([1, 2]);
    expect(r.removes().map(button => button.props["aria-label"])).toEqual(["Remove image 1", "Remove image 2"]);
    r.view.unmount();
  });

  it("removes only the one pressed", () => {
    const r = rig();
    r.paste({ files: [shot("a.png"), shot("b.png"), shot("c.png")] });
    (r.removes()[1].props.onClick as () => void)();
    expect(r.props.images!.map(image => (image.blob as File).name)).toEqual(["a.png", "c.png"]);
    r.view.unmount();
  });

  it("refuses a format the agents do not read, and more than a message carries, and says why", () => {
    const r = rig();
    r.paste({ files: [shot("a.tiff", "image/tiff")] });
    expect(r.props.images).toHaveLength(0);
    expect(textOf(r.status())).toBe("Only PNG, JPEG, GIF and WebP images can be attached.");
    expect(r.status().props["data-result"]).toBe("image-type");
    r.paste({ files: Array.from({ length: MAX_CHAT_IMAGES + 1 }, (_, i) => shot(`${i}.png`)) });
    expect(r.props.images).toHaveLength(MAX_CHAT_IMAGES);
    expect(textOf(r.status())).toBe(`A message can carry up to ${MAX_CHAT_IMAGES} images.`);
    r.view.unmount();
  });
});

describe("Send with pictures", () => {
  it("is offered for pictures alone, and is Send rather than Stop while the agent works", () => {
    const r = rig({ canStop: true, onStop: vi.fn() });
    expect(r.stop()).not.toBeNull();
    r.paste({ files: [shot()] });
    expect(r.stop()).toBeNull();
    expect(r.send()!.props.disabled).toBe(false);
    r.view.unmount();
  });

  it("hands the words and the pictures over together, holds the box meanwhile, and clears both once sent", async () => {
    const r = rig();
    r.paste({ files: [shot()] });
    r.edit("what is wrong here?");
    const pictures = r.props.images;
    r.submit();
    expect(r.onSendImages).toHaveBeenCalledWith("what is wrong here?", pictures);
    expect(r.onSend, "the words never go without their pictures").not.toHaveBeenCalled();
    expect(r.send()!.props.disabled, "a press never disables the control it came from").toBe(false);
    expect(r.send()!.props["aria-busy"]).toBe(true);
    expect(r.textarea().props.readOnly).toBe(true);
    expect(r.removes()[0].props["aria-disabled"]).toBe(true);
    (r.removes()[0].props.onClick as () => void)();
    expect(r.props.images, "nothing is removed while they are on their way").toBe(pictures);
    expect(textOf(r.status())).toBe("Sending…");
    r.submit();
    expect(r.onSendImages, "a second press while one is out asks nothing").toHaveBeenCalledOnce();
    r.finish("sent");
    await flush();
    expect(r.onChange).toHaveBeenLastCalledWith("");
    expect(r.onImagesChange).toHaveBeenLastCalledWith([]);
    expect(r.chips()).toHaveLength(0);
    expect(textOf(r.status())).toBe("");
    expect(r.textarea().props.readOnly).toBeUndefined();
    r.view.unmount();
  });

  it.each<[ChatSendResult, RegExp]>([
    ["images-failed", /couldn’t be handed to the session.*Your message and images are kept/],
    ["unavailable", /Your draft is kept; check Term/],
    ["partial", /Check Term before sending again/],
  ])("a send that ends %s keeps the words and the pictures, and a retry sends the same again", async (outcome, said) => {
    const r = rig({ value: "look" });
    r.paste({ files: [shot()] });
    const pictures = r.props.images;
    r.submit();
    r.finish(outcome);
    await flush();
    expect(r.props.value).toBe("look");
    expect(r.props.images).toBe(pictures);
    expect(r.onImagesChange, "only the paste changed them").toHaveBeenCalledOnce();
    expect(textOf(r.status())).toMatch(said);
    expect(r.chips()).toHaveLength(1);
    r.submit();
    expect(r.onSendImages).toHaveBeenCalledTimes(2);
    expect(r.onSendImages.mock.calls[1]).toEqual(["look", pictures]);
    r.view.unmount();
  });

  it("a send that throws is a send that did not go", async () => {
    const r = rig({ value: "look" });
    r.onSendImages.mockImplementation(async () => { throw new Error("socket closed"); });
    r.paste({ files: [shot()] });
    r.submit();
    await flush();
    expect(r.props.value).toBe("look");
    expect(r.props.images).toHaveLength(1);
    expect(textOf(r.status())).toContain("Your draft is kept");
    r.view.unmount();
  });
});

describe("an agent that takes no picture from Chat", () => {
  it("says so, adds nothing, and offers Term where Term takes it", () => {
    const r = rig({ onSendImages: undefined, provider: "codex", imagesInTerm: true });
    const event = r.paste({ files: [shot()] });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(r.onImagesChange).not.toHaveBeenCalled();
    expect(textOf(r.status())).toBe("Codex can’t take images from Chat. Paste the image in Term instead.");
    expect(textOf(r.term())).toBe("Show Term");
    (r.term()!.props.onClick as () => void)();
    expect(r.onShowTerm).toHaveBeenCalledOnce();
    r.view.unmount();
  });

  it("says only that where Term takes none either", () => {
    const r = rig({ onSendImages: undefined, imagesInTerm: false });
    r.paste({ files: [shot()], text: "words stay" });
    expect(textOf(r.status())).toBe("Claude Code can’t take images from Chat.");
    expect(r.term()).toBeNull();
    r.view.unmount();
  });
});

describe("the message on its way, with pictures", () => {
  const facts: ChatFacts = { turns: [], prompts: 3, state: "idle", connected: true, asked: false };

  it("counts the pictures beside the words, until the session takes it", () => {
    const pending = pendingFor("look", facts, 0, { images: 2 });
    expect(chatShown(pending, facts, 1).outgoing).toEqual({ text: "look", state: "sending", images: 2 });
    expect(chatShown(pendingFor("look", facts, 0), facts, 1).outgoing, "none: as before").toEqual({ text: "look", state: "sending" });
  });

  it("draws the pictures' chip, and no empty bubble for pictures sent alone", () => {
    const alone = mount(OutgoingMessage, { outgoing: { text: "", state: "sending", images: 1 } }).tree;
    expect(one(alone, el => el.props.className === "chat-you-text")).toBeNull();
    expect(textOf(one(alone, el => el.props.className === "chat-you-images"))).toBe("1 image");
    const both = mount(OutgoingMessage, { outgoing: { text: "look", state: "sending", images: 2 } }).tree;
    expect(textOf(one(both, el => el.props.className === "chat-you-text"))).toBe("look");
    expect(textOf(one(both, el => el.props.className === "chat-you-images"))).toBe("2 images");
  });
});

describe("the words for it", () => {
  it("are said in every board language, with their placeholders", () => {
    const keys: Record<string, string[]> = {
      "board.chat.compose.image.list": [], "board.chat.compose.image.alt": ["{n}"], "board.chat.compose.image.remove": ["{n}"],
      "board.chat.compose.image.type": [], "board.chat.compose.image.size": ["{mb}"], "board.chat.compose.image.count": ["{max}"],
      "board.chat.compose.image.unsupported": ["{agent}"], "board.chat.compose.image.useTerm": ["{agent}"], "board.chat.compose.image.failed": [],
    };
    const boards = AREA_FILES.filter(a => a.area === "board");
    expect(boards).toHaveLength(10);
    for (const { code, catalog } of boards) {
      for (const [key, marks] of Object.entries(keys)) {
        expect(catalog[key], `${code}: ${key}`).toBeTruthy();
        for (const mark of marks) expect(catalog[key], `${code}: ${key}`).toContain(mark);
      }
    }
  });
});
