import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
  type DataMessage,
  type MeetingSessionStatus,
} from "amazon-chime-sdk-js";
import type { JsonValue } from "@bufbuild/protobuf";
import {
  dataChannelTopic,
  decodePeerMessage,
  emptyPeerMessage,
  encodePeerMessage,
  reacjiMessage,
  stickyEmojiMessage,
  transcriptCatchUpTopic,
  type ReactionType,
} from "./peer-message.ts";

// Chime refuses data messages over 2 KiB.
const maxDataMessageBytes = 2048;
// Topics whose payloads are PeerMessages in Slack's client.
const peerTopics = new Set([dataChannelTopic, transcriptCatchUpTopic]);

const quickEmoji = [
  ":+1:",
  ":joy:",
  ":tada:",
  ":heart:",
  ":fire:",
  ":clap:",
  ":eyes:",
  ":wave:",
  ":100:",
  ":raised_hands:",
];
// Effect names from the huddle emoji picker in Slack's web client.
const quickEffects = [
  "gong",
  "gongg",
  "moneybag",
  "microphone",
  "musical_note",
  "duck",
  "gavel",
  "snowball",
  "gift",
  "slackvot",
  "mummy",
  "zombie_puffy",
  "spider",
  "jack_o_lantern",
  "unicorn_face",
];
const quickSticky = [
  "speaker",
  "raised_hand",
  "coffee",
  "headphones",
  "brb",
  "eyes",
];

type ChimeJoin = {
  channelId: string;
  callId: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type ServerState = {
  connected: boolean;
  workspaceUrl?: string;
  identity?: { userId: string; teamId: string; user: string; team: string };
  realtimeStatus: string;
};

type Attendee = {
  attendeeId: string;
  externalUserId?: string;
  present: boolean;
  volume: number;
  muted: boolean;
  signal: number;
  element: HTMLLIElement;
};

function $<T extends HTMLElement = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
) {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = isError ? "toast error" : "toast";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), isError ? 6000 : 2500);
}

async function post<T = Record<string, unknown>>(path: string, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    " ",
  );
}

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function hexToBytes(hex: string) {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  if (clean.length % 2) throw new Error("Hex needs an even number of digits");
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) =>
    parseInt(pair, 16),
  );
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0));
}

/** Text if the bytes are printable UTF-8, otherwise undefined. */
function printable(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /^[\P{Cc}\n\r\t]*$/u.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- state

/** One joined huddle, with its own Chime session and audio. */
type Call = {
  /** Local ID; the same huddle can be joined more than once. */
  id: string;
  join: ChimeJoin;
  session: DefaultMeetingSession;
  selfAttendeeId: string;
  status: string;
  attendees: Map<string, Attendee>;
  micMuted: boolean;
  usingMic: boolean;
  speakerMuted: boolean;
  audio: HTMLAudioElement;
  /** The channel's name once Slack tells us. */
  channelName: string;
  /** Which connection to this huddle this is, from 1. */
  copy: number;
};

function callLabel(call: Call) {
  return call.copy > 1
    ? `${call.channelName} (${call.copy})`
    : call.channelName;
}

let server: ServerState = { connected: false, realtimeStatus: "offline" };
let micStream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
const calls = new Map<string, Call>();
let selectedCallId: string | undefined;
let nextCallId = 1;
// Huddles the Send card is aimed at; new joins are added.
const sendTargets = new Set<string>();
const topics = new Set([dataChannelTopic, transcriptCatchUpTopic]);
const userNames = new Map<string, Promise<string | undefined>>();
const invites = new Map<string, Record<string, unknown>>();

function selectedCall() {
  return selectedCallId ? calls.get(selectedCallId) : undefined;
}

// ---------------------------------------------------------------- header

function renderPills() {
  const slack = $("#slack-pill");
  slack.textContent = server.connected
    ? `Slack: ${server.identity?.user ?? "connected"}`
    : "Slack: offline";
  slack.className = server.connected ? "pill ok" : "pill";

  const rtm = $("#rtm-pill");
  rtm.textContent = `Realtime: ${server.realtimeStatus}`;
  rtm.className =
    server.realtimeStatus === "connected"
      ? "pill ok"
      : server.connected
        ? "pill warn"
        : "pill";

  const huddles = $("#call-pill");
  const connected = [...calls.values()].filter(
    (call) => call.status === "connected",
  ).length;
  huddles.textContent = calls.size
    ? `Huddles: ${connected}/${calls.size} connected`
    : "Huddles: none";
  huddles.className = !calls.size
    ? "pill"
    : connected === calls.size
      ? "pill ok"
      : "pill warn";
}

function renderIdentity() {
  const identity = server.identity;
  $("#identity").textContent = identity
    ? `Signed in as ${identity.user} (${identity.userId}) on ${identity.team} (${identity.teamId})`
    : "";
}

// ---------------------------------------------------------------- connect

const connectForm = $<HTMLFormElement>("#connect-form");
const rememberKey = "huddle-playground:credentials";

function restoreCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(rememberKey) ?? "null");
    if (!saved) return;
    for (const name of ["workspaceUrl", "xoxc", "xoxd"]) {
      const input = connectForm.elements.namedItem(name) as HTMLInputElement;
      if (typeof saved[name] === "string") input.value = saved[name];
    }
    (connectForm.elements.namedItem("remember") as HTMLInputElement).checked =
      true;
  } catch {}
}

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(connectForm);
  const credentials = {
    workspaceUrl: String(data.get("workspaceUrl")),
    xoxc: String(data.get("xoxc")),
    xoxd: String(data.get("xoxd")),
  };
  try {
    if (data.get("remember"))
      localStorage.setItem(rememberKey, JSON.stringify(credentials));
    else localStorage.removeItem(rememberKey);
  } catch {}
  const button = connectForm.querySelector("button[type=submit]")!;
  (button as HTMLButtonElement).disabled = true;
  try {
    server = await post<ServerState>("/api/connect", credentials);
    renderPills();
    renderIdentity();
    toast(`Connected as ${server.identity?.user}`);
  } catch (error) {
    toast(`Could not connect: ${errorMessage(error)}`, true);
  } finally {
    (button as HTMLButtonElement).disabled = false;
  }
});

$("#disconnect").addEventListener("click", async () => {
  await Promise.all([...calls.values()].map((call) => leave(call)));
  server = await post<ServerState>("/api/disconnect");
  renderPills();
  renderIdentity();
});

// ---------------------------------------------------------------- names

/** Slack user IDs look like U… or W…; Chime external IDs may embed one. */
function slackUserId(externalUserId?: string) {
  return externalUserId?.match(/\b[UW][A-Z0-9]{6,}\b/)?.[0];
}

function userName(userId: string) {
  let name = userNames.get(userId);
  if (!name) {
    name = post<{ user?: { real_name?: string; name?: string } }>(
      "/api/slack",
      { method: "users.info", fields: { user: userId } },
    )
      .then((result) => result.user?.real_name || result.user?.name)
      .catch(() => undefined);
    userNames.set(userId, name);
  }
  return name;
}

function describeAttendee(
  call: Call,
  attendeeId: string,
  externalUserId?: string,
) {
  if (attendeeId === call.selfAttendeeId) return "you";
  const known = call.attendees.get(attendeeId);
  return slackUserId(externalUserId ?? known?.externalUserId) ?? attendeeId;
}

// ---------------------------------------------------------------- huddle

const joinForm = $<HTMLFormElement>("#join-form");
joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(joinForm);
  const count = Math.max(1, Math.min(20, Number(data.get("count")) || 1));
  // One at a time, so each rooms.join sees the previous connection.
  for (let i = 0; i < count; i++)
    await joinWith(() =>
      post<ChimeJoin>("/api/join", {
        channelId: String(data.get("channelId")).trim(),
        region: String(data.get("region")),
      }),
    );
});

let joining = 0;
async function joinWith(request: () => Promise<ChimeJoin>) {
  joining++;
  renderCalls();
  try {
    await startChime(await request());
  } catch (error) {
    toast(`Could not join: ${errorMessage(error)}`, true);
  } finally {
    joining--;
    renderCalls();
  }
}

function silentStream() {
  audioContext ??= new AudioContext();
  return audioContext.createMediaStreamDestination().stream;
}

async function startChime(join: ChimeJoin) {
  const logger = new ConsoleLogger("Playground", LogLevel.WARN);
  const configuration = new MeetingSessionConfiguration(
    join.meeting,
    join.attendee,
  );
  const session = new DefaultMeetingSession(
    configuration,
    logger,
    new DefaultDeviceController(logger),
  );
  const audio = el("audio", { autoplay: true });
  document.body.append(audio);
  const siblings = [...calls.values()].filter(
    (other) => other.join.callId === join.callId,
  );
  const call: Call = {
    id: String(nextCallId++),
    join,
    session,
    selfAttendeeId: configuration.credentials?.attendeeId ?? "",
    status: "connecting",
    attendees: new Map(),
    micMuted: true,
    usingMic: false,
    speakerMuted: false,
    audio,
    channelName: siblings[0]?.channelName ?? join.channelId,
    copy: Math.max(0, ...siblings.map((other) => other.copy)) + 1,
  };
  // Chime allows one connection per attendee, so a repeat attendee would
  // knock the earlier connection out.
  if (siblings.some((other) => other.selfAttendeeId === call.selfAttendeeId))
    toast(
      "Slack reused an attendee ID, so the earlier connection will likely drop",
      true,
    );
  calls.set(call.id, call);
  selectedCallId = call.id;
  sendTargets.add(call.id);
  void post<{ channel?: { name?: string } }>("/api/slack", {
    method: "conversations.info",
    fields: { channel: join.channelId },
  })
    .then((result) => {
      if (result.channel?.name) call.channelName = `#${result.channel.name}`;
      renderCalls();
    })
    .catch(() => {});

  const audioVideo = session.audioVideo;
  audioVideo.addObserver({
    audioVideoDidStart: () => {
      call.status = "connected";
      renderCalls();
      toast(`Joined ${callLabel(call)}`);
    },
    audioVideoDidStartConnecting: (reconnecting) => {
      call.status = reconnecting ? "reconnecting" : "connecting";
      renderCalls();
    },
    audioVideoDidStop: (status: MeetingSessionStatus) => {
      call.status = `ended (${status.statusCode()})`;
      renderCalls();
    },
  });

  audioVideo.realtimeSubscribeToAttendeeIdPresence(
    (attendeeId, present, externalUserId) =>
      updatePresence(call, attendeeId, present, externalUserId),
  );
  for (const topic of topics) subscribeTopic(call, topic);

  await audioVideo.bindAudioElement(audio);
  await audioVideo.startAudioInput(silentStream());
  audioVideo.start();
  audioVideo.realtimeMuteLocalAudio();

  renderCalls();
}

function subscribeTopic(call: Call, topic: string) {
  call.session.audioVideo.realtimeSubscribeToReceiveDataMessage(
    topic,
    (message: DataMessage) => logDataMessage(call, "in", message),
  );
}

async function leave(call: Call) {
  if (calls.get(call.id) !== call) return;
  calls.delete(call.id);
  sendTargets.delete(call.id);
  if (selectedCallId === call.id) selectedCallId = calls.keys().next().value;
  call.session.audioVideo.stop();
  await call.session.audioVideo.stopAudioInput().catch(() => {});
  call.session.audioVideo.unbindAudioElement();
  call.audio.remove();
  releaseMicIfUnused();
  renderCalls();
  await post("/api/leave", leaveBody(call)).catch((error) =>
    toast(`rooms.leave: ${errorMessage(error)}`, true),
  );
}

function leaveBody(call: Call) {
  return {
    channelId: call.join.channelId,
    callId: call.join.callId,
    attendeeId: call.selfAttendeeId,
  };
}

// Tell Slack we left when the tab closes, as Slack's own client does.
addEventListener("pagehide", () => {
  for (const call of calls.values())
    void fetch("/api/leave", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(leaveBody(call)),
    });
});

function toggleMute(call: Call) {
  if (call.micMuted) call.session.audioVideo.realtimeUnmuteLocalAudio();
  else call.session.audioVideo.realtimeMuteLocalAudio();
  call.micMuted = !call.micMuted;
  renderCalls();
}

// Every huddle using the microphone shares one capture.
async function toggleMicSource(call: Call) {
  try {
    if (!call.usingMic)
      micStream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
    call.usingMic = !call.usingMic;
    await call.session.audioVideo.startAudioInput(
      call.usingMic ? micStream! : silentStream(),
    );
    releaseMicIfUnused();
    renderCalls();
  } catch (error) {
    toast(`Microphone: ${errorMessage(error)}`, true);
  }
}

function releaseMicIfUnused() {
  if (!micStream || [...calls.values()].some((call) => call.usingMic)) return;
  for (const track of micStream.getTracks()) track.stop();
  micStream = undefined;
}

function toggleSpeaker(call: Call) {
  call.speakerMuted = !call.speakerMuted;
  call.audio.muted = call.speakerMuted;
  renderCalls();
}

function selectCall(callId: string) {
  selectedCallId = callId;
  renderCalls();
}

function renderCalls() {
  renderPills();
  $("#calls-section").hidden = !calls.size && !joining;
  const rows = [...calls.values()].map((call) => {
    const button = (
      label: string,
      onClick: () => void,
      className = "small",
    ) => {
      const node = el("button", { className }, label);
      node.onclick = (event) => {
        event.stopPropagation();
        onClick();
      };
      return node;
    };
    const present = [...call.attendees.values()].filter((a) => a.present);
    const row = el(
      "li",
      {
        className: call.id === selectedCallId ? "call selected" : "call",
      },
      el(
        "span",
        { className: "grow" },
        callLabel(call),
        el(
          "span",
          { className: "sub" },
          `${call.status} · ${present.length} here · ${call.selfAttendeeId}`,
        ),
      ),
      button(call.micMuted ? "Unmute" : "Mute", () => toggleMute(call)),
      button(
        call.usingMic ? "Silence" : "Mic",
        () => void toggleMicSource(call),
      ),
      button(call.speakerMuted ? "🔇" : "🔊", () => toggleSpeaker(call)),
      button("Leave", () => void leave(call), "small danger"),
    );
    row.title = "Select to see participants and details";
    row.onclick = () => selectCall(call.id);
    return row;
  });
  if (joining) rows.push(el("li", { className: "empty" }, "Joining…"));
  $("#calls").replaceChildren(...rows);

  const call = selectedCall();
  const facts: [string, string][] = call
    ? [
        ["Channel", call.join.channelId],
        ["Call", call.join.callId],
        ["Attendee", call.selfAttendeeId],
        [
          "Meeting",
          String(
            (call.join.meeting.Meeting as Record<string, unknown> | undefined)
              ?.MeetingId ??
              call.join.meeting.MeetingId ??
              "",
          ),
        ],
      ]
    : [];
  $("#call-facts").replaceChildren(
    ...facts.flatMap(([term, value]) => [
      el("dt", {}, term),
      el("dd", {}, value),
    ]),
  );
  renderRoster();
  renderSendTarget();
  prefillSticky();
  renderRawTemplates();
}

// ---------------------------------------------------------------- invites

function renderInvites() {
  const list = $("#invites");
  if (!invites.size) {
    list.replaceChildren(
      el(
        "li",
        { className: "empty" },
        "Invites to huddles arrive here over the realtime socket.",
      ),
    );
    return;
  }
  list.replaceChildren(
    ...[...invites.entries()].map(([callId, invite]) => {
      const channelId = String(invite.channel_id);
      const join = el("button", { className: "small primary" }, "Join");
      join.onclick = () => {
        invites.delete(callId);
        renderInvites();
        void joinWith(() =>
          post<ChimeJoin>("/api/join-invite", {
            channelId,
            callId,
            freeWilly: invite.free_willy,
          }),
        );
      };
      const decline = el("button", { className: "small" }, "Decline");
      decline.onclick = async () => {
        invites.delete(callId);
        renderInvites();
        await post("/api/decline", { channelId, callId }).catch((error) =>
          toast(errorMessage(error), true),
        );
      };
      const from = el(
        "span",
        { className: "grow" },
        String(invite.sender_user_id),
      );
      void userName(String(invite.sender_user_id)).then((name) => {
        if (name) from.textContent = name;
      });
      return el(
        "li",
        {},
        el(
          "span",
          { className: "grow" },
          from,
          el("span", { className: "sub" }, `${channelId} · ${callId}`),
        ),
        join,
        decline,
      );
    }),
  );
}

// ---------------------------------------------------------------- roster

function updatePresence(
  call: Call,
  attendeeId: string,
  present: boolean,
  externalUserId?: string,
) {
  let attendee = call.attendees.get(attendeeId);
  if (!attendee) {
    attendee = {
      attendeeId,
      externalUserId,
      present,
      volume: 0,
      muted: false,
      signal: 1,
      element: el("li"),
    };
    call.attendees.set(attendeeId, attendee);
    const tracked = attendee;
    call.session.audioVideo.realtimeSubscribeToVolumeIndicator(
      attendeeId,
      (_id, volume, muted, signal) => {
        if (volume !== null) tracked.volume = volume;
        if (muted !== null) tracked.muted = muted;
        if (signal !== null) tracked.signal = signal;
        if (call.id === selectedCallId) renderAttendee(call, tracked);
      },
    );
  }
  attendee.present = present;
  attendee.externalUserId = externalUserId ?? attendee.externalUserId;
  renderCalls();
}

function renderAttendee(call: Call, attendee: Attendee) {
  const isSelf = attendee.attendeeId === call.selfAttendeeId;
  const userId = slackUserId(attendee.externalUserId);
  const name = el(
    "span",
    {},
    isSelf ? "You" : (userId ?? attendee.externalUserId ?? "Unknown"),
  );
  if (userId && !isSelf)
    void userName(userId).then((found) => {
      if (found) name.textContent = `${found} (${userId})`;
    });
  const meter = el("span", { className: "meter" }, el("span"));
  (meter.firstChild as HTMLElement).style.width =
    `${Math.round(attendee.volume * 100)}%`;
  const children: Node[] = [
    el(
      "span",
      { className: "grow" },
      name,
      el(
        "span",
        { className: "sub" },
        `${attendee.attendeeId}${attendee.externalUserId ? ` · ${attendee.externalUserId}` : ""}`,
      ),
    ),
    el("span", { title: "Muted" }, attendee.muted ? "🔇" : "🎙️"),
    meter,
  ];
  if (!isSelf) {
    const mute = el("button", { className: "small" }, "Mute");
    mute.title = "Send a muteRequest PeerMessage";
    mute.onclick = () =>
      sendPeerTo([call], (self) => ({
        muteRequest: { peerId: attendee.attendeeId },
        fromPeerIdString: self,
      }));
    children.push(mute);
  }
  attendee.element.replaceChildren(...children);
}

function renderRoster() {
  const list = $("#roster");
  const call = selectedCall();
  $("#roster-call").textContent = call && calls.size > 1 ? callLabel(call) : "";
  const present = call
    ? [...call.attendees.values()].filter((a) => a.present)
    : [];
  if (!call || !present.length) {
    list.replaceChildren(
      el(
        "li",
        { className: "empty" },
        call ? "Waiting for presence…" : "Join a huddle to see who is in it.",
      ),
    );
    return;
  }
  for (const attendee of present) renderAttendee(call, attendee);
  list.replaceChildren(...present.map((a) => a.element));
}

// ---------------------------------------------------------------- send

function renderSendTarget() {
  const container = $("#send-targets");
  if (!calls.size) {
    container.replaceChildren();
    return;
  }
  const boxes = [...calls.values()].map((call) => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = sendTargets.has(call.id);
    box.onchange = () => {
      if (box.checked) sendTargets.add(call.id);
      else sendTargets.delete(call.id);
    };
    const label = document.createElement("label");
    label.className = "inline";
    label.append(box, callLabel(call));
    return label;
  });
  const setAll = (on: boolean) => () => {
    for (const call of calls.values())
      if (on) sendTargets.add(call.id);
      else sendTargets.delete(call.id);
    renderSendTarget();
  };
  const all = el("button", { className: "small", type: "button" }, "All");
  all.onclick = setAll(true);
  const none = el("button", { className: "small", type: "button" }, "None");
  none.onclick = setAll(false);
  container.replaceChildren(
    el("span", {}, "Send to"),
    ...boxes,
    ...(calls.size > 1 ? [all, none] : []),
  );
}

/** The connected huddles the Send card is aimed at. */
function targetCalls() {
  if (!calls.size) throw new Error("Join a huddle first");
  const ready = [...calls.values()].filter(
    (call) => sendTargets.has(call.id) && call.status === "connected",
  );
  if (!ready.length) throw new Error("Tick a connected huddle to send to");
  return ready;
}

function sendBytes(
  call: Call,
  topic: string,
  bytes: Uint8Array,
  lifetimeMs = 0,
) {
  if (bytes.length > maxDataMessageBytes)
    throw new Error(
      `Message is ${bytes.length} bytes; Chime allows ${maxDataMessageBytes}`,
    );
  call.session.audioVideo.realtimeSendDataMessage(topic, bytes, lifetimeMs);
  logDataMessage(call, "out", {
    topic,
    data: bytes,
    senderAttendeeId: call.selfAttendeeId,
    timestampMs: Date.now(),
  });
}

/**
 * Sends a PeerMessage to each huddle; `build` gets that huddle's own attendee
 * ID, which Slack's clients put in `fromPeerIdString`.
 */
function sendPeerTo(
  targets: Call[],
  build: (selfAttendeeId: string, call: Call) => JsonValue,
  topic = dataChannelTopic,
) {
  try {
    for (const call of targets)
      sendBytes(
        call,
        topic,
        encodePeerMessage(build(call.selfAttendeeId, call)),
      );
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

function sendPeer(
  build: (selfAttendeeId: string, call: Call) => JsonValue,
  topic = dataChannelTopic,
) {
  try {
    sendPeerTo(targetCalls(), build, topic);
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

function sendReacji(emoji: string, type: ReactionType, emojiUrl?: string) {
  sendPeer((fromPeerIdString) =>
    reacjiMessage({ emoji, type, emojiUrl, fromPeerIdString }),
  );
}

function chips(
  container: string,
  values: string[],
  onClick: (value: string) => void,
) {
  $(container).replaceChildren(
    ...values.map((value) => {
      const chip = el("button", { className: "chip" }, value);
      chip.onclick = () => onClick(value);
      return chip;
    }),
  );
}

// Tabs
for (const tab of document.querySelectorAll<HTMLButtonElement>(
  "#send-tabs button",
)) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll("#send-tabs button"))
      other.classList.toggle("active", other === tab);
    for (const panel of document.querySelectorAll<HTMLElement>(".tab"))
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
}

// Reaction
const reactionForm = $<HTMLFormElement>("#reaction-form");
chips("#emoji-chips", quickEmoji, (emoji) => sendReacji(emoji, "Standard"));
reactionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(reactionForm);
  const emoji = String(data.get("emoji")).trim();
  const type = String(data.get("type")) as ReactionType;
  const emojiUrl = String(data.get("emojiUrl")).trim() || undefined;
  const repeat = Math.max(1, Math.min(100, Number(data.get("repeat")) || 1));
  const interval = Math.max(20, Number(data.get("interval")) || 150);
  for (let i = 0; i < repeat; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, interval));
    sendReacji(emoji, type, emojiUrl);
  }
});

// Effect
const effectForm = $<HTMLFormElement>("#effect-form");
chips("#effect-chips", quickEffects, (name) => sendReacji(name, "Effect"));
effectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendReacji(String(new FormData(effectForm).get("emoji")).trim(), "Effect");
});

// GIF
const gifForm = $<HTMLFormElement>("#gif-form");
gifForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendReacji(String(new FormData(gifForm).get("url")).trim(), "Gif");
});

/** Finds the image URLs in a gif.search result without assuming its shape. */
function gifUrls(gif: Record<string, unknown>) {
  const urls = Object.entries(gif).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && /^https:\/\//.test(entry[1]),
  );
  const pick = (...keys: string[]) =>
    keys.map((key) => urls.find(([name]) => name === key)?.[1]).find(Boolean);
  const original =
    pick("original_gif_url", "gif_url", "url", "original_url") ??
    urls.find(([, url]) => /\.(gif|webp)(\?|$)/.test(url))?.[1];
  const preview =
    pick("preview_gif_url", "preview_url", "thumbnail_url") ?? original;
  return original ? { original, preview: preview ?? original } : undefined;
}

const gifSearch = $<HTMLFormElement>("#gif-search");
async function loadGifs(query: string) {
  const results = $("#gif-results");
  try {
    const response = await post<{ gifs?: Record<string, unknown>[] }>(
      "/api/slack",
      query
        ? {
            method: "gif.search",
            fields: { query, limit: "30", reason: "gif-picker:search" },
          }
        : {
            method: "gif.featured",
            fields: { limit: "30", reason: "gif-picker:featured" },
          },
    );
    const gifs = (response.gifs ?? []).flatMap((gif) => {
      const urls = gifUrls(gif);
      return urls ? [urls] : [];
    });
    if (!gifs.length) {
      toast("No GIFs found (see the API console for the raw response)");
      $("#api-output").textContent = JSON.stringify(response, null, 2);
    }
    results.replaceChildren(
      ...gifs.map(({ original, preview }) => {
        const button = el(
          "button",
          { title: original },
          el("img", { src: preview, alt: "", loading: "lazy" }),
        );
        button.onclick = () => {
          (gifForm.elements.namedItem("url") as HTMLInputElement).value =
            original;
          sendReacji(original, "Gif");
        };
        return button;
      }),
    );
  } catch (error) {
    toast(`GIF search: ${errorMessage(error)}`, true);
  }
}
gifSearch.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadGifs(String(new FormData(gifSearch).get("query")).trim());
});

// Sticky
const stickyForm = $<HTMLFormElement>("#sticky-form");
function prefillSticky() {
  const user = stickyForm.elements.namedItem("user") as HTMLInputElement;
  if (server.identity && !user.value) user.value = server.identity.userId;
}
// An empty channel means each huddle's own channel.
function sendSticky(emoji: string) {
  const data = new FormData(stickyForm);
  const channel = String(data.get("channel")).trim();
  sendPeer((fromPeerIdString, call) =>
    stickyEmojiMessage({
      channel: channel || call.join.channelId,
      user: String(data.get("user")).trim(),
      emoji,
      fromPeerIdString,
    }),
  );
}
chips("#sticky-chips", quickSticky, (emoji) => sendSticky(emoji));
stickyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendSticky(String(new FormData(stickyForm).get("emoji")).trim());
});
$("#sticky-clear").addEventListener("click", () => sendSticky(""));

// Raw
const rawForm = $<HTMLFormElement>("#raw-form");
const rawPayload = rawForm.elements.namedItem("payload") as HTMLTextAreaElement;
const rawEncoding = rawForm.elements.namedItem("encoding") as HTMLSelectElement;
const rawTopic = rawForm.elements.namedItem("topic") as HTMLInputElement;

function rawBytes(selfAttendeeId = selfPlaceholder) {
  const payload = rawPayload.value;
  switch (rawEncoding.value) {
    case "peer":
      return encodePeerMessage(
        JSON.parse(payload, (_key, value) =>
          value === selfPlaceholder ? selfAttendeeId : value,
        ),
      );
    case "hex":
      return hexToBytes(payload);
    case "base64":
      return base64ToBytes(payload);
    default:
      return new TextEncoder().encode(payload);
  }
}

function updateRawSize() {
  try {
    const size = rawBytes().length;
    $("#raw-size").textContent = `${size} / ${maxDataMessageBytes} bytes`;
  } catch (error) {
    $("#raw-size").textContent = errorMessage(error);
  }
}

function loadRaw(topic: string, encoding: string, payload: string) {
  rawTopic.value = topic;
  rawEncoding.value = encoding;
  rawPayload.value = payload;
  updateRawSize();
  document.querySelector<HTMLButtonElement>('[data-tab="raw"]')?.click();
  rawPayload.focus();
}

// Raw PeerMessages may say "SELF" wherever each huddle's own attendee ID goes.
const selfPlaceholder = "SELF";

function renderRawTemplates() {
  const self = selfPlaceholder;
  const templates: [string, JsonValue][] = [
    ["Reacji", reacjiMessage({ emoji: ":tada:", fromPeerIdString: self })],
    [
      "GIF",
      reacjiMessage({
        emoji: "https://media.tenor.com/example.gif",
        type: "Gif",
        fromPeerIdString: self,
      }),
    ],
    [
      "Mute request",
      { muteRequest: { peerId: "ATTENDEE_ID" }, fromPeerIdString: self },
    ],
    [
      "Capabilities",
      { capabilities: { isDrawEnabled: true }, fromPeerIdString: self },
    ],
    [
      "Jukebox",
      { jukeboxRequest: { songKey: "SONG_KEY" }, fromPeerIdString: self },
    ],
    [
      "Awareness query",
      {
        awarenessQuery: {
          channel: selectedCall()?.join.channelId ?? "CHANNEL_ID",
          user: server.identity?.userId ?? "USER_ID",
        },
        fromPeerIdString: self,
      },
    ],
    ["Empty", emptyPeerMessage()],
  ];
  $("#raw-templates").replaceChildren(
    ...templates.map(([name, message]) => {
      const chip = el("button", { className: "chip" }, name);
      chip.type = "button";
      chip.onclick = () =>
        loadRaw(dataChannelTopic, "peer", JSON.stringify(message, null, 2));
      return chip;
    }),
  );
  if (!rawPayload.value)
    rawPayload.value = JSON.stringify(templates[0]![1], null, 2);
  updateRawSize();
}

rawPayload.addEventListener("input", updateRawSize);
rawEncoding.addEventListener("change", updateRawSize);
rawForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const lifetime = Number(
      (rawForm.elements.namedItem("lifetime") as HTMLInputElement).value,
    );
    for (const call of targetCalls())
      sendBytes(
        call,
        rawTopic.value.trim(),
        rawBytes(call.selfAttendeeId),
        lifetime || 0,
      );
  } catch (error) {
    toast(errorMessage(error), true);
  }
});

// ---------------------------------------------------------------- data log

function renderTopics() {
  $("#topics").replaceChildren(
    ...[...topics].map((topic) => {
      const chip = el("span", { className: "chip pill" }, topic);
      if (!peerTopics.has(topic)) {
        const remove = el("button", { className: "small remove" }, "×");
        remove.onclick = () => {
          topics.delete(topic);
          for (const call of calls.values())
            call.session.audioVideo.realtimeUnsubscribeFromReceiveDataMessage(
              topic,
            );
          renderTopics();
        };
        chip.append(remove);
      }
      return chip;
    }),
  );
}

$("#topic-add").addEventListener("click", () => {
  const input = $<HTMLInputElement>("#topic-input");
  const topic = input.value.trim();
  if (!topic || topics.has(topic)) return;
  topics.add(topic);
  for (const call of calls.values()) subscribeTopic(call, topic);
  input.value = "";
  renderTopics();
});

$("#data-clear").addEventListener("click", () =>
  $("#data-log").replaceChildren(),
);

function logDataMessage(
  call: Call,
  direction: "in" | "out",
  message: Pick<
    DataMessage,
    "topic" | "data" | "senderAttendeeId" | "timestampMs"
  > & { senderExternalUserId?: string; throttled?: boolean },
) {
  const bytes = message.data;
  const decoded = peerTopics.has(message.topic)
    ? decodePeerMessage(bytes)
    : undefined;
  const text = decoded === undefined ? printable(bytes) : undefined;
  const body =
    decoded !== undefined
      ? JSON.stringify(decoded, null, 2)
      : (text ?? bytesToHex(bytes));

  const sender = el(
    "strong",
    {},
    direction === "out"
      ? "you"
      : describeAttendee(
          call,
          message.senderAttendeeId,
          message.senderExternalUserId,
        ),
  );
  const senderId = slackUserId(message.senderExternalUserId);
  if (direction === "in" && senderId)
    void userName(senderId).then((name) => {
      if (name) sender.textContent = name;
    });

  const kind =
    decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? Object.keys(decoded).find((key) => key !== "fromPeerIdString")
      : undefined;

  const resend = el("button", { className: "small" }, "Edit & send");
  resend.onclick = () =>
    decoded !== undefined
      ? loadRaw(message.topic, "peer", body)
      : text !== undefined
        ? loadRaw(message.topic, "text", text)
        : loadRaw(message.topic, "base64", bytesToBase64(bytes));
  const copy = el("button", { className: "small" }, "Base64");
  copy.title = "Copy the raw bytes as base64";
  copy.onclick = () => {
    void navigator.clipboard.writeText(bytesToBase64(bytes));
    toast("Copied");
  };

  const item = el(
    "li",
    { className: direction },
    el(
      "div",
      { className: "meta" },
      el("span", {}, direction === "in" ? "⬇" : "⬆"),
      el("span", {}, time(message.timestampMs)),
      ...(calls.size > 1
        ? [el("span", { className: "tag" }, callLabel(call))]
        : []),
      el("strong", {}, message.topic),
      el("span", {}, kind ?? (text !== undefined ? "text" : "bytes")),
      sender,
      el("span", {}, `${bytes.length} B`),
      ...(message.throttled ? [el("span", {}, "throttled")] : []),
      el("span", { className: "actions" }, resend, copy),
    ),
    el("pre", {}, body),
  );
  const gif = (decoded as { reacji?: { emoji?: string; type?: string } })
    ?.reacji;
  if (gif?.type === "Gif" && gif.emoji?.startsWith("https://"))
    item.append(el("img", { className: "preview", src: gif.emoji, alt: "" }));

  const log = $("#data-log");
  log.prepend(item);
  while (log.childElementCount > 500) log.lastElementChild?.remove();
}

// ---------------------------------------------------------------- events

const huddleEventPattern = /^(sh_|huddle|screenhero|call|room)/;
const eventFilter = $<HTMLInputElement>("#event-filter");
const huddleOnly = $<HTMLInputElement>("#event-huddle-only");

function eventVisible(item: HTMLElement) {
  const type = item.dataset.type ?? "";
  if (huddleOnly.checked && item.dataset.huddle !== "true") return false;
  const filter = eventFilter.value.trim().toLowerCase();
  return !filter || type.toLowerCase().includes(filter);
}

function refilterEvents() {
  for (const item of $("#event-log").children)
    (item as HTMLElement).hidden = !eventVisible(item as HTMLElement);
}
eventFilter.addEventListener("input", refilterEvents);
huddleOnly.addEventListener("change", refilterEvents);
$("#event-clear").addEventListener("click", () =>
  $("#event-log").replaceChildren(),
);

function logEvent(at: number, event: Record<string, unknown>) {
  const type = String(event.type ?? "unknown");
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  const huddle =
    huddleEventPattern.test(type) ||
    /huddle/.test(subtype) ||
    "huddle" in event;
  const item = el(
    "li",
    { className: huddle ? "huddle" : "" },
    el(
      "div",
      { className: "meta" },
      el("span", {}, time(at)),
      el("strong", {}, subtype ? `${type} · ${subtype}` : type),
    ),
    el("pre", {}, JSON.stringify(event, null, 2)),
  );
  item.dataset.type = `${type} ${subtype}`;
  item.dataset.huddle = String(huddle);
  item.hidden = !eventVisible(item);
  const log = $("#event-log");
  log.prepend(item);
  while (log.childElementCount > 500) log.lastElementChild?.remove();

  if (type === "huddle_invite" && typeof event.call_id === "string") {
    invites.set(event.call_id, event);
    renderInvites();
  }
  // An invite is stale once its huddle ends.
  if (type === "sh_room_update") {
    const room = (event.room ?? event.huddle) as
      Record<string, unknown> | undefined;
    const id = room?.call_id ?? room?.id;
    if (typeof id === "string" && (room?.has_ended || room?.date_end)) {
      invites.delete(id);
      renderInvites();
    }
  }
}

// ---------------------------------------------------------------- API console

const apiForm = $<HTMLFormElement>("#api-form");
apiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(apiForm);
  const output = $("#api-output");
  try {
    const fieldsText = String(data.get("fields")).trim();
    const result = await post("/api/slack", {
      method: String(data.get("method")).trim(),
      fields: fieldsText ? JSON.parse(fieldsText) : {},
    });
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = errorMessage(error);
  }
});

// ---------------------------------------------------------------- server socket

function connectServer() {
  const socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.kind === "state") {
      const { kind: _kind, ...rest } = data;
      server = rest;
      renderPills();
      renderIdentity();
    } else if (data.kind === "rtm") {
      logEvent(data.at, data.event);
    }
  });
  socket.addEventListener("close", () => {
    server = { ...server, realtimeStatus: "page disconnected" };
    renderPills();
    setTimeout(connectServer, 2000);
  });
}

restoreCredentials();
renderPills();
renderTopics();
renderRawTemplates();
connectServer();
