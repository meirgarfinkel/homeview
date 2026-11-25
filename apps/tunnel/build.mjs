import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function goBuild(goos, goarch, out) {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    'go',
    ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', out, '.'],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    },
  );
}

let out;
switch (process.platform) {
  case 'linux':
    out = join(root, 'bin/linux/kasa-tunnel');
    goBuild('linux', 'amd64', out);
    break;
  case 'win32':
    out = join(root, 'bin/win/kasa-tunnel.exe');
    goBuild('windows', 'amd64', out);
    break;
  case 'darwin': {
    out = join(root, 'bin/mac/kasa-tunnel');
    const arm = `${out}-arm64`;
    const amd = `${out}-amd64`;
    goBuild('darwin', 'arm64', arm);
    goBuild('darwin', 'amd64', amd);
    execFileSync('lipo', ['-create', '-output', out, arm, amd], { stdio: 'inherit' });
    rmSync(arm);
    rmSync(amd);
    execFileSync('codesign', ['--force', '-s', '-', out], { stdio: 'inherit' });
    break;
  }
  default:
    throw new Error(`Unsupported platform: ${process.platform}`);
}
console.log(out);
