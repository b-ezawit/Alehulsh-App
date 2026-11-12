// Local Miniflare entry only. Never used by the deployment configuration.
import { createWorkersApp } from '../../src/workers/app.js';
import {FcmPrivatePushProvider} from '../../src/notifications/FcmPrivatePushProvider.js';
import { hashKeyword, verifyKeyword } from '../../src/crypto/keyword.js';
import { hashKeywordPortable, verifyKeywordPortable } from '../../src/crypto/keywordPortable.js';
import { R2ImmutablePublisher, type PublicationBucket } from '../../src/evidence/R2ImmutablePublisher.js';
const app = createWorkersApp();
type LocalBucket = Omit<PublicationBucket, 'put'> & {
  put(key: string, body: string | ReadableStream<Uint8Array>, options: unknown): Promise<unknown | null>;
};
export default {
  async fetch(request: Request, env: { LOCAL_BUCKET: LocalBucket;PRIVATE_PUSH_TEST_KEY:string; }) {
    const path = new URL(request.url).pathname;
    if(path==='/__test/private-push'){
      let oauth=0,sends=0;
      const provider=new FcmPrivatePushProvider({projectId:'synthetic-project',clientEmail:'synthetic@synthetic-project.iam.gserviceaccount.com',privateKey:env.PRIVATE_PUSH_TEST_KEY},async input=>{
        const r=input as Request;
        if(r.url==='https://oauth2.googleapis.com/token'){oauth++;return Response.json({access_token:'synthetic-oauth',expires_in:3600});}
        const body=await r.json() as {message:{data:Record<string,string>;token:string}};
        if(r.redirect!=='manual'||Object.keys(body.message.data).join()!=='deliveryId'||body.message.token!=='synthetic-device-token')throw Error('invalid provider envelope');
        sends++;return Response.json({name:'projects/synthetic-project/messages/synthetic-id'});
      });
      const result=await provider.send('synthetic-device-token',{deliveryId:'11111111-1111-4111-8111-111111111111'},AbortSignal.timeout(5000));
      return Response.json({oauth,sends,accepted:'messageId' in result});
    }
    if (path === '/__test/crypto') {
      const pepper = 'synthetic-local-only';
      const native = await hashKeyword('Tangerine', pepper);
      const portable = await hashKeywordPortable('Tangerine', pepper);
      return Response.json({
        nativeVerifiesPortable: await verifyKeyword('Tangerine', portable, pepper),
        portableVerifiesNative: await verifyKeywordPortable('Tangerine', native, pepper),
        rejectsWrongKeyword: !await verifyKeyword('wrong', native, pepper)
      });
    }
    if (path === '/__test/publication-failures') {
      const source = 'evidence/synthetic/incident/failure';
      await env.LOCAL_BUCKET.put(source, 'original', { httpMetadata: { contentType: 'audio/aac' } });
      let collisionRefused = false, truncationRefused = false;
      try {
        await new R2ImmutablePublisher({
          get: key => env.LOCAL_BUCKET.get(key),
          put: async () => null, delete: key => env.LOCAL_BUCKET.delete(key)
        }).publish(source, 'audio/aac');
      }
      catch { collisionRefused = true; }
      try {
        await new R2ImmutablePublisher({
          get: async key => { const object = await env.LOCAL_BUCKET.get(key); return object ? { body: object.body, httpMetadata: object.httpMetadata ?? {}, size: object.size + 1 } : null; },
          put: (...args) => env.LOCAL_BUCKET.put(...args), delete: key => env.LOCAL_BUCKET.delete(key)
        }).publish(source, 'audio/aac');
      }
      catch { truncationRefused = true; }
      return Response.json({ collisionRefused, truncationRefused });
    }
    if (path === '/__test/publication') {
      const source = 'evidence/synthetic/incident/note';
      await env.LOCAL_BUCKET.put(source, 'original', { httpMetadata: { contentType: 'audio/aac' } });
      const published = await new R2ImmutablePublisher(env.LOCAL_BUCKET).publish(source, 'audio/aac');
      await env.LOCAL_BUCKET.put(source, 'overwritten', { httpMetadata: { contentType: 'audio/aac' } });
      const object = await env.LOCAL_BUCKET.get(published.storagePath);
      const bytes = await new Response(object!.body).text();
      const collision = await env.LOCAL_BUCKET.put(published.storagePath, 'must not replace', {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'audio/aac' }
      });
      return Response.json({ bytes, collisionRefused: collision === null, sizeBytes: published.sizeBytes, sha256: published.sha256 });
    }
    return app.fetch(request, {});
  },
};
