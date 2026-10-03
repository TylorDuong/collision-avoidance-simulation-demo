// Creates a locally-trusted TLS certificate with mkcert for localhost + this machine's
// LAN IPs, and copies mkcert's root CA into certs/ so the server can offer it to iPhones.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lanAddresses, CERT_DIR, ROOT_CA } from '../server/certs.js';

const run = (args) => spawnSync('mkcert', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

if (run(['-help']).error) {
  console.error(`mkcert was not found on PATH. Install it, then rerun \`npm run certs\`:
  winget install FiloSottile.mkcert     (or: choco install mkcert / scoop install mkcert)`);
  process.exit(1);
}

console.log('Installing the mkcert root CA into this machine\'s trust store (may prompt)…');
run(['-install']);

const hosts = ['localhost', '127.0.0.1', ...lanAddresses()];
fs.mkdirSync(CERT_DIR, { recursive: true });
const res = run(['-cert-file', `${CERT_DIR}/cert.pem`, '-key-file', `${CERT_DIR}/key.pem`, ...hosts]);
if (res.status !== 0) process.exit(res.status ?? 1);

const caroot = run(['-CAROOT']).stdout.trim();
fs.copyFileSync(path.join(caroot, 'rootCA.pem'), ROOT_CA);

console.log(`\nCertificate for: ${hosts.join(', ')}`);
console.log(`Root CA copied to ${ROOT_CA}. After \`npm start\`, open http://<laptop-ip>:8080/ca on each iPhone to install it.`);
