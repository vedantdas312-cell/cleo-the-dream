import { createHmac, timingSafeEqual } from 'node:crypto';
import { DocumentError } from './docx.ts';
import { type OwnerMeetingEvent } from './meeting-session.ts';

export function meetingCommandHelp() {
  return 'Speak or text naturally. Anyone in the meeting can address Cleo, request a document walkthrough, or reclaim the floor. iMessage guidance stays private. The channel and requested audience determine where a reminder is given; private notes are never read aloud. Speaking and sharing are separate requests. Nothing is accepted or signed.';
}
// The legacy webhook key authenticates the whole platform envelope, including
// inboundText. A model may request this tool but cannot supply its command text.
export function verifiedKeikiToolEvent(body: any, agentId: string, line: string, owner: string, now = Date.now()): OwnerMeetingEvent {
  const context = body?.context, channel = context?.channel;
  // Keiki's shared Blooio line stamps gateway; its dedicated Photon line
  // stamps teamId. Both are provider fields outside model-supplied input.
  const providerLine = channel?.provider === 'blooio' ? channel.gateway : channel?.teamId;
  if (context?.agentId !== agentId || context.internal === true || !channel || typeof channel !== 'object' ||
    !['sms','imessage'].includes(channel.channel) || !['photon','blooio'].includes(channel.provider) ||
    channel.isDirect !== true || providerLine !== line || channel.userId !== context.phone ||
    typeof channel.messageId !== 'string' || !/^[\w:.-]{1,200}$/.test(channel.messageId) ||
    typeof channel.inboundText !== 'string' || !channel.inboundText.trim() || channel.inboundText.length > 6000) {
    throw new DocumentError('Meeting controls need a verified direct message from the paired owner.');
  }
  return { id: channel.messageId, owner, text: channel.inboundText, at: new Date(now).toISOString(), channel:'imessage', isDirect:true };
}
export type VerifiedMeetingIdentity = {owner:string;phone:string;events:OwnerMeetingEvent[]};
// Consumes only the official signed identity callback. Model tool input is deliberately not accepted.
export function verifyKeikiMeetingIdentity(input:{rawBody:string;timestamp:string;signature:string;secret:string;agentId:string;line:string;
  resolveOwner:(phone:string)=>string|undefined;now?:number}):VerifiedMeetingIdentity {
  const now=input.now??Date.now(),instant=Number(input.timestamp)<1e12?Number(input.timestamp)*1000:Number(input.timestamp);
  if(input.secret.length<32||!/^\d+$/.test(input.timestamp)||!Number.isFinite(instant)||Math.abs(now-instant)>300000||!/^sha256=[a-f0-9]{64}$/.test(input.signature)||Buffer.byteLength(input.rawBody)>64000)throw new DocumentError('Invalid meeting identity signature.');
  const expected=createHmac('sha256',input.secret).update(`${input.timestamp}.${input.rawBody}`).digest();
  if(!timingSafeEqual(expected,Buffer.from(input.signature.slice(7),'hex')))throw new DocumentError('Invalid meeting identity signature.');
  let body:any;try{body=JSON.parse(input.rawBody);}catch{throw new DocumentError('Invalid meeting identity payload.');}
  if(body?.agent?.id!==input.agentId||body?.sender?.channel!=='photon'||body.sender.teamId!==input.line||body.sender.addressing?.isDm!==true
    ||typeof body.sender.userId!=='string'||body.internal===true||body.heldBack===true||body.silent===true)throw new DocumentError('Meeting controls require verified direct iMessage identity.');
  const owner=input.resolveOwner(body.sender.userId);
  if(!owner)throw new DocumentError('Meeting owner is not paired.');
  if(body.messages!==undefined&&(!Array.isArray(body.messages)||body.messages.length>10))throw new DocumentError('Invalid owner messages.');
  const events:OwnerMeetingEvent[]=[];
  for(const message of body.messages??[]) {
    if(!message||typeof message.id!=='string'||!/^[\w:.-]{1,200}$/.test(message.id)||typeof message.text!=='string'||!message.text.trim()||message.text.length>6000||message.silent===true)throw new DocumentError('Stable provider message evidence is required.');
    // Provider ID is stable across callback re-signing. Control keeps original text for dedupe.
    events.push({id:message.id,owner,text:message.text,at:new Date(instant).toISOString(),channel:'imessage',isDirect:true});
  }
  return {owner,phone:body.sender.userId,events};
}
