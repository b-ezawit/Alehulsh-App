export const alertCreateSchema = {
  type: 'object',
  required: ['requestId'],
  additionalProperties: false,
  properties: {
    // Client-generated, stable across retries. Idempotency key.
    requestId: { type: 'string', minLength: 8, maxLength: 128 },
    // Nullable on purpose. P1-17 removed the fabricated Addis fallback —
    // "we do not know where she is" is a real state and must survive the wire.
    latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
    longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
    // Device clock, for staleness labelling only (P3-13). Never trusted for
    // expiry, escalation timing, or any authorization decision.
    //
    // `format: 'date-time'` was REMOVED here (sprint 3, P4). Fastify enforces
    // format before the handler runs, so a malformed timestamp - including
    // the offset-less string Dart emits for a local DateTime - returned 400
    // and lost the entire SOS over an informational field. The value is now
    // validated in the handler by readDeviceTime, which normalises anything
    // unusable to "unknown" instead of refusing the request. maxLength stays,
    // because an unbounded string is a different problem.
    occurredAt: { type: ['string', 'null'], maxLength: 64 },
    /**
     * Location EVIDENCE (sprint 3, P2). The client reports what its provider
     * told it; the server decides what that supports. There is deliberately
     * no `locationQuality` field - see src/domain/location.ts.
     */
    accuracyMeters: { type: ['number', 'null'], exclusiveMinimum: 0 },
    locationAgeMs: { type: ['number', 'null'], minimum: 0 },
  },
} as const;

export const keywordChangeSchema = {
  type: 'object',
  required: ['keyword'],
  additionalProperties: false,
  properties: {
    keyword: { type: 'string', minLength: 1, maxLength: 256 },
    currentKeyword: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export const keywordConfirmSchema = {
  type: 'object',
  required: ['keyword'],
  additionalProperties: false,
  properties: { keyword: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;
