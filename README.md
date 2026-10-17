# Slack Huddle Playground

A local web page for poking at Slack huddles as your own user: join or start a
huddle, see who is in it, and send and receive the peer messages Slack clients
exchange inside the call, such as reactions, effects, GIFs, sticky emoji, mute
requests, or any bytes you like.

## Run

```sh
bun install
bun start
```

Open http://127.0.0.1:4747 and paste:

- **Workspace**: `acme`, `acme.slack.com` or the full URL.
- **xoxc token**: from a signed-in Slack web client, e.g. `localStorage.localConfig_v2` → `teams[TEAM_ID].token`.
- **xoxd cookie**: the value of the `d` cookie on `app.slack.com`.

Or connect on start with `SLACK_WORKSPACE_URL`, `SLACK_XOXC` and `SLACK_XOXD`.
`PORT` and `HOST` change where the page is served (default `127.0.0.1:4747`).

The tokens stay in the server's memory, and in the browser's `localStorage`
only if you tick "Remember". The server only answers requests whose `Host` and
`Origin` are its own loopback address, so other sites can't drive it.

## What's on the page

- **Huddle**: join or start the huddle in a channel or DM (`rooms.join`), or
  accept an invite that arrives over the realtime socket (`huddle_invite`).
  The page joins the Amazon Chime meeting itself, muted and sending silence;
  you can unmute or switch to your microphone, and you hear the huddle. Join
  as many huddles as you like at once, or the same huddle several times
  (× count); each is its own Chime connection with its own controls.
- **Participants**: Chime attendee presence, with Slack names, mute state,
  volume, and a button that sends a `muteRequest`.
- **Send**: to any mix of joined huddles, ticked at the top of the card.
  In raw PeerMessage JSON, `"SELF"` becomes each huddle's own attendee ID.
  - Reaction: emoji with any type and `emojiUrl`, repeatable to try Slack's
    "explosion".
  - Effect: effect reacji such as `gong`.
  - GIF: search Slack's own GIF picker (`gif.search`), or paste any URL.
  - Sticky: the emoji pinned to your tile.
  - Raw: any `PeerMessage` as JSON, or text, hex or base64 bytes on any topic.
- **Data messages**: everything received or sent on the subscribed topics,
  decoded where it's a `PeerMessage`, with "Edit & send" to replay it.
- **Slack events**: the realtime socket, filtered to huddle events by default.
- **API console**: call any Web API method as the user.

## How huddle peer messages work

Slack's clients send these over the Chime meeting's data messages, not Slack's
API. The topic is `data-channel`, and the payload is a protobuf
`PeerMessage` (`calls/client/peer_message.proto`). `src/peer-message.ts`
carries its descriptor exactly as embedded in Slack's web client.

```proto
message Reacji {
  enum Type { Unknown_reaction_type = 0; Effect = 1; Standard = 2; Gif = 3; }
  string emoji    = 1;  // shortcode, effect name, or the GIF's URL
  Type   type     = 2;  // left out for a standard emoji
  string emojiUrl = 3;  // custom emoji image
}
```

- Receivers drop a message whose Chime sender isn't a known attendee.
- A GIF reaction puts the image URL in `emoji`; receivers render it as an
  `<img>` without Slack's image proxy.
- Sticky emoji go as an `awarenessBroadcast` with the field `stickyEmoji`. The
  page fills its `channel` with the huddle's channel; that part is a guess.
- Chime caps a data message at 2 KiB.

## Development

```sh
bun test
bun run check
bun run format
```
