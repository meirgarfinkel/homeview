import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CodecMessage, StreamState } from '@kasa/shared';
import { PcmPlayer } from '../lib/audioPlayer';
import { decodeMulaw, levelFromRms, rms } from '../lib/g711';
import { api, notifyUnauthorized } from '../lib/api';
import { LiveConnection, type ConnectionState } from '../lib/liveConnection';
import { isMseSupported, MsePlayer } from '../lib/msePlayer';

export interface LiveStream {
  connection: ConnectionState;
  stream: StreamState;
  detail: string | undefined;
  codec: CodecMessage | undefined;
  playerError: string | undefined;
  listening: boolean;
  startListening(): Promise<void>;
  stopListening(): void;
  volume: number;
  setVolume(v: number): void;
  /** Ref holding the smoothed sound level 0..1, updated per audio packet. */
  levelRef: RefObject<number>;
}

export function useLiveStream(videoRef: RefObject<HTMLVideoElement | null>): LiveStream {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [stream, setStream] = useState<StreamState>('connecting');
  const [detail, setDetail] = useState<string>();
  const [codec, setCodec] = useState<CodecMessage>();
  const [playerError, setPlayerError] = useState<string>();
  const [listening, setListening] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const levelRef = useRef(0);
  const audioRef = useRef(new PcmPlayer());

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!isMseSupported()) {
      setPlayerError('This browser cannot play live video (no Media Source Extensions).');
    }
    const mse = new MsePlayer(video);
    const audio = audioRef.current;
    let mseReady = false;

    const conn = new LiveConnection({
      onConnection: setConnection,
      // The browser hides why a socket was refused, so ask whether this one is still signed in.
      onRefused: () => {
        api.session().then(
          (s) => {
            if (s.authRequired && !s.authenticated) notifyUnauthorized();
          },
          () => undefined,
        );
      },
      // The phone was removed. The session check then shows the not-paired page.
      onDeviceRemoved: notifyUnauthorized,
      onMessage: (msg) => {
        if (msg.type === 'status') {
          setStream(msg.state);
          setDetail(msg.detail);
        } else if (msg.type === 'codec') {
          setCodec(msg);
          audio.setSampleRate(msg.audio.sampleRate);
          try {
            mse.reset(msg.video.mimeType);
            mseReady = true;
            setPlayerError(undefined);
          } catch (err) {
            mseReady = false;
            setPlayerError((err as Error).message);
          }
        }
      },
      onVideoInit: (data) => mseReady && mse.append(data as Uint8Array<ArrayBuffer>),
      onVideoFragment: (data) => mseReady && mse.append(data as Uint8Array<ArrayBuffer>),
      onAudio: (data) => {
        const samples = decodeMulaw(data);
        const level = levelFromRms(rms(samples));
        // Fast attack, slow release, like a VU meter.
        const prev = levelRef.current;
        levelRef.current = level > prev ? level : prev * 0.85 + level * 0.15;
        audio.push(samples);
      },
    });
    conn.start();
    return () => {
      conn.stop();
      mse.destroy();
      audio.disable();
    };
  }, [videoRef]);

  const startListening = useCallback(async () => {
    await audioRef.current.enable();
    setListening(true);
  }, []);

  const stopListening = useCallback(() => {
    audioRef.current.disable();
    setListening(false);
  }, []);

  const setVolume = useCallback((v: number) => {
    audioRef.current.setVolume(v);
    setVolumeState(v);
  }, []);

  return {
    connection,
    stream,
    detail,
    codec,
    playerError,
    listening,
    startListening,
    stopListening,
    volume,
    setVolume,
    levelRef,
  };
}
