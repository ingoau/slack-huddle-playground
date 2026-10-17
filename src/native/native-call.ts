import {
  ChimeLink,
  type ChimeAttendee,
  type ChimeMeeting,
} from "./chime-link.ts";
import type { AudioStreamIdInfoFull, SignalFrame } from "./signaling.ts";
import { statusCodes } from "./status-codes.ts";

export type NativeAttendee = {
  attendeeId: string;
  externalUserId?: string;
  present: boolean;
  volume: number;
  muted: boolean;
};

export type NativeCallInfo = {
  id: string;
  channelId: string;
  callId: string;
  attendeeId: string;
  meetingId: string;
  status: string;
  muted: boolean;
  attendees: NativeAttendee[];
};

export type NativeEvent =
  | { type: "status"; status: string }
  | { type: "attendee"; attendee: NativeAttendee }
  | {
      type: "data";
      topic: string;
      /** Base64. */
      data: string;
      senderAttendeeId: string;
      senderExternalUserId?: string;
      timestampMs: number;
    };

// DefaultVolumeIndicatorAdapter in amazon-chime-sdk-js maps a volume
// attenuation of -42 dB..-14 dB onto 0..1.
function normalizedVolume(attenuation: number) {
  return Math.min(1, Math.max(0, (-attenuation + 42) / 28));
}

// One 20 ms Opus frame of silence (a CELT-only TOC byte with an empty body).
const opusSilence = new Uint8Array([0xf8, 0xff, 0xfe]);

// Every native call sends silence on one shared 20 ms clock, so there is a
// steady audio stream for Chime without a timer per call.
const silent = new Set<ChimeLink>();
let silenceTimer: ReturnType<typeof setInterval> | undefined;
function sendSilence(link: ChimeLink, on: boolean) {
  if (on) silent.add(link);
  else silent.delete(link);
  if (silent.size && !silenceTimer)
    silenceTimer = setInterval(() => {
      for (const each of silent) each.sendAudio(opusSilence);
    }, 20);
  if (!silent.size && silenceTimer) {
    clearInterval(silenceTimer);
    silenceTimer = undefined;
  }
}

/**
 * A huddle joined straight from the server, without a browser or the Chime
 * SDK: HuddleFM's native Chime link, carrying silence and data messages.
 */
export class NativeCall {
  private link: ChimeLink;
  private streams = new Map<number, string>();
  private attendees = new Map<string, NativeAttendee>();
  status = "connecting";
  muted = true;

  constructor(
    readonly id: string,
    readonly channelId: string,
    readonly callId: string,
    readonly meeting: Record<string, unknown>,
    attendee: Record<string, unknown>,
    private emit: (event: NativeEvent) => void,
    log: (message: string) => void,
  ) {
    const meetingObject = (meeting.Meeting ?? meeting) as ChimeMeeting;
    const attendeeObject = (attendee.Attendee ?? attendee) as ChimeAttendee;
    this.link = new ChimeLink(meetingObject, attendeeObject, {
      log: (level, _event, message, fields) =>
        level !== "debug" &&
        log(`${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`),
      onSignaling: () => this.streams.clear(),
      onFrame: (frame) => this.frame(frame),
      onConnected: () => {
        sendSilence(this.link, true);
        this.setStatus("connected");
      },
      onReconnecting: () => this.setStatus("reconnecting"),
      onTerminal: (code, reason) => {
        sendSilence(this.link, false);
        this.setStatus(`ended (${code}: ${reason})`);
      },
    });
  }

  get attendeeId() {
    return this.link.attendeeId;
  }

  info(): NativeCallInfo {
    const meeting = (this.meeting.Meeting ?? this.meeting) as {
      MeetingId?: string;
    };
    return {
      id: this.id,
      channelId: this.channelId,
      callId: this.callId,
      attendeeId: this.attendeeId,
      meetingId: String(meeting.MeetingId ?? ""),
      status: this.status,
      muted: this.muted,
      attendees: [...this.attendees.values()],
    };
  }

  async start() {
    try {
      await this.link.start();
    } catch (error) {
      this.setStatus(
        `failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  send(topic: string, data: Uint8Array, lifetimeMs = 0) {
    if (!this.link.sendData(topic, data, lifetimeMs))
      throw new Error("This huddle's Chime connection is not open");
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.link.setMuted(muted);
  }

  async leave() {
    sendSilence(this.link, false);
    await this.link.leave();
    this.setStatus(`ended (${statusCodes.left}: left)`);
  }

  private setStatus(status: string) {
    this.status = status;
    this.emit({ type: "status", status });
  }

  private frame(frame: SignalFrame) {
    for (const stream of frame.audio_stream_id_info?.streams ?? [])
      this.streamInfo(stream);
    const states = frame.audio_metadata?.attendee_states;
    if (states?.some((state) => state.volume !== undefined)) {
      // A frame with volumes implies silence for everyone it leaves out.
      const levels = new Map<string, number>();
      for (const state of states) {
        const attendeeId = this.streams.get(state.audio_stream_id);
        if (attendeeId && state.volume !== undefined)
          levels.set(attendeeId, normalizedVolume(state.volume));
      }
      for (const attendee of this.attendees.values()) {
        const volume = levels.get(attendee.attendeeId) ?? 0;
        if (attendee.present && volume !== attendee.volume)
          this.update(attendee, { volume });
      }
    }
    for (const message of frame.data_message?.messages ?? []) {
      if (message.sender_attendee_id === this.attendeeId) continue;
      this.emit({
        type: "data",
        topic: message.topic ?? "",
        data: message.data ?? "",
        senderAttendeeId: message.sender_attendee_id ?? "",
        senderExternalUserId: message.sender_external_user_id,
        timestampMs: message.ingest_time_ns
          ? Math.round(message.ingest_time_ns / 1e6)
          : Date.now(),
      });
    }
  }

  // Follows the JS SDK: an entry with an attendee is a stream joining or
  // changing; one with only a stream ID and no mute state is a stream leaving.
  private streamInfo(stream: AudioStreamIdInfoFull) {
    if (stream.attendee_id) {
      this.streams.set(stream.audio_stream_id, stream.attendee_id);
      this.update(this.attendee(stream.attendee_id), {
        present: !stream.dropped,
        ...(stream.external_user_id
          ? { externalUserId: stream.external_user_id }
          : {}),
        ...(stream.muted !== undefined ? { muted: stream.muted } : {}),
      });
      return;
    }
    const attendeeId = this.streams.get(stream.audio_stream_id);
    if (!attendeeId) return;
    if (stream.muted !== undefined) {
      this.update(this.attendee(attendeeId), { muted: stream.muted });
      return;
    }
    this.streams.delete(stream.audio_stream_id);
    if (![...this.streams.values()].includes(attendeeId))
      this.update(this.attendee(attendeeId), { present: false, volume: 0 });
  }

  private attendee(attendeeId: string) {
    let attendee = this.attendees.get(attendeeId);
    if (!attendee) {
      attendee = { attendeeId, present: false, volume: 0, muted: false };
      this.attendees.set(attendeeId, attendee);
    }
    return attendee;
  }

  private update(attendee: NativeAttendee, change: Partial<NativeAttendee>) {
    Object.assign(attendee, change);
    this.emit({ type: "attendee", attendee: { ...attendee } });
  }
}
