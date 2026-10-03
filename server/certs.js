// TLS material. Prefers mkcert output in certs/ (trusted once the root CA is installed
// on the iPhones); otherwise generates a self-signed certificate for the LAN IPs.

import fs from 'node:fs';
import os from 'node:os';
import selfsigned from 'selfsigned';

export const CERT_DIR = 'certs';
const CERT = `${CERT_DIR}/cert.pem`;
const KEY = `${CERT_DIR}/key.pem`;
export const ROOT_CA = `${CERT_DIR}/rootCA.pem`;

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export async function loadOrCreateCerts() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
    return { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY), kind: 'mkcert/existing' };
  }
  const ips = ['127.0.0.1', ...lanAddresses()];
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'collision-demo.local' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))],
      },
    ],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private);
  return { cert: pems.cert, key: pems.private, kind: 'self-signed (generated)' };
}
