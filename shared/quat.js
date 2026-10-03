// Minimal quaternion helpers. Quaternions are [x, y, z, w] arrays (same order as Three.js).

const DEG = Math.PI / 180;

export function fromAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

export function multiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function normalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function conjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotate vector v by unit quaternion q. */
export function rotate(q, v) {
  const p = multiply(multiply(q, [v[0], v[1], v[2], 0]), conjugate(q));
  return [p[0], p[1], p[2]];
}

export function slerp(a, b, t) {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    return normalize([
      a[0] + t * (bx - a[0]),
      a[1] + t * (by - a[1]),
      a[2] + t * (bz - a[2]),
      a[3] + t * (bw - a[3]),
    ]);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [wa * a[0] + wb * bx, wa * a[1] + wb * by, wa * a[2] + wb * bz, wa * a[3] + wb * bw];
}

/**
 * W3C DeviceOrientation (alpha, beta, gamma in degrees, intrinsic Z-X'-Y'')
 * to a quaternion mapping device-frame vectors into the earth frame
 * (X east-ish, Y north-ish, Z up; alpha's zero is arbitrary on iOS unless corrected).
 */
export function fromDeviceOrientation(alpha, beta, gamma) {
  const qz = fromAxisAngle(0, 0, 1, (alpha || 0) * DEG);
  const qx = fromAxisAngle(1, 0, 0, (beta || 0) * DEG);
  const qy = fromAxisAngle(0, 1, 0, (gamma || 0) * DEG);
  return multiply(multiply(qz, qx), qy);
}

/** Earth frame (X east, Y north, Z up) -> Three.js frame (X east, Y up, Z south). */
export const ENU_TO_THREE = fromAxisAngle(1, 0, 0, -Math.PI / 2);
