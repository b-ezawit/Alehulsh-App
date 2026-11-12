import type { FastifyInstance,FastifyReply } from 'fastify';
import { requireSubject,subjectOf } from '../auth/middleware.js';
import type { Deps } from '../server.js';
import { AppError } from '../errors.js';
import { normalizeEmail,normalizePhone } from '../crypto/identifier.js';
import type { ProfileUpdate } from '../repositories/postgres/PostgresProfileRepository.js';
import type { ContactWrite } from '../repositories/postgres/PostgresContactManagementRepository.js';

const profileSchema={type:'object',minProperties:1,additionalProperties:false,properties:{
  fullName:{type:'string',minLength:1,maxLength:120},homeAddress:{type:'string',maxLength:1000},phoneNumber:{type:['string','null'],maxLength:50},
  locationSharingEnabled:{type:'boolean'},autoAudioRecording:{type:'boolean'},fakeCallEnabled:{type:'boolean'},communityAlertsEnabled:{type:'boolean'}}};
const contactSchema={type:'object',required:['name','phone','isPrimary'],additionalProperties:false,properties:{
  name:{type:'string',minLength:1,maxLength:120},phone:{type:'string',minLength:1,maxLength:50},email:{type:'string',maxLength:320},
  relationship:{type:'string',maxLength:120},isPrimary:{type:'boolean'}}};
export function registerAccountRoutes(app:FastifyInstance,deps:Deps) {
  const querystring={type:'object',additionalProperties:false,properties:{}};
  const authenticate=requireSubject(deps.tokenVerifier);
  const unavailable=(reply:FastifyReply)=>reply.status(503).send({error:{code:'unavailable',message:'Service unavailable.'}});
  app.get('/v1/me/account',{onRequest:authenticate,schema:{querystring}},async(req,reply)=>{
    if(!deps.profiles)return unavailable(reply);
    return {provisioned:!!await deps.profiles.get(subjectOf(req).uid)};
  });
  app.get('/v1/me/profile',{onRequest:authenticate,schema:{querystring}},async(req,reply)=>{
    if(!deps.profiles)return unavailable(reply);const profile=await deps.profiles.get(subjectOf(req).uid);
    if(!profile)throw new AppError('not_found');return {profile,locationPreferenceScope:'future_alerts'};
  });
  app.patch<{Body:ProfileUpdate}>('/v1/me/profile',{onRequest:authenticate,schema:{body:profileSchema}},async(req,reply)=>{
    if(!deps.profiles)return unavailable(reply);const body={...req.body};
    if(body.fullName!==undefined){body.fullName=body.fullName.trim();if(!body.fullName)throw new AppError('invalid_request');}
    if(body.phoneNumber){const phone=normalizePhone(body.phoneNumber);if(!phone)throw new AppError('invalid_request');body.phoneNumber=phone;}
    else if(body.phoneNumber==='')body.phoneNumber=null;
    return {profile:await deps.profiles.update(subjectOf(req).uid,body),locationPreferenceScope:'future_alerts'};
  });
  app.get('/v1/me/contacts',{onRequest:authenticate,schema:{querystring}},async(req,reply)=>{
    if(!deps.contactManagement)return unavailable(reply);return {contacts:await deps.contactManagement.list(subjectOf(req).uid)};
  });
  app.put<{Params:{id:string};Body:ContactWrite}>('/v1/me/contacts/:id',{onRequest:authenticate,schema:{body:contactSchema}},async(req,reply)=>{
    if(!deps.contactManagement)return unavailable(reply);
    const id=req.params.id;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new AppError('invalid_request');
    const name=req.body.name.trim(),phone=normalizePhone(req.body.phone),email=req.body.email?normalizeEmail(req.body.email):'';
    if(!name||!phone||email===null)throw new AppError('invalid_request');
    const created=await deps.contactManagement.put(subjectOf(req).uid,id,{...req.body,name,phone,email,relationship:req.body.relationship??''});
    return reply.status(created?201:200).send({saved:true});
  });
  app.delete<{Params:{id:string}}>('/v1/me/contacts/:id',{onRequest:authenticate},async(req,reply)=>{
    if(!deps.contactManagement)return unavailable(reply);await deps.contactManagement.remove(subjectOf(req).uid,req.params.id);return reply.status(204).send();
  });
}
