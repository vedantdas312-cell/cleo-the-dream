export type KeikiScope = {userId:string;matterId:string;sessionId:string;audience:'private'|'meeting'};
export function conversationId(scope:KeikiScope):string;
export class Keiki {
  constructor(options:{apiKey:string;agentId:string;baseUrl?:string;fetchImpl?:typeof fetch});
  ask(input:{text:string;scope:KeikiScope;signal?:AbortSignal}):Promise<{text:string;conversationId:string}>;
}
export type PrivateNoticeStatus='not_configured'|'cancelled'|'unknown'|'queued'|'accepted_for_agent'|'unavailable';
export class KeikiPrivateMessenger {
  constructor(options:{apiKey:string;agentId:string;resolveRecipient:(owner:string)=>string|undefined|Promise<string|undefined>;line?:string;fetchImpl?:typeof fetch});
  send(input:{owner:string;text:string;signal?:AbortSignal}):Promise<{status:PrivateNoticeStatus}>;
}
