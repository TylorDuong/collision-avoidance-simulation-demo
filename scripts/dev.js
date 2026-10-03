// Development: rebuild the web app on change and restart the server on change.

import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', 'server/index.js'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
