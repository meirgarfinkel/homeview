// A stand-in for the kasa-tunnel helper, for tests. It never contacts Tailscale.
//
// FAKE_TUNNEL_SCRIPT is a JSON array of steps, played in order:
//   { "event": {...} }    print the event as one JSON line (a string is printed as is)
//   { "waitMs": 50 }      wait
//   { "exit": 1 }         exit with this code
//   { "ignoreTerm": true } ignore SIGTERM from now on
// After the last step it stays running until it gets a signal, like the real helper.
// Like the real helper, it also exits once its stdin ends, which is how it
// notices that its parent is gone.
//
// FAKE_TUNNEL_RECORD, if set, is a file that gets one JSON line per start with
// the pid, the arguments and the secret, so tests can check how it was started.
import { appendFileSync } from 'node:fs';

const secret = process.env.KASA_TUNNEL_SECRET;
if (!secret) {
  process.stderr.write('KASA_TUNNEL_SECRET is required\n');
  process.exit(2);
}

const record = process.env.FAKE_TUNNEL_RECORD;
if (record) {
  appendFileSync(
    record,
    `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), secret })}\n`,
  );
}

const steps = JSON.parse(process.env.FAKE_TUNNEL_SCRIPT ?? '[]');
const keepAlive = setInterval(() => {}, 1 << 30);

process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

for (const step of steps) {
  if ('event' in step) {
    process.stdout.write(
      `${typeof step.event === 'string' ? step.event : JSON.stringify(step.event)}\n`,
    );
  } else if ('waitMs' in step) {
    await new Promise((r) => setTimeout(r, step.waitMs));
  } else if ('exit' in step) {
    clearInterval(keepAlive);
    process.exit(step.exit);
  } else if ('ignoreTerm' in step) {
    process.on('SIGTERM', () => {});
  }
}
