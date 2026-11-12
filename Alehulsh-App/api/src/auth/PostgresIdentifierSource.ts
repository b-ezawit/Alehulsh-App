import type {Queryable} from '../db/pool.js';
import type {VerifiedIdentifierSource} from './VerifiedIdentifierSource.js';
import {hashEmail,hashPhone,identifiersMatch} from '../crypto/identifier.js';
/** Never treat a historical application profile hash as current provider proof. */
export class PostgresIdentifierSource implements VerifiedIdentifierSource {
  constructor(private readonly db:Queryable,private readonly pepper:string){if(!pepper.trim())throw Error('authoritative identifier pepper required');}
  async proves(uid:string,hash:string):Promise<boolean>{
    const {rows}=await this.db.query<{verified_phone:string|null;verified_email:string|null}>(
      'SELECT * FROM public.current_supabase_contact_identifiers($1)',[uid]);
    const row=rows[0];if(!row)return false;
    return [row.verified_phone?hashPhone(row.verified_phone,this.pepper):null,row.verified_email?hashEmail(row.verified_email,this.pepper):null]
      .some(value=>value!==null&&identifiersMatch(value,hash));
  }
}
