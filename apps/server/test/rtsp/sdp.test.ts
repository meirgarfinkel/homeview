import { describe, expect, it } from 'vitest';
import { aacConfigFromFmtp, parameterSetsFromFmtp, parseSdp } from '../../src/rtsp/sdp.js';

/** Reolink-style: H.264 + AAC, relative track controls. */
export const SDP_H264_AAC = [
  'v=0',
  'o=- 1 1 IN IP4 192.0.2.10',
  's=Session streamed by "preview"',
  't=0 0',
  'a=control:*',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1;profile-level-id=640033;sprop-parameter-sets=Z2QAM6wVFKAoAPGQ,aO48sA==',
  'a=control:trackID=1',
  'm=audio 0 RTP/AVP 97',
  'a=rtpmap:97 MPEG4-GENERIC/16000',
  'a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1408',
  'a=control:trackID=2',
  '',
].join('\r\n');

/** Hikvision-style: H.265 + PCMU (static type 0, no rtpmap), absolute controls. */
export const SDP_H265_PCMU = [
  'v=0',
  'o=- 1 1 IN IP4 192.0.2.11',
  's=Media Presentation',
  'a=control:rtsp://192.0.2.11:554/Streaming/Channels/101/',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H265/90000',
  'a=fmtp:96 sprop-vps=QAEMAf//AWAAAAMAkAAAAwAAAwA8lZgJ;sprop-sps=QgEBAWAAAAMAkAAAAwAAAwA8oAoIBxln;sprop-pps=RAHA8vA8kA==',
  'a=control:rtsp://192.0.2.11:554/Streaming/Channels/101/trackID=1',
  'm=audio 0 RTP/AVP 0',
  'a=control:rtsp://192.0.2.11:554/Streaming/Channels/101/trackID=2',
  '',
].join('\n');

/** Tapo-style: H.264 + PCMA, '*' video control and a relative audio one. */
export const SDP_H264_PCMA = [
  'v=0',
  's=Session',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H264/90000',
  'a=control:*',
  'm=audio 0 RTP/AVP 8',
  'a=rtpmap:8 PCMA/8000',
  'a=control:track2',
  '',
].join('\r\n');

describe('parseSdp', () => {
  it('parses three answers into media with absolute control URLs', () => {
    const a = parseSdp(SDP_H264_AAC, 'rtsp://192.0.2.10:554/h264Preview_01_main');
    expect(a).toMatchObject([
      {
        type: 'video',
        payloadType: 96,
        encoding: 'H264',
        clockRate: 90000,
        control: 'rtsp://192.0.2.10:554/h264Preview_01_main/trackID=1',
      },
      {
        type: 'audio',
        payloadType: 97,
        encoding: 'MPEG4-GENERIC',
        clockRate: 16000,
        channels: 1,
        control: 'rtsp://192.0.2.10:554/h264Preview_01_main/trackID=2',
      },
    ]);

    const b = parseSdp(SDP_H265_PCMU, 'rtsp://192.0.2.11:554/Streaming/Channels/101');
    expect(b.map((m) => [m.encoding, m.clockRate, m.control])).toEqual([
      ['H265', 90000, 'rtsp://192.0.2.11:554/Streaming/Channels/101/trackID=1'],
      ['PCMU', 8000, 'rtsp://192.0.2.11:554/Streaming/Channels/101/trackID=2'],
    ]);

    const c = parseSdp(SDP_H264_PCMA, 'rtsp://192.0.2.12:554/stream1/');
    expect(c.map((m) => [m.encoding, m.control])).toEqual([
      ['H264', 'rtsp://192.0.2.12:554/stream1/'],
      ['PCMA', 'rtsp://192.0.2.12:554/stream1/track2'],
    ]);
  });

  it('extracts H.264 parameter sets', () => {
    const [video] = parseSdp(SDP_H264_AAC, 'rtsp://192.0.2.10/x');
    const sets = parameterSetsFromFmtp(video!);
    expect(sets.map((n) => n[0]! & 0x1f)).toEqual([7, 8]);
  });

  it('extracts H.265 parameter sets in VPS, SPS, PPS order', () => {
    const [video] = parseSdp(SDP_H265_PCMU, 'rtsp://192.0.2.11/x');
    const sets = parameterSetsFromFmtp(video!);
    expect(sets.map((n) => (n[0]! >> 1) & 0x3f)).toEqual([32, 33, 34]);
  });

  it('reads the AAC config, size and index lengths', () => {
    const [, audio] = parseSdp(SDP_H264_AAC, 'rtsp://192.0.2.10/x');
    expect(aacConfigFromFmtp(audio!)).toEqual({
      config: Buffer.from([0x14, 0x08]),
      sampleRate: 16000,
      channels: 1,
      sizeLength: 13,
      indexLength: 3,
      indexDeltaLength: 3,
    });
  });

  it('ignores media with no port line it understands', () => {
    expect(parseSdp('v=0\r\nm=application 0 RTP/AVP 107\r\n', 'rtsp://192.0.2.1/')).toEqual([
      expect.objectContaining({ type: 'application' }),
    ]);
  });
});
