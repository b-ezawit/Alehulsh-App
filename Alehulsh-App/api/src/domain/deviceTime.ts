/**
 * Reading the device's own clock off a request.  (sprint 3, P4)
 *
 * `occurredAt` is optional and informational. Its only job is to let a
 * recipient see that a position is two hours old; nothing decides anything
 * from it - expiry, escalation and authorization all run on the server clock.
 *
 * So the governing rule is: a bad value for this field must never cost her the
 * alert. Before this module, the route declared `format: 'date-time'` and
 * Fastify enforced it ahead of the handler, so a malformed timestamp returned
 * 400 and the SOS was simply lost. The handler's own lenient branch - and the
 * comment promising "never an error and never a guess" - was unreachable.
 *
 * The second rule is: an ambiguous value is UNKNOWN, not a guess.
 *
 * Dart's DateTime.now().toIso8601String() emits '2026-10-17T15:56:00.000' for
 * a local DateTime - no offset. That string names a different instant in every
 * timezone. `new Date()` would silently read it in the SERVER's timezone,
 * which is not where she is, and the delay computed from it would be wrong by
 * the offset between them - in Addis, three hours. A delay is how a recipient
 * judges whether a position is worth walking to, so being quietly wrong by
 * three hours is worse than admitting we do not know.
 *
 * Therefore an offset-less timestamp is discarded rather than interpreted, and
 * the alert proceeds with no device time at all.
 */

/**
 * Trailing UTC designator or numeric offset: 'Z', '+03:00', '-0800', '+03'.
 *
 * Anchored to the end so an offset is a property of the whole string, not
 * something that merely appears in it.
 */
const EXPLICIT_OFFSET = /(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/;

export type DeviceTimeRejection = 'absent' | 'no_offset' | 'unparseable';

export interface DeviceTimeResult {
  /** The instant, or null when it could not be established without guessing. */
  at: Date | null;
  /** Why it is null. Suitable for a metric; never contains the raw value. */
  rejection: DeviceTimeRejection | null;
}

/**
 * Resolve a client-supplied timestamp, or explain why it stays unknown.
 *
 * Never throws and never returns a value it had to assume. The `rejection`
 * exists so the server can count offset-less clients - the signal that would
 * tell us a client build is sending unusable timestamps - without logging the
 * timestamp itself.
 */
export function readDeviceTime(raw: unknown): DeviceTimeResult {
  if (raw === null || raw === undefined) return { at: null, rejection: 'absent' };
  if (typeof raw !== 'string') return { at: null, rejection: 'unparseable' };

  const text = raw.trim();
  if (text === '') return { at: null, rejection: 'absent' };

  // Ambiguity is refused BEFORE parsing, because Date would resolve it
  // against the server's timezone and hand back something plausible.
  if (!EXPLICIT_OFFSET.test(text)) return { at: null, rejection: 'no_offset' };

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return { at: null, rejection: 'unparseable' };

  return { at: parsed, rejection: null };
}
