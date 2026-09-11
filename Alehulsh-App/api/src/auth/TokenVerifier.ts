/**
 * Swap point #1 of 3. See docs/api-layer.md.
 *
 * Firebase Auth now; a self-hosted IdP after C-04 (M-04), because Art 22(1)
 * does not permit phone numbers to sit on Google's servers. Nothing outside
 * this folder knows which one is in use.
 */
export interface Subject {
  /** Stable identifier for the authenticated person. */
  uid: string;
}

export interface TokenVerifier {
  /** Resolves the bearer token, or throws. Never returns a partial subject. */
  verify(token: string): Promise<Subject>;
}
