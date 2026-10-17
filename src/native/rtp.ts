// RTP and RTCP packets, from HuddleFM's native media backend.

export function rtpPacket(
  payloadType: number,
  sequence: number,
  timestamp: number,
  ssrc: number,
  payload: Uint8Array,
  marker = false,
) {
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | payloadType;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  packet.set(payload, 12);
  return packet;
}

/** An RTCP sender report with no report blocks. */
export function senderReport(
  ssrc: number,
  rtpTimestamp: number,
  packets: number,
  octets: number,
  now = Date.now(),
) {
  const packet = Buffer.alloc(28);
  packet[0] = 0x80;
  packet[1] = 200;
  packet.writeUInt16BE(6, 2);
  packet.writeUInt32BE(ssrc >>> 0, 4);
  const ntp = now / 1000 + 2_208_988_800;
  packet.writeUInt32BE(Math.floor(ntp) >>> 0, 8);
  packet.writeUInt32BE(Math.floor((ntp % 1) * 2 ** 32) >>> 0, 12);
  packet.writeUInt32BE(rtpTimestamp >>> 0, 16);
  packet.writeUInt32BE(packets >>> 0, 20);
  packet.writeUInt32BE(octets >>> 0, 24);
  return packet;
}
