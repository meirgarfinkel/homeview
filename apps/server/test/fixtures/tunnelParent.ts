// A parent process for the tunnel tests: it runs a TunnelManager with the fake
// helper and prints "on" once the helper is ready. The test then kills this
// process with SIGKILL, so no exit handler runs, and checks the helper goes too.
import { fileURLToPath } from 'node:url';
import { TunnelManager } from '../../src/remote/tunnel.js';
import { silentLogger } from '../helpers.js';

const tunnel = new TunnelManager({
  command: process.execPath,
  args: [fileURLToPath(new URL('./fakeTunnel.mjs', import.meta.url))],
  stateDir: process.argv[2]!,
  targetPort: 4321,
  logger: silentLogger,
});
tunnel.on('change', () => {
  if (tunnel.phase() === 'on') process.stdout.write('on\n');
});
tunnel.start();
