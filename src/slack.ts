export type Credentials = {
  workspaceUrl: string;
  xoxc: string;
  xoxd: string;
};

export type ChimeJoin = {
  channelId: string;
  callId: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  /** The full Slack response, for poking at. */
  raw: Record<string, unknown>;
};

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Slack response is missing ${name}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value)
    throw new Error(`Slack response is missing ${name}`);
  return value;
}

function checked(method: string, result: Record<string, unknown>) {
  if (result.ok !== true)
    throw new Error(
      `${method} failed: ${String(result.error ?? "unknown_error")}`,
    );
  return result;
}

/** Accepts `acme`, `acme.slack.com` or a full URL. */
export function normalizeWorkspaceUrl(input: string) {
  let value = input.trim();
  if (!value) throw new Error("Workspace URL is required");
  if (!value.includes(".")) value = `${value}.slack.com`;
  if (!/^https?:\/\//.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com"))
    throw new Error("Workspace URL must be a https://*.slack.com address");
  return url.origin;
}

// Chime rejects an explicit null for MeetingFeatures.
function chimeMeeting(value: unknown, name: string) {
  const meeting = { ...object(value, name) };
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;
  return meeting;
}

export function normalizeJoinResponse(
  raw: unknown,
  channelId: string,
): ChimeJoin {
  const root = checked("rooms.join", object(raw, "response"));
  const call = object(root.call, "call");
  const freeWilly = object(call.free_willy, "call.free_willy");
  return {
    channelId,
    callId: text(call.call_id, "call.call_id"),
    meeting: chimeMeeting(freeWilly.meeting, "call.free_willy.meeting"),
    attendee: object(freeWilly.attendee, "call.free_willy.attendee"),
    raw: root,
  };
}

export function normalizeInviteJoin(
  roomInfo: unknown,
  channelId: string,
  callId: string,
  freeWilly: unknown,
): ChimeJoin {
  const root = checked(
    "screenhero.rooms.info",
    object(roomInfo, "screenhero.rooms.info response"),
  );
  const room = object(root.room, "room");
  if (room.id !== callId)
    throw new Error("screenhero.rooms.info returned the wrong huddle");
  const willy = object(freeWilly, "free_willy");
  return {
    channelId,
    callId,
    meeting: chimeMeeting(willy.meeting, "free_willy.meeting"),
    attendee: object(willy.attendee, "free_willy.attendee"),
    raw: root,
  };
}

// Fields the Slack desktop client sends alongside its own API calls.
function clientFields(reason: string) {
  return {
    _x_reason: reason,
    _x_mode: "online",
    _x_sonic: "true",
    _x_app_name: "client",
  };
}

export class SlackClient {
  constructor(readonly credentials: Credentials) {}

  /** Calls any Web API method as the user, the way Slack's own client does. */
  async call(method: string, fields: Record<string, string> = {}) {
    if (!/^[a-zA-Z0-9_.]+$/.test(method))
      throw new Error(`Invalid Slack method: ${method}`);
    const form = new FormData();
    form.set("token", this.credentials.xoxc);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const response = await fetch(
      new URL(`/api/${method}`, this.credentials.workspaceUrl),
      {
        method: "POST",
        headers: { cookie: `d=${this.credentials.xoxd}` },
        body: form,
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = await response.text();
    try {
      return object(JSON.parse(body), method);
    } catch {
      throw new Error(
        `${method} HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }
  }

  async authTest() {
    const result = checked("auth.test", await this.call("auth.test"));
    return {
      userId: text(result.user_id, "user_id"),
      teamId: text(result.team_id, "team_id"),
      user: String(result.user ?? ""),
      team: String(result.team ?? ""),
      url: String(result.url ?? ""),
      enterpriseId:
        typeof result.enterprise_id === "string"
          ? result.enterprise_id
          : undefined,
    };
  }

  /** Starts a huddle in the channel, or joins the one already running. */
  async join(channelId: string, region: string) {
    const raw = await this.call("rooms.join", {
      channel_id: channelId,
      regions: region,
      multidevice: "true",
    });
    return normalizeJoinResponse(raw, channelId);
  }

  /** Accepts a `huddle_invite`, whose event already carries the Chime meeting. */
  async joinInvite(channelId: string, callId: string, freeWilly: unknown) {
    const info = await this.roomInfo(callId);
    return normalizeInviteJoin(info, channelId, callId, freeWilly);
  }

  roomInfo(callId: string) {
    return this.call("screenhero.rooms.info", {
      room: callId,
      ...clientFields("all-calls-store/conditional-fetch"),
    });
  }

  leave(channelId: string, callId: string, attendeeId?: string) {
    return this.call("rooms.leave", {
      channel_id: channelId,
      call_id: callId,
      ...(attendeeId ? { attendee_id: attendeeId } : {}),
    });
  }

  declineInvite(channelId: string, callId: string) {
    return this.call("rooms.inviteResponse", {
      response: "decline",
      channel_id: channelId,
      room_id: callId,
      _x_reason: "respond-to-huddle-invite",
    });
  }

  /** The URL of the realtime gateway Slack's desktop client connects to. */
  gatewayUrl(teamOrEnterpriseId: string) {
    const url = new URL("wss://wss-primary.slack.com/");
    const params = {
      token: this.credentials.xoxc,
      sync_desync: "1",
      slack_client: "desktop",
      start_args:
        "?agent=client&org_wide_aware=true&eac_cache_ts=true&cache_ts=0&name_tagging=true&only_self_subteams=true&connect_only=true&ms_latest=true",
      no_query_on_subscribe: "1",
      flannel: "3",
      lazy_channels: "1",
      gateway_server: `T${teamOrEnterpriseId.slice(1)}-1`,
      enterprise_id: teamOrEnterpriseId,
      batch_presence_aware: "1",
    };
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return url;
  }
}

/**
 * Keeps the user's realtime socket open and hands every event to `onEvent`.
 * Reconnects with backoff until stopped.
 */
export class RealtimeConnection {
  private socket?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopped = false;
  private reconnectUrl?: string;

  constructor(
    private client: SlackClient,
    private gatewayId: string,
    private onEvent: (event: Record<string, unknown>) => void,
    private onStatus: (status: string) => void,
  ) {}

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect() {
    const url = this.reconnectUrl
      ? new URL(this.reconnectUrl)
      : this.client.gatewayUrl(this.gatewayId);
    this.onStatus("connecting");
    const socket = new WebSocket(url, {
      headers: { cookie: `d=${this.client.credentials.xoxd}` },
    } as never);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "hello") {
        this.attempts = 0;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(
          () => socket.send(JSON.stringify({ type: "ping", id: Date.now() })),
          5_000,
        );
        this.onStatus("connected");
      }
      if (message.type === "reconnect_url" && typeof message.url === "string")
        this.reconnectUrl = message.url;
      if (message.type === "pong") return;
      this.onEvent(message);
    });
    socket.addEventListener("close", () => {
      clearInterval(this.pingTimer);
      if (this.stopped || this.socket !== socket) return;
      const delay = Math.min(30_000, 1_000 * 2 ** this.attempts++);
      this.onStatus(`disconnected, retrying in ${delay / 1000}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }
}
