import { describe, expect, test } from "bun:test";
import {
  normalizeInviteJoin,
  normalizeJoinResponse,
  normalizeWorkspaceUrl,
} from "./slack.ts";

describe("normalizeWorkspaceUrl", () => {
  test("accepts a bare workspace name, host or URL", () => {
    expect(normalizeWorkspaceUrl("acme")).toBe("https://acme.slack.com");
    expect(normalizeWorkspaceUrl("acme.slack.com")).toBe(
      "https://acme.slack.com",
    );
    expect(normalizeWorkspaceUrl("https://acme.slack.com/client/T1")).toBe(
      "https://acme.slack.com",
    );
  });

  test("rejects hosts outside slack.com", () => {
    expect(() => normalizeWorkspaceUrl("https://evil.example")).toThrow();
    expect(() => normalizeWorkspaceUrl("http://acme.slack.com")).toThrow();
  });
});

describe("join responses", () => {
  const meeting = { Meeting: { MeetingId: "m" }, MeetingFeatures: null };
  const attendee = { Attendee: { AttendeeId: "a" } };

  test("reads the Chime meeting out of rooms.join", () => {
    const join = normalizeJoinResponse(
      { ok: true, call: { call_id: "R1", free_willy: { meeting, attendee } } },
      "C1",
    );
    expect(join.callId).toBe("R1");
    expect(join.channelId).toBe("C1");
    expect(join.attendee).toEqual(attendee);
    // Chime rejects an explicit null.
    expect("MeetingFeatures" in join.meeting).toBe(false);
  });

  test("surfaces Slack errors", () => {
    expect(() =>
      normalizeJoinResponse({ ok: false, error: "not_allowed" }, "C1"),
    ).toThrow("rooms.join failed: not_allowed");
  });

  test("joins an invite with the event's free_willy", () => {
    const join = normalizeInviteJoin(
      { ok: true, room: { id: "R1" } },
      "C1",
      "R1",
      { meeting, attendee },
    );
    expect(join.callId).toBe("R1");
    expect(() =>
      normalizeInviteJoin({ ok: true, room: { id: "R2" } }, "C1", "R1", {
        meeting,
        attendee,
      }),
    ).toThrow("wrong huddle");
  });
});
