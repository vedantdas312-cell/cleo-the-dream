import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cleoSharedPolicy} from '../src/cleo-shared-policy.mjs';
import {cleoVoiceInstructions} from '../src/voice-policy.mjs';
import {googleToken} from '../src/google-auth.mjs';
test('iMessage and voice load the identical shared policy while retaining distinct capabilities',async()=>{
 const imessage=await readFile('config/cleo-instructions.md','utf8');
 assert.equal(imessage.split('<!-- shared-policy:start -->\n')[1].split('\n<!-- shared-policy:end -->')[0],cleoSharedPolicy);
 assert.ok(cleoVoiceInstructions.startsWith(cleoSharedPolicy));
 assert.match(cleoVoiceInstructions,/cannot accept or reject suggestions, send messages/);
 assert.match(cleoVoiceInstructions,/Only a verified_suggestion receipt/);
 assert.match(imessage,/Call redline_contract/);
});
test('hosted Google authorization refreshes from secret values without reading credential files',async()=>{
 let calls=0;
 const token=googleToken({accessToken:'',credentialsPath:'/missing',clientPath:'/missing',credentialsJson:JSON.stringify({refresh_token:'fake-refresh'}),clientJson:JSON.stringify({installed:{client_id:'fake-client',client_secret:'fake-secret'}}),fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(init.body.get('refresh_token'),'fake-refresh');assert.equal(init.redirect,'error');return Response.json({access_token:'fake-access',expires_in:3600});
 }});
 assert.equal(await token(),'fake-access');assert.equal(await token(),'fake-access');assert.equal(calls,1);
});
