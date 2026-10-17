import {
  dataChannelTopic,
  encodePeerMessage,
  reacjiMessage,
  type ReactionType,
} from "../peer-message.ts";
import type { NativeCall } from "./native-call.ts";

export type ReactionLoopOptions = {
  callIds: string[];
  emoji: string;
  type?: ReactionType;
  emojiUrl?: string;
  intervalMs: number;
  /** How many rounds to send; unset runs until stopped. */
  count?: number;
};

export type ReactionLoopState = {
  id: string;
  running: boolean;
  /** Rounds sent; each round goes to every huddle still connected. */
  rounds: number;
  count?: number;
  reason?: string;
};

/**
 * Sends a reaction to native huddles on a timer, on the server, so the timing
 * doesn't depend on the page or a request per message.
 */
export class ReactionLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private rounds = 0;
  private running = true;
  private reason?: string;
  private lastReport = 0;

  constructor(
    readonly id: string,
    private options: ReactionLoopOptions,
    private calls: Map<string, NativeCall>,
    private report: (state: ReactionLoopState) => void,
  ) {}

  start() {
    this.tick();
  }

  stop(reason = "stopped") {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.running = false;
    this.reason = reason;
    this.report(this.state());
  }

  state(): ReactionLoopState {
    return {
      id: this.id,
      running: this.running,
      rounds: this.rounds,
      count: this.options.count,
      reason: this.reason,
    };
  }

  private tick() {
    const targets = this.options.callIds
      .map((id) => this.calls.get(id))
      .filter(
        (call): call is NativeCall =>
          call !== undefined && call.status === "connected",
      );
    if (!targets.length) return this.stop("no connected huddles left");
    for (const call of targets) {
      try {
        call.send(
          dataChannelTopic,
          encodePeerMessage(
            reacjiMessage({
              emoji: this.options.emoji,
              type: this.options.type,
              emojiUrl: this.options.emojiUrl,
              fromPeerIdString: call.attendeeId,
            }),
          ),
        );
      } catch {
        // The huddle dropped between the check and the send; the next round
        // skips it.
      }
    }
    this.rounds++;
    if (this.options.count !== undefined && this.rounds >= this.options.count)
      return this.stop("done");
    // Progress goes to the page a few times a second, not every round.
    const now = Date.now();
    if (now - this.lastReport >= 250) {
      this.lastReport = now;
      this.report(this.state());
    }
    this.timer = setTimeout(() => this.tick(), this.options.intervalMs);
  }
}
