// Two-way acoustic ranging ("BeepBeep", Peng et al. 2007).
//
// A and B each record both chirps. With a1/a2 = arrival of A's/B's chirp in A's
// recording and b1/b2 the same in B's recording (each on its own sample clock):
//
//   (a2 − a1) − (b2 − b1) = (2·d_AB − d_AA − d_BB) / c
//
// so d_AB = c/2 · [(a2 − a1)/fsA − (b2 − b1)/fsB] + K, with K = (d_AA + d_BB)/2,
// the mean speaker-to-own-mic distance. Clock offsets and audio I/O latencies cancel.

/** c/2 · [(a2 − a1)/fsA − (b2 − b1)/fsB], i.e. the distance before adding K. */
export function rawRange({ a1, a2, fsA, b1, b2, fsB }, c) {
  return (c / 2) * ((a2 - a1) / fsA - (b2 - b1) / fsB);
}

export function range(arrivals, c, K) {
  return rawRange(arrivals, c) + K;
}

/** K that makes a set of raw ranges measured at a known distance come out right. */
export function solveK(rawRanges, knownDistance) {
  const sorted = [...rawRanges].sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1];
  return knownDistance - median;
}
