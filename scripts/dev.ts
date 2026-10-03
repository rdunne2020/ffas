import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The initial build runs before this script, so neither watcher starts on stale code.
const root = fileURLToPath(new URL('../../', import.meta.url));
const children = [
  spawn(process.execPath, ['node_modules/typescript/bin/tsc', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', 'dist/server.js'], { cwd: root, stdio: 'inherit' }),
];
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
