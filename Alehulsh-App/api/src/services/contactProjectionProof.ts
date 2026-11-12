import type {VerifiedIdentifierSource} from '../auth/VerifiedIdentifierSource.js';
import type {AlertProjection} from '../repositories/types.js';
export async function contactProjectionProven(source:VerifiedIdentifierSource|undefined,uid:string,p:AlertProjection):Promise<boolean>{
  if(!source||p.audience!=='contact')return true;
  const hashes=p.contactIdentifierHashes;
  if(!Array.isArray(hashes)||!hashes.length||hashes.length>12)return false;
  for(const hash of hashes)if(typeof hash==='string'&&/^[a-zA-Z0-9_-]{43}$/.test(hash)&&await source.proves(uid,hash))return true;
  return false;
}
