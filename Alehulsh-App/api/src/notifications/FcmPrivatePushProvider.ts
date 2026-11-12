import {JWT} from 'google-auth-library';
import type {PrivatePushProvider} from './PrivateDelivery.js';

/** Official Google service-account Auth SDK, confined to its token endpoint.
 * No ambient/default credentials, metadata server, topic or caller URL. */
export class FcmPrivatePushProvider implements PrivatePushProvider {
  private auth:JWT|undefined;
  constructor(private readonly config:{projectId:string;clientEmail:string;privateKey:string},
    private readonly fetcher:typeof fetch=fetch){
    if(!/^[a-z][a-z0-9-]{4,62}$/.test(config.projectId)||
      !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.clientEmail)||
      !config.privateKey.startsWith('-----BEGIN PRIVATE KEY-----'))throw Error('explicit private push credentials required');
  }
  private authFor(signal:AbortSignal){
    const config=this.config;
    const auth=new JWT({email:config.clientEmail,key:config.privateKey,scopes:['https://www.googleapis.com/auth/firebase.messaging'],useAuthRequestParameters:false,
      transporterOptions:{timeout:5000,retry:false,retryConfig:{retry:0},maxRedirects:0,fetchImplementation:async(input,init)=>{
        const url=new URL(input instanceof Request?input.url:String(input));
        if(url.href!=='https://oauth2.googleapis.com/token')throw Error('Auth origin refused');
        return this.bounded(new Request(input,init),AbortSignal.any([signal,AbortSignal.timeout(5000)]));
      }}});
    if(this.auth)auth.setCredentials(this.auth.credentials);
    this.auth=auth;return auth;
  }
  private async bounded(request:Request,signal:AbortSignal):Promise<Response>{
    const combined=AbortSignal.any([signal,request.signal]);
    combined.throwIfAborted();
    const response=await this.fetcher(new Request(request,{redirect:'manual',signal:combined}));
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw Error('provider redirect refused');}
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{
      if(reader)for(;;){
        combined.throwIfAborted();const part=await reader.read();if(part.done)break;
        size+=part.value.byteLength;if(size>64*1024)throw Error('provider response limit');chunks.push(part.value);
      }
    }finally{await reader?.cancel();}
    const bytes=new Uint8Array(size);let position=0;for(const part of chunks){bytes.set(part,position);position+=part.byteLength;}
    return new Response(bytes,{status:response.status,headers:response.headers});
  }
  async send(token:string,data:{deliveryId:string},signal:AbortSignal){
    try{
      if(!/^[0-9a-f-]{36}$/i.test(data.deliveryId)||token.length<20||token.length>4096)throw Error('invalid private delivery');
      signal.throwIfAborted();const access=await this.authFor(signal).getAccessToken();signal.throwIfAborted();
      if(!access.token)throw Error('provider authentication unavailable');
      const response=await this.bounded(new Request(`https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`,{
        method:'POST',headers:{authorization:`Bearer ${access.token}`,'content-type':'application/json'},
        body:JSON.stringify({message:{token,data:{deliveryId:data.deliveryId},android:{priority:'high'}}}),
      }),signal);
      const result=await response.json() as {name?:unknown;error?:{details?:Array<{errorCode?:string}>}};
      if(response.status===404&&result.error?.details?.some(d=>d.errorCode==='UNREGISTERED'))return {invalidToken:true as const};
      // Project/auth/permission failures must never invalidate a user's token.
      if(!response.ok||typeof result.name!=='string'||!result.name.startsWith(`projects/${this.config.projectId}/messages/`))throw Error('provider unavailable');
      return {messageId:result.name};
    }catch(_){throw Error('private push unavailable');}
  }
}
