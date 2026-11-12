import type {Queryable} from '../db/pool.js';
import {AppError} from '../errors.js';
import type {VerifiedIdentifierSource} from '../auth/VerifiedIdentifierSource.js';
import {PostgresIdentifierSource} from '../auth/PostgresIdentifierSource.js';
import {PostgresInboxRepository} from '../repositories/postgres/PostgresInboxRepository.js';
export interface PrivatePushProvider {
  /** Implementations must honor AbortSignal and never log tokens. Duplicate
   * provider acceptance after a lost response is possible; clients dedupe IDs. */
  send(token:string,data:{deliveryId:string},signal:AbortSignal):Promise<{messageId:string}|{invalidToken:true}>;
}
export class PrivateDelivery {
  constructor(private readonly db:Queryable,private readonly identifiers:VerifiedIdentifierSource){}
  async register(id:string,sessionId:string,token:string,version:string,revision=1):Promise<string>{
    try {return (await this.db.query<{generation:string}>('SELECT put_push_device($1::uuid,$2::uuid,$3,$4,$5::bigint) AS generation',[id,sessionId,token,version,revision])).rows[0]!.generation;}
    catch(e){const code=(e as {code?:string}).code;if(code==='23505')throw new AppError('conflict');if(code==='28000')throw new AppError('unauthenticated');throw e;}
  }
  async disable(id:string,generation:string|null,revision=1,sessionId?:string):Promise<void>{
    if(!sessionId){sessionId=(await this.db.query<{provider_session_id:string}>('SELECT provider_session_id FROM push_devices WHERE id=$1::uuid AND user_id=auth.uid()',[id])).rows[0]?.provider_session_id;}
    if(!sessionId)return;
    await this.db.query('SELECT disable_push_device($1::uuid,$2::uuid,$3::uuid,$4::bigint)',[id,sessionId,generation,revision]);
  }
  async open(id:string,stage:'received'|'opened'){
    const {rows}=await this.db.query<{alert_id:string;live:boolean}>(`UPDATE outbox o SET ${stage==='opened'?'opened_at':'device_received_at'}=coalesce(${stage==='opened'?'opened_at':'device_received_at'},clock_timestamp())
     FROM alerts a WHERE o.delivery_id=$1::uuid AND o.recipient_id=auth.uid() AND a.id=o.alert_id
      AND o.channel='private-push'
     RETURNING a.id::text AS alert_id,(a.status IN ('active','escalated') AND a.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM inbox i WHERE i.alert_id=a.id AND i.recipient_id=auth.uid())) AS live`,[id]);
    if(!rows[0])throw new AppError('not_found');
    // No coordinates or profile in a delivery response. Fetch the authorized inbox.
    let active=rows[0].live;
    if(active){
      const {rows:identities}=await this.db.query<{firebase_uid:string}>('SELECT firebase_uid FROM identity_map WHERE user_id=auth.uid()');
      active=!!identities[0]&&!!await new PostgresInboxRepository(this.db,this.identifiers).get(identities[0].firebase_uid,rows[0].alert_id);
    }
    return {incidentId:rows[0].alert_id,active};
  }
  async summary(alertId:string){
    const {rows}=await this.db.query(`SELECT count(*) FILTER(WHERE o.state IN ('pending','claimed'))::int AS queued,
     count(*) FILTER(WHERE o.published_at IS NOT NULL)::int AS provider_accepted,
     count(*) FILTER(WHERE o.device_received_at IS NOT NULL)::int AS device_received,
     count(*) FILTER(WHERE o.opened_at IS NOT NULL)::int AS opened,
     count(*) FILTER(WHERE o.state='abandoned')::int AS abandoned,
     (SELECT count(*)::int FROM inbox i JOIN alerts selected ON selected.id=i.alert_id
      WHERE selected.id=$1::uuid AND selected.owner_id=auth.uid()) AS selected_recipients,
     (SELECT count(*)::int FROM task_queue t JOIN alerts selected ON selected.id::text=t.payload->>'alertId'
      WHERE selected.id=$1::uuid AND selected.owner_id=auth.uid() AND t.kind='notify-contacts' AND t.state IN ('pending','claimed')) AS selection_pending,
     (SELECT count(*)::int FROM task_queue t JOIN alerts selected ON selected.id::text=t.payload->>'alertId'
      WHERE selected.id=$1::uuid AND selected.owner_id=auth.uid() AND t.kind='notify-contacts' AND t.state='abandoned') AS selection_abandoned
     FROM outbox o JOIN alerts a ON a.id=o.alert_id WHERE a.id=$1::uuid AND a.owner_id=auth.uid()
      AND o.channel='private-push' AND o.payload->>'kind'='incident'`,[alertId]);return rows[0];
  }
}

/** Bounded existing-outbox pass. No provider is selected or activated by default. */
export async function dispatchPrivateDeliveries(db:Queryable,provider:PrivatePushProvider,options:{worker:string;consentVersion:string;limit:number;timeoutMs:number;leaseMs:number;pepper:string;sessionPolicy:{maxAgeSeconds:number;inactivitySeconds:number}}){
  if(!options.worker||!options.consentVersion||!options.pepper.trim()||!Number.isInteger(options.limit)||options.limit<1||options.limit>100||
    !Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.leaseMs<=options.limit*options.timeoutMs)throw Error('bounded private delivery configuration required');
  // Claim only this channel; preserve other outbox consumers. Expired exhausted
  // claims become dead letters, including process death after provider dispatch.
  await db.query(`UPDATE outbox SET state='abandoned',claimed_by=NULL,claimed_until=NULL,last_error='attempts exhausted'
   WHERE channel='private-push' AND attempts>=max_attempts AND (state='pending' OR (state='claimed' AND claimed_until<clock_timestamp()))`);
  const {rows}=await db.query<{id:string}>(`WITH picked AS (SELECT id FROM outbox WHERE channel='private-push'
   AND attempts<max_attempts AND next_retry_at<=clock_timestamp()
   AND (state='pending' OR (state='claimed' AND claimed_until<clock_timestamp())) ORDER BY next_retry_at,id
   FOR UPDATE SKIP LOCKED LIMIT $2)
   UPDATE outbox o SET state='claimed',claimed_by=$1,claimed_until=clock_timestamp()+$3*interval '1 millisecond',attempts=attempts+1
   FROM picked p WHERE o.id=p.id RETURNING o.id::text`,[options.worker,options.limit,options.leaseMs]);
  let accepted=0,abandoned=0,retry=0;
  for(const row of rows){
    const valid=await db.query<{token:string;delivery_id:string;device_id:string;device_generation:string;subject:string;alert_id:string;kind:string}>(`SELECT d.token,o.delivery_id,o.device_id,o.device_generation,m.firebase_uid AS subject,o.alert_id::text,o.payload->>'kind' AS kind FROM outbox o
     JOIN push_devices d ON d.id=o.device_id AND d.generation=o.device_generation AND d.user_id=o.recipient_id
     JOIN identity_map m ON m.user_id=o.recipient_id
     JOIN alerts a ON a.id=o.alert_id
     WHERE o.id=$1::bigint AND o.state='claimed' AND o.claimed_by=$2 AND o.claimed_until>clock_timestamp()
      AND d.enabled AND d.token IS NOT NULL AND d.consent_version=$3
      AND public.private_device_session_active(d.id,$4::integer,$5::integer)
      AND (o.payload->>'kind'='reconcile' OR (a.status IN ('active','escalated') AND a.expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM inbox i WHERE i.alert_id=a.id AND i.recipient_id=o.recipient_id)))`,[row.id,options.worker,options.consentVersion,options.sessionPolicy.maxAgeSeconds,options.sessionPolicy.inactivitySeconds]);
    let device=valid.rows[0];
    if(device&&device.kind==='incident'&&!await new PostgresInboxRepository(db,new PostgresIdentifierSource(db,options.pepper)).get(device.subject,device.alert_id))device=undefined;
    if(!device){await db.query("UPDATE outbox SET state='abandoned',claimed_by=NULL,claimed_until=NULL,last_error='authorization no longer active' WHERE id=$1::bigint AND state='claimed' AND claimed_by=$2",[row.id,options.worker]);abandoned++;continue;}
    try{
      const result=await provider.send(device.token,{deliveryId:device.delivery_id},AbortSignal.timeout(options.timeoutMs));
      if('invalidToken' in result){
        await db.query('UPDATE push_devices SET enabled=false,token=NULL WHERE id=$1 AND generation=$2 AND token=$3',[device.device_id,device.device_generation,device.token]);
        await db.query("UPDATE outbox SET state='abandoned',claimed_by=NULL,claimed_until=NULL,last_error='invalid device token' WHERE id=$1::bigint AND state='claimed' AND claimed_by=$2 AND claimed_until>clock_timestamp()",[row.id,options.worker]);abandoned++;
      }else{
        if(!result.messageId||result.messageId.length>512)throw Error('invalid provider receipt');
        const completed=await db.query(`UPDATE outbox SET state='published',published_at=clock_timestamp(),provider_message_id=$3,
         claimed_by=NULL,claimed_until=NULL,last_error=NULL WHERE id=$1::bigint AND state='claimed' AND claimed_by=$2
          AND claimed_until>clock_timestamp() AND EXISTS(SELECT 1 FROM push_devices d WHERE d.id=outbox.device_id
           AND d.generation=outbox.device_generation AND d.enabled AND d.consent_version=$4)
          AND public.private_device_session_active(outbox.device_id,$5::integer,$6::integer)`,[row.id,options.worker,result.messageId,options.consentVersion,options.sessionPolicy.maxAgeSeconds,options.sessionPolicy.inactivitySeconds]);
        if(completed.rowCount)accepted++;
      }
    }catch(_){
      // Never persist provider exception text, which may contain the token.
      await db.query("SELECT complete_outbox($1::bigint,$2,false,'private provider unavailable')",[row.id,options.worker]);retry++;
    }
  }
  return {claimed:rows.length,accepted,abandoned,retry};
}
