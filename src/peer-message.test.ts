import { describe, expect, test } from "bun:test";
import {
  decodePeerMessage,
  encodePeerMessage,
  reacjiMessage,
  stickyEmojiMessage,
} from "./peer-message.ts";

describe("PeerMessage", () => {
  test("encodes a GIF reacji with the URL in the emoji field", () => {
    const bytes = encodePeerMessage(
      reacjiMessage({
        emoji: "https://media.tenor.com/a.gif",
        type: "Gif",
        fromPeerIdString: "att",
      }),
    );
    // reacji (field 1) { emoji (1), type (2) = 3 }, fromPeerIdString (4)
    expect(bytes[0]).toBe(0x0a);
    expect(Buffer.from(bytes).toString("hex")).toContain("1003");
    expect(Buffer.from(bytes).toString("hex").endsWith("2203617474")).toBe(
      true,
    );
    expect(decodePeerMessage(bytes)).toEqual({
      reacji: { emoji: "https://media.tenor.com/a.gif", type: "Gif" },
      fromPeerIdString: "att",
    });
  });

  test("leaves the type out of a standard reacji, like Slack's client", () => {
    expect(
      reacjiMessage({
        emoji: ":tada:",
        type: "Standard",
        fromPeerIdString: "a",
      }),
    ).toEqual({ reacji: { emoji: ":tada:" }, fromPeerIdString: "a" });
  });

  test("round-trips a sticky emoji awareness broadcast", () => {
    const message = stickyEmojiMessage({
      channel: "C1",
      user: "U1",
      emoji: "speaker",
      fromPeerIdString: "a",
    });
    expect(decodePeerMessage(encodePeerMessage(message))).toEqual(message);
  });

  test("returns undefined for bytes that are not a PeerMessage", () => {
    expect(decodePeerMessage(new Uint8Array([0xff, 0xff, 0xff]))).toBe(
      undefined,
    );
  });
});
