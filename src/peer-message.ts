import {
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type JsonValue,
} from "@bufbuild/protobuf";
import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";

/**
 * `calls/client/peer_message.proto`, copied verbatim from the embedded file
 * descriptor in Slack's web client. Every huddle client sends and receives
 * these over the Chime data message topic `data-channel`.
 */
export const peerMessageFile = fileDesc(
  "Ch9jYWxscy9jbGllbnQvcGVlcl9tZXNzYWdlLnByb3RvIvISCgtQZWVyTWVzc2FnZRIjCgZyZWFjamkYASABKAsyEy5QZWVyTWVzc2FnZS5SZWFjamkSHwoEZHJhdxgCIAEoCzIRLlBlZXJNZXNzYWdlLkRyYXcSEgoKZnJvbVBlZXJJZBgDIAEoBBIYChBmcm9tUGVlcklkU3RyaW5nGAQgASgJEi8KDGNhcGFiaWxpdGllcxgFIAEoCzIZLlBlZXJNZXNzYWdlLkNhcGFiaWxpdGllcxIrCgpiYWNrZ3JvdW5kGAYgASgLMhcuUGVlck1lc3NhZ2UuQmFja2dyb3VuZBItCgttdXRlUmVxdWVzdBgKIAEoCzIYLlBlZXJNZXNzYWdlLk11dGVSZXF1ZXN0EjsKEmF3YXJlbmVzc0Jyb2FkY2FzdBgLIAEoCzIfLlBlZXJNZXNzYWdlLkF3YXJlbmVzc0Jyb2FkY2FzdBIzCg5hd2FyZW5lc3NRdWVyeRgMIAEoCzIbLlBlZXJNZXNzYWdlLkF3YXJlbmVzc1F1ZXJ5EjMKDmF3YXJlbmVzc0Nsb3NlGA0gASgLMhsuUGVlck1lc3NhZ2UuQXdhcmVuZXNzQ2xvc2USMwoOanVrZWJveFJlcXVlc3QYDiABKAsyGy5QZWVyTWVzc2FnZS5KdWtlYm94UmVxdWVzdBI9ChNjb250ZW50U2hhcmVEZXRhaWxzGA8gASgLMiAuUGVlck1lc3NhZ2UuQ29udGVudFNoYXJlRGV0YWlscxJLChpyZWNvcmRpbmdTdGFydE5vdGlmaWNhdGlvbhgQIAEoCzInLlBlZXJNZXNzYWdlLlJlY29yZGluZ1N0YXJ0Tm90aWZpY2F0aW9uEjcKEGtpY2tOb3RpZmljYXRpb24YEiABKAsyHS5QZWVyTWVzc2FnZS5LaWNrTm90aWZpY2F0aW9uEjkKEXRyYW5zY3JpcHRDYXRjaFVwGBEgASgLMh4uUGVlck1lc3NhZ2UuVHJhbnNjcmlwdENhdGNoVXAalwEKBlJlYWNqaRINCgVlbW9qaRgBIAEoCRImCgR0eXBlGAIgASgOMhguUGVlck1lc3NhZ2UuUmVhY2ppLlR5cGUSEAoIZW1vamlVcmwYAyABKAkiRAoEVHlwZRIZChVVbmtub3duX3JlYWN0aW9uX3R5cGUQABIKCgZFZmZlY3QQARIMCghTdGFuZGFyZBACEgcKA0dpZhADGh0KBVBvaW50EgkKAXgYASABKAESCQoBeRgCIAEoARqFAQoHU2VnbWVudBIdCgFhGAEgASgLMhIuUGVlck1lc3NhZ2UuUG9pbnQSHQoBYhgCIAEoCzISLlBlZXJNZXNzYWdlLlBvaW50Eh0KAWMYAyABKAsyEi5QZWVyTWVzc2FnZS5Qb2ludBIdCgFkGAQgASgLMhIuUGVlck1lc3NhZ2UuUG9pbnQa3wEKBERyYXcSJAoEdHlwZRgBIAEoDjIWLlBlZXJNZXNzYWdlLkRyYXcuVHlwZRIlCgdzZWdtZW50GAIgASgLMhQuUGVlck1lc3NhZ2UuU2VnbWVudBILCgNodWUYAyABKAUSDgoGaXRlbUlkGAQgASgJEgkKAXgYBSABKAESCQoBeRgGIAEoASJXCgRUeXBlEhUKEVVOS05PV05fRFJBV19UWVBFEAASBwoDTkVXEAESCAoERURJVBACEgcKA0VORBADEg4KCkNIQU5HRV9IVUUQBBIMCghQT1NJVElPThAFGiUKDENhcGFiaWxpdGllcxIVCg1pc0RyYXdFbmFibGVkGAEgASgIGjkKE0NvbnRlbnRTaGFyZURldGFpbHMSEgoKc291cmNlVHlwZRgBIAEoCRIOCgZpdGVtSWQYAiABKAkaGQoKQmFja2dyb3VuZBILCgN1cmwYASABKAkaHQoLTXV0ZVJlcXVlc3QSDgoGcGVlcklkGAEgASgJGi8KDkp1a2Vib3hSZXF1ZXN0Eg8KB3NvbmdLZXkYASABKAkSDAoEc3RvcBgCIAEoCBqWAQoaUmVjb3JkaW5nU3RhcnROb3RpZmljYXRpb24SOgoEdHlwZRgBIAEoDjIsLlBlZXJNZXNzYWdlLlJlY29yZGluZ1N0YXJ0Tm90aWZpY2F0aW9uLlR5cGUSFQoNcmVjb3JkaW5nVHlwZRgCIAEoCSIlCgRUeXBlEhAKDFVOS05PV05fVFlQRRAAEgsKB1NVTU1BUlkQARooChBLaWNrTm90aWZpY2F0aW9uEhQKDGtpY2tlZFVzZXJJZBgBIAEoCRqvAgoRVHJhbnNjcmlwdENhdGNoVXASMQoEdHlwZRgBIAEoDjIjLlBlZXJNZXNzYWdlLlRyYW5zY3JpcHRDYXRjaFVwLlR5cGUSKgoFbGluZXMYAiADKAsyGy5QZWVyTWVzc2FnZS5UcmFuc2NyaXB0TGluZRITCgtjaHVua19pbmRleBgDIAEoDRIUCgx0b3RhbF9jaHVua3MYBCABKA0SEgoKcmVxdWVzdF9pZBgFIAEoCRIoCiBlYXJsaWVzdF90cmFuc2NyaXB0X3RpbWVzdGFtcF9tcxgGIAEoBCJSCgRUeXBlEgsKB1NPTElDSVQQABIJCgVPRkZFUhABEhAKDFJFUVVFU1RfRlJPTRACEgwKCFJFU1BPTlNFEAMSEgoOUkVTUE9OU0VfQ0hVTksQBBpeCg5UcmFuc2NyaXB0TGluZRIPCgd1c2VyX2lkGAEgASgJEg8KB2NvbnRlbnQYAiABKAkSFQoNc3RhcnRfdGltZV9tcxgDIAEoBBITCgtlbmRfdGltZV9tcxgEIAEoBBpzChBBd2FyZW5lc3NQYXlsb2FkEhIKCmZpZWxkX25hbWUYASABKAkSEwoLZmllbGRfdmFsdWUYAiABKAkSHwoSZmllbGRfdGltZXN0YW1wX21zGAMgASgDSACIAQFCFQoTX2ZpZWxkX3RpbWVzdGFtcF9tcxpqChJBd2FyZW5lc3NCcm9hZGNhc3QSDwoHY2hhbm5lbBgBIAEoCRIMCgR1c2VyGAIgASgJEjUKDmF3YXJlbmVzc1N0YXRlGAMgAygLMh0uUGVlck1lc3NhZ2UuQXdhcmVuZXNzUGF5bG9hZBovCg5Bd2FyZW5lc3NRdWVyeRIPCgdjaGFubmVsGAEgASgJEgwKBHVzZXIYAiABKAkaLwoOQXdhcmVuZXNzQ2xvc2USDwoHY2hhbm5lbBgBIAEoCRIMCgR1c2VyGAIgASgJYgZwcm90bzM",
);

export const PeerMessage = messageDesc(peerMessageFile, 0);

/** Chime's topic for every PeerMessage Slack's clients exchange. */
export const dataChannelTopic = "data-channel";

/** Slack's transcript catch-up subscriber uses its own topic. */
export const transcriptCatchUpTopic = "transcript-catchup";

export const reactionTypes = ["Standard", "Effect", "Gif"] as const;
export type ReactionType = (typeof reactionTypes)[number];

/** Encodes a PeerMessage written in protobuf JSON form. */
export function encodePeerMessage(json: JsonValue) {
  return toBinary(PeerMessage, fromJson(PeerMessage, json));
}

/** Decodes a PeerMessage into protobuf JSON form, or undefined if it is not one. */
export function decodePeerMessage(bytes: Uint8Array) {
  try {
    return toJson(PeerMessage, fromBinary(PeerMessage, bytes), {
      alwaysEmitImplicit: false,
    });
  } catch {
    return undefined;
  }
}

export function reacjiMessage(options: {
  emoji: string;
  type?: ReactionType;
  emojiUrl?: string;
  fromPeerIdString: string;
}): JsonValue {
  return {
    reacji: {
      emoji: options.emoji,
      // Slack's client leaves the type out for a standard emoji.
      ...(options.type && options.type !== "Standard"
        ? { type: options.type }
        : {}),
      ...(options.emojiUrl ? { emojiUrl: options.emojiUrl } : {}),
    },
    fromPeerIdString: options.fromPeerIdString,
  };
}

/**
 * The sticky emoji on a participant's tile. Slack sends it as an awareness
 * field, not a reacji; an empty value clears it.
 */
export function stickyEmojiMessage(options: {
  channel: string;
  user: string;
  emoji: string;
  fromPeerIdString: string;
}): JsonValue {
  return {
    awarenessBroadcast: {
      channel: options.channel,
      user: options.user,
      awarenessState: [
        {
          fieldName: "stickyEmoji",
          fieldValue: options.emoji,
          fieldTimestampMs: String(Date.now()),
        },
      ],
    },
    fromPeerIdString: options.fromPeerIdString,
  };
}

export function emptyPeerMessage() {
  return toJson(PeerMessage, create(PeerMessage));
}
