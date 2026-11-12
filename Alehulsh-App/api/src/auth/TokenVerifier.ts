/**
 * Swap point #1 of 3. See docs/api-layer.md.
 *
 * Firebase Auth now. The replacement is NOT YET CHOSEN (M-04): Supabase Auth
 * is the obvious candidate because the RLS policies already read
 * `request.jwt.claim.sub`, but it is a third party holding phone numbers and
 * that interacts with the deferred data-residency decision. Nothing outside
 * this folder knows which one is in use, which is what keeps the choice open.
 */
export interface Subject {
  /** Stable identifier for the authenticated person. */
  uid: string;
}

export interface TokenVerifier {
  /** Resolves the bearer token, or throws. Never returns a partial subject. */
  verify(token: string): Promise<Subject>;
}
