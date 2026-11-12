/** An account's identifier ownership must come from the identity provider,
 * never a writable profile flag or a matching display name. */
export interface VerifiedIdentifierSource {
  proves(uid: string, identifierHash: string): Promise<boolean>;
}
