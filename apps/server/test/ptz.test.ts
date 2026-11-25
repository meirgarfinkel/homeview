import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { CameraCredentials } from '../src/kasa/credentials.js';
import { LinkieClient } from '../src/kasa/linkieClient.js';
import { PtzController } from '../src/kasa/ptz.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const ACCOUNT = { username: 'parent@example.com', password: 'kasa-account-pw' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fake: FakeCamera;
let ptz: PtzController;

async function setup(limit = 1934, motor: { stepMs?: number; replyMs?: number } = {}) {
  fake = new FakeCamera({
    ...ACCOUNT,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
    ptzMotor: { stepMs: 80, replyMs: 70, unitsPerSec: 1000, limit, ...motor },
  });
  const { apiPort } = await fake.start();
  const linkie = new LinkieClient({
    host: '127.0.0.1',
    port: apiPort,
    credentials: new CameraCredentials(ACCOUNT.username, ACCOUNT.password),
    logger: silentLogger,
  });
  ptz = new PtzController({
    linkie,
    logger: silentLogger,
    enabled: true,
    stepSpeed: 2,
    holdTimeoutMs: 300,
  });
}

const sent = (method: string) =>
  fake.commands.filter((c) => c.method === method).map((c) => c.args as Record<string, unknown>);

/** Keep renewing a hold, as the page does while a button is down. */
async function holdFor(direction: 'up' | 'down' | 'left' | 'right', ms: number) {
  await ptz.hold(direction);
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await sleep(100);
    await ptz.hold(direction);
  }
}

beforeEach(() => setup());
afterEach(async () => {
  await ptz.dispose();
  await fake.stop();
});

describe('pan/tilt step and hold', () => {
  it('a tap moves one step at the step speed', async () => {
    await ptz.step('right');
    await sleep(200);
    expect(sent('set_move')).toEqual([{ direction: 'right', speed: 2 }]);
    expect(fake.position).toEqual({ x: 54, y: 0 });
  });

  it('holding glides toward the edge with one command, until released', async () => {
    await holdFor('left', 400);
    await ptz.stop();
    expect(sent('set_target')).toEqual([{ x: -99_999, y: 0 }]);
    expect(fake.position.x).toBeLessThan(-200);
    expect(fake.commands.at(-1)?.method).toBe('set_stop');
    expect(ptz.holding).toBeUndefined();
  });

  it('holding up or down keeps the pan position', async () => {
    await ptz.step('right');
    await sleep(200);
    await holdFor('up', 150);
    await ptz.stop();
    expect(sent('set_target').at(-1)).toEqual({ x: 54, y: 99_999 });
    expect(fake.position.x).toBe(54);
    expect(fake.position.y).toBeGreaterThan(0);
  });

  it("stop doesn't wait behind a command still in flight, and halts mid-move", async () => {
    await ptz.dispose();
    await fake.stop();
    await setup(1934, { stepMs: 1000, replyMs: 600 });
    await ptz.step('left'); // opens the spare connections
    await sleep(1200);
    const tap = ptz.step('right'); // the camera takes 600 ms to answer this
    await sleep(100);
    const t = performance.now();
    await ptz.stop();
    expect(performance.now() - t).toBeLessThan(300);
    await tap;
    // The step was cut short, and nothing moves afterwards.
    const x = fake.position.x;
    expect(x - -54).toBeLessThan(54);
    await sleep(300);
    expect(fake.position.x).toBe(x);
  });

  it('stops by itself when the client stops renewing (closed tab)', async () => {
    await ptz.hold('up');
    await waitFor(() => ptz.holding === undefined, 2000);
    expect(ptz.lastHoldEnd).toBe('released');
    await waitFor(() => fake.commands.at(-1)?.method === 'set_stop', 1000);
    const y = fake.position.y;
    await sleep(200);
    expect(fake.position.y).toBe(y);
  });

  it('stops at the end of travel even while still held', async () => {
    await ptz.dispose();
    await fake.stop();
    await setup(250);
    await holdFor('right', 600);
    expect(fake.position.x).toBe(250);
  });

  it('opens no connection during a hold, and stops on one opened before it', async () => {
    await ptz.step('left'); // first use opens the spare connections
    await sleep(400);
    await ptz.hold('right');
    const opened = fake.connectionsOpened.length;
    await holdFor('right', 500);
    await ptz.stop();
    // A handshake stalls a real camera, so none may run while a stop is due.
    expect(fake.connectionsOpened.length).toBe(opened);
    const stop = fake.commands.findLast((c) => c.method === 'set_stop');
    expect(stop?.connectionAgeMs).toBeGreaterThan(400);
    // Used spares are replaced once the camera has stopped.
    await waitFor(() => fake.connectionsOpened.length > opened, 3000);
  });

  it('a tap during a hold stops the hold first', async () => {
    await ptz.hold('down');
    await sleep(50);
    await ptz.step('up');
    expect(ptz.holding).toBeUndefined();
    const methods = fake.commands.map((c) => c.method).filter((m) => m !== 'get_position');
    expect(methods.slice(-3)).toEqual(['set_target', 'set_stop', 'set_move']);
    expect(sent('set_move').at(-1)).toEqual({ direction: 'top', speed: 2 });
  });
});
