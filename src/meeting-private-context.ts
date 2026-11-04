// Keep whole newest messages first. Cutting the head of a serialized chronological
// array can silently remove the owner's latest restriction. If even the newest
// message cannot fit, callers must decline the private decision rather than
// reasoning from an incomplete instruction.
const contextSize = (messages: {text:string;role?:string}[]) => messages.reduce((size,message) => size + message.text.length + (message.role?.length ?? 0) + 32, 2);

export function latestPrivateMessages(value: unknown, budget: number, order: 'oldest_first' | 'newest_first') {
  const messages: { text: string; role?: string }[] = [];
  if (!Array.isArray(value)) return { messages, incompleteLatest: false };
  const ordered = order === 'oldest_first' ? value.slice().reverse() : value;
  for (const item of ordered) {
    if (!item || typeof item.text !== 'string') continue;
    const message = { text: item.text, ...(typeof item.role === 'string' ? { role: item.role } : {}) };
    if (contextSize([...messages, message]) > budget) {
      return { messages, incompleteLatest: messages.length === 0 };
    }
    messages.push(message);
  }
  return { messages, incompleteLatest: false };
}

export function privateInstructionContext(notes: unknown, currentMessages: unknown) {
  const latestNotes = latestPrivateMessages(notes, 6500, 'oldest_first');
  const seen = new Set(latestNotes.messages.map(message => message.text));
  const recalled = Array.isArray(currentMessages) ? currentMessages.slice() : [];
  // MatterContext currently returns chronological rows, but sequence is the
  // authoritative journal order even if a caller supplies a different array order.
  const current = recalled.every(message => Number.isSafeInteger(message?.seq))
    ? recalled.sort((a, b) => b.seq - a.seq) : recalled.reverse();
  const currentLatestAlreadyIncluded = seen.has(current[0]?.text);
  const latestMessages = latestPrivateMessages(current.filter(message => !seen.has(message?.text)), 14000 - contextSize(latestNotes.messages), 'newest_first');
  return { latest_owner_notes: latestNotes.messages, latest_owner_messages: latestMessages.messages,
    instruction_order: 'newest_first' as const,
    incomplete_latest_instruction: latestNotes.incompleteLatest || (!currentLatestAlreadyIncluded && latestMessages.incompleteLatest) };
}
