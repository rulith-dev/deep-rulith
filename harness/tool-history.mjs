// D-1012g: project old tool calls for the model, retaining the original events for the person's transcript.
const RENAMES = Object.freeze({ QueryBoard: 'Get', ApplyBatch: 'Set', ApplyAction: 'Execute', ReadArtifact: 'Get' });

export function projectToolCall(block) {
  if (block?.type !== 'tool-call' || !Object.hasOwn(RENAMES, block.name)) return block;
  if (block.name !== 'ReadArtifact') return { ...block, name: RENAMES[block.name] };
  const { ref, offset } = block.input ?? {};
  return { ...block, name: 'Get', input: { artifact: { ref, ...(offset === undefined ? {} : { offset }) } } };
}

/** Use dsh's surface replacements; do not rewrite saved calls or rename user text and result data. */
export function rewriteToolHistory(session) {
  let rewritten = 0;
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type !== 'assistant/message') continue;
    const message = session.deriveEventMessage(event);
    if (!Array.isArray(message?.content)) continue;
    const content = message.content.map(projectToolCall);
    if (content.every((block, index) => block === message.content[index])) continue;
    session.append('assistant/message', { ...event.data, message: { ...message, content } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    });
    rewritten += 1;
  }
  return rewritten;
}

export function installToolHistory(ctx) {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent?.session) rewriteToolHistory(agent.session);
    return next();
  });
}
