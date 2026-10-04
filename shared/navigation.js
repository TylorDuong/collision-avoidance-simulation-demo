// Lateral navigation helpers shared by the airspace simulator, the server and the dashboard.
// Pure functions on plain objects, so a route can come from the simulator, a real flight
// plan or ESP32 telemetry without changing the display.
//
// Frame and units: SI (metres, m/s, seconds); x = east, y = north; angles in degrees,
// clockwise from north (true; no magnetic variation is modelled).
//   nav state  { x, y, heading, groundSpeed }   own position, heading (deg) and GS (m/s)
//   route      { active, waypoints: [{ id, x, y }] }
//              `active` indexes the TO waypoint; the one before it is the FROM waypoint.
//              active === waypoints.length means the route is finished.
//   wind       { direction, speed }   direction the wind blows FROM (deg), speed (m/s)

const DEG = Math.PI / 180;

/** Standard rate turn, deg/s. */
export const STANDARD_RATE = 3;
const MAX_ANTICIPATED_TURN = 120; // deg; larger turns are sequenced on passing the waypoint
const MIN_ETA_SPEED = 0.5; // m/s; slower than this, time to go is not meaningful

/** Angle in [0, 360). */
export function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Signed shortest turn from `b` to `a`, in (-180, 180]. */
export function angleDiff(a, b) {
  const d = wrap360(a - b);
  return d > 180 ? d - 360 : d;
}

/** True bearing (deg) from point `from` to point `to`. */
export function bearingTo(from, to) {
  return wrap360(Math.atan2(to.x - from.x, to.y - from.y) / DEG);
}

export function distanceTo(from, to) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * True airspeed from the ground velocity and the wind: |ground velocity − wind velocity|.
 * Without wind, TAS equals GS. Returns null when GS or the track is unknown.
 */
export function trueAirspeed(track, groundSpeed, wind = null) {
  if (track === null || track === undefined || groundSpeed === null || groundSpeed === undefined) return null;
  if (!wind) return groundSpeed;
  const to = (wind.direction + 180) * DEG; // the wind blows towards the opposite direction
  const ax = groundSpeed * Math.sin(track * DEG) - wind.speed * Math.sin(to);
  const ay = groundSpeed * Math.cos(track * DEG) - wind.speed * Math.cos(to);
  return Math.hypot(ax, ay);
}

/**
 * Advance `route.active` past every waypoint the aircraft has reached: fly-by with turn
 * anticipation (standard-rate turn radius × tan(turn / 2)), or the aircraft has passed the
 * line through the TO waypoint square to the leg. Mutates `route`.
 * @returns {boolean} true when the active waypoint changed
 */
export function sequenceRoute(route, state) {
  const start = route.active;
  while (route.active < route.waypoints.length) {
    const to = route.waypoints[route.active];
    const from = route.waypoints[route.active - 1];
    const next = route.waypoints[route.active + 1];
    const legCourse = from ? bearingTo(from, to) : bearingTo(state, to);
    let passed = false;
    if (from) {
      const along = (state.x - to.x) * Math.sin(legCourse * DEG) + (state.y - to.y) * Math.cos(legCourse * DEG);
      passed = along >= 0;
    }
    let anticipation = 0;
    if (next && state.groundSpeed > 0) {
      const turn = Math.abs(angleDiff(bearingTo(to, next), legCourse));
      if (turn <= MAX_ANTICIPATED_TURN) anticipation = (state.groundSpeed / (STANDARD_RATE * DEG)) * Math.tan((turn / 2) * DEG);
    }
    if (!passed && distanceTo(state, to) > anticipation) break;
    route.active++;
  }
  return route.active !== start;
}

/**
 * Navigation picture for the display, relative to the own aircraft (like TCAS traffic):
 *   waypoints  the remaining route from the FROM waypoint on, each { id, range (m),
 *              bearing (deg, relative to own heading), active }
 *   active     the TO waypoint: { id, course (true bearing to it, deg), distance (m),
 *              eta (s to go at the current GS, null when not moving) }, or null at the
 *              end of the route
 * Returns null without a route.
 */
export function navPicture(state, route) {
  if (!route?.waypoints?.length) return null;
  const heading = state.heading ?? 0;
  const first = Math.max(0, Math.min(route.active, route.waypoints.length) - 1);
  const waypoints = route.waypoints.slice(first).map((w, i) => ({
    id: w.id,
    range: distanceTo(state, w),
    bearing: wrap360(bearingTo(state, w) - heading),
    active: first + i === route.active,
  }));
  const to = route.waypoints[route.active];
  let active = null;
  if (to) {
    const distance = distanceTo(state, to);
    const gs = state.groundSpeed;
    active = { id: to.id, course: bearingTo(state, to), distance, eta: gs > MIN_ETA_SPEED ? distance / gs : null };
  }
  return { waypoints, active };
}
