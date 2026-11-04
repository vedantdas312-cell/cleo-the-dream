import { DocumentError } from './docx.ts';

export type KeikiIdentity = { agentId: string; line: string };
export type Sender = { owner: string; phone: string; agentId: string; line: string };

// Call only AFTER authenticating the complete Keiki webhook. These fields are
// platform-stamped context, never model arguments or a phone in message text.
export function verifiedKeikiSender(body: any, identity: KeikiIdentity): string {
  const context = body?.context, channel = context?.channel;
  const line = channel?.provider === 'blooio' ? channel.gateway : channel?.teamId;
  if (context?.agentId !== identity.agentId || context.internal || !channel || typeof channel !== 'object'
    || !['sms', 'imessage'].includes(channel.channel) || !['photon', 'blooio'].includes(channel.provider)
    || channel.isDirect !== true || line !== identity.line || channel.userId !== context.phone
    || typeof context.phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(context.phone)) {
    throw new DocumentError('This tool requires a verified direct iMessage or SMS from this Cleo conversation.');
  }
  return context.phone;
}
