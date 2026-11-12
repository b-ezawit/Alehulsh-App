import type {Hono} from 'hono';
import type {WorkerBindings,ReadRepositories} from './app.js';
import type {SupabaseSubject} from './SupabaseTokenVerifier.js';
import {Unavailable} from './availability.js';
import {AppError} from '../errors.js';
import {validatedJson} from './validation.js';
type Env={Bindings:WorkerBindings;Variables:{subject:SupabaseSubject;providerSubject:SupabaseSubject;accountMapped:boolean}};
type Repositories=<T>(env:WorkerBindings,subject:SupabaseSubject,run:(repos:ReadRepositories)=>Promise<T>)=>Promise<T>;
function uuid(id:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new AppError('invalid_request');return id;}
export function registerDeliveryRoutes(app:Hono<Env>,withRepositories:Repositories){
  app.get('/v1/me/notification-policy',c=>{
    if(!c.env.PUSH_CONSENT_VERSION?.trim()||!c.env.PUSH_CONSENT_TEXT?.trim())throw new Unavailable();
    return c.json({version:c.env.PUSH_CONSENT_VERSION,text:c.env.PUSH_CONSENT_TEXT});
  });
  app.put('/v1/me/devices/:id',async c=>{
    const id=uuid(c.req.param('id'));
    const body=await validatedJson<{token:string;consentVersion:string;revision:number}>(c.req.raw,{type:'object',required:['token','consentVersion','revision'],additionalProperties:false,
      properties:{token:{type:'string',minLength:20,maxLength:4096},consentVersion:{type:'string',minLength:1,maxLength:200},revision:{type:'integer',minimum:1,maximum:9007199254740991}}});
    if(!c.env.PUSH_CONSENT_VERSION?.trim()||!c.env.PUSH_CONSENT_TEXT?.trim())throw new Unavailable();
    if(body.consentVersion!==c.env.PUSH_CONSENT_VERSION)throw new AppError('conflict');
    const generation=await withRepositories(c.env,c.get('subject'),r=>{
      if(!r.deliveries)throw new Unavailable();return r.deliveries.register(id,c.get('providerSubject').sessionId,body.token,body.consentVersion,body.revision);
    });return c.json({registered:true,generation});
  });
  app.delete('/v1/me/devices/:id',async c=>{
    const id=uuid(c.req.param('id'));
    const body=await validatedJson<{generation?:string|null;revision:number}>(c.req.raw,{type:'object',required:['revision'],additionalProperties:false,
      properties:{generation:{type:['string','null']},revision:{type:'integer',minimum:1,maximum:9007199254740991}}});
    const generation=body.generation?uuid(body.generation):null;
    await withRepositories(c.env,c.get('subject'),r=>{if(!r.deliveries)throw new Unavailable();return r.deliveries.disable(id,generation,body.revision,c.get('providerSubject').sessionId);});return c.body(null,204);
  });
  app.post('/v1/me/deliveries/:id/receipt',async c=>{
    const id=uuid(c.req.param('id'));
    const body=await validatedJson<{stage:'received'|'opened'}>(c.req.raw,{type:'object',required:['stage'],additionalProperties:false,properties:{stage:{enum:['received','opened']}}});
    const result=await withRepositories(c.env,c.get('subject'),r=>{if(!r.deliveries)throw new Unavailable();return r.deliveries.open(id,body.stage);});return c.json(result);
  });
}
