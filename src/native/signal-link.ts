import {
  ChimeSignaling,
  type SignalFrame,
  type SignalingLog,
} from "./signaling.ts";
import { statusCodes } from "./status-codes.ts";

// A Chime attendee that only speaks signaling: JOIN, data messages, presence
// and LEAVE, with no WebRTC peer or audio. That is all a reaction needs, and
// it costs one WebSocket per huddle.

// AUDIO_STATUS values that end the session instead of reconnecting.
const terminalAudioStatus: Record<number, number> = {
  301: statusCodes.joinedFromAnotherDevice,
  302: statusCodes.disconnectAudio,
  403: statusCodes.authenticationRejected,
  409: statusCodes.atCapacity,
  410: statusCodes.meetingEnded,
  411: statusCodes.attendeeRemoved,
};

/** Signaling answers our pings, so this long without a frame means it's gone. */
const silenceLimitMs = 30_000;
/** How long to keep retrying a lost connection before giving up. */
const reconnectWindowMs = 120_000;

export type ChimeMeeting = { MediaPlacement: { SignalingUrl: string } };
export type ChimeAttendee = { AttendeeId: string; JoinToken: string };
export type DataMessage = {
  topic: string;
  data: Uint8Array;
  lifetimeMs?: number;
};

export type SignalLinkEvents = {
  log: SignalingLog;
  /** A signaling session is starting; presence is described afresh. */
  onSignaling(): void;
  onFrame(frame: SignalFrame): void;
  onConnected(reconnect: boolean): void;
  onReconnecting(reason: string): void;
  /** The session cannot continue; `code` is a MeetingSessionStatusCode. */
  onTerminal(code: number, reason: string): void;
};

class TerminalError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class SignalLink {
  readonly attendeeId: string;
  private signaling?: ChimeSignaling;
  private stopping = false;
  private reconnecting?: Promise<void>;
  private watchdog?: ReturnType<typeof setInterval>;
  private audioSessionId = Math.floor(Math.random() * 2 ** 32);

  constructor(
    private meeting: ChimeMeeting,
    private attendee: ChimeAttendee,
    private events: SignalLinkEvents,
  ) {
    this.attendeeId = attendee.AttendeeId;
  }

  async start() {
    this.signaling = await this.connect();
    this.watchdog = setInterval(() => this.checkSilence(), 2_000);
    this.events.onConnected(false);
  }

  /** Sends data messages in one frame; false if signaling isn't open. */
  send(messages: DataMessage[]) {
    return Boolean(
      this.signaling?.send("DATA_MESSAGE", {
        data_message: {
          messages: messages.map(({ topic, data, lifetimeMs }) => ({
            topic,
            data,
            lifetime_ms: lifetimeMs ?? 0,
          })),
        },
      }),
    );
  }

  async leave(timeoutMs = 3_000) {
    this.stopping = true;
    clearInterval(this.watchdog);
    const signaling = this.signaling;
    this.signaling = undefined;
    if (!signaling) return;
    if (signaling.send("LEAVE", { leave: {} }))
      await signaling.wait("LEAVE_ACK", timeoutMs).catch(() => {});
    signaling.close();
  }

  close() {
    this.stopping = true;
    clearInterval(this.watchdog);
    this.signaling?.close();
    this.signaling = undefined;
  }

  private async connect() {
    const signaling = new ChimeSignaling(
      this.meeting.MediaPlacement.SignalingUrl,
      this.attendee.JoinToken,
      this.events.log,
    );
    let terminal: TerminalError | undefined;
    // Listen before joining: Chime lists the attendees already here once,
    // right after JOIN.
    this.events.onSignaling();
    signaling.onFrame((frame) => this.events.onFrame(frame));
    signaling.onFrame((frame) => {
      const status = frame.audio_status?.audio_status;
      if (status !== undefined && terminalAudioStatus[status])
        terminal ??= new TerminalError(
          terminalAudioStatus[status],
          `Chime audio status ${status}`,
        );
    });
    try {
      await signaling.connect();
      signaling.join(this.audioSessionId);
      await signaling.wait("JOIN_ACK");
      if (terminal) throw terminal;
      this.watch(signaling);
      return signaling;
    } catch (error) {
      signaling.close();
      if (signaling.closeCode === 4410)
        throw new TerminalError(
          statusCodes.meetingEnded,
          "Chime meeting ended",
        );
      throw terminal ?? error;
    }
  }

  private watch(signaling: ChimeSignaling) {
    signaling.onFrame((frame) => {
      const status = frame.audio_status?.audio_status;
      if (status !== undefined && terminalAudioStatus[status])
        this.terminal(
          terminalAudioStatus[status],
          `Chime audio status ${status}`,
        );
    });
    signaling.onClose((code, reason) => {
      if (code === 4410)
        this.terminal(statusCodes.meetingEnded, "Chime meeting ended");
      else this.lost(signaling, `signaling closed ${code} ${reason}`);
    });
    signaling.startPings();
  }

  private checkSilence() {
    const signaling = this.signaling;
    if (!signaling) return;
    const silentMs = Date.now() - signaling.lastInboundAt;
    if (silentMs > silenceLimitMs)
      this.lost(signaling, `no signaling for ${silentMs} ms`);
  }

  private terminal(code: number, reason: string) {
    if (this.stopping) return;
    this.close();
    this.events.onTerminal(code, reason);
  }

  private lost(signaling: ChimeSignaling, reason: string) {
    if (this.stopping || this.signaling !== signaling) return;
    this.events.log("warn", "chime_connection_lost", "Chime connection lost", {
      reason,
    });
    this.events.onReconnecting(reason);
    signaling.close();
    this.signaling = undefined;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = undefined;
    });
  }

  // The JoinToken can be reused, which brings the same attendee back.
  private async reconnect() {
    const startedAt = Date.now();
    for (let attempt = 1; !this.stopping; attempt++) {
      try {
        const signaling = await this.connect();
        if (this.stopping) {
          signaling.close();
          return;
        }
        this.signaling = signaling;
        this.events.onConnected(true);
        return;
      } catch (error) {
        if (error instanceof TerminalError) {
          this.terminal(error.code, error.message);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (Date.now() - startedAt > reconnectWindowMs) {
          this.terminal(
            statusCodes.signalingClosedUnexpectedly,
            `Could not reconnect to Chime: ${message}`,
          );
          return;
        }
        await Bun.sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
  }
}
