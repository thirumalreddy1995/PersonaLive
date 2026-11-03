// Launches Electron against the running Vite dev server (npm run dev) for live-reload development.
const { spawn } = require('child_process');
const electron = require('electron');

const url = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', (code) => process.exit(code ?? 0));
