// 之前轮次的思考不再发回模型（2026-10-09，所有者：思考要像通用做法那样过滤，由应用端处理）。
//
// dsh 把模型每一步的思考（`reasoning` 块）记进对话，之后每次请求都原样发回；本地 Qwen 的模板在不传 preserve_thinking
// 时全部保留，思考逐轮累积。通用做法是：当前这一轮保留（同一轮里模型调工具、拿结果、再接着推理，要看得到自己刚才的
// 思路），更早轮次的丢掉。这里按这个做法，在每次请求模型之前改写对话：最后一条用户消息之前的模型回答，去掉其中的
// 思考块，正文与工具调用原样保留。与模型服务的设置无关。
//
// 不变式（中文写明，便于审计）：
//   1. 只去掉 `reasoning` 块，不改任何正文、工具调用或工具结果；被去掉的只是推理过程，结论留在回答、调用参数与 Board 上。
//   2. 用 dsh 的“替换”记录（与板视图转录同一做法）：原记录仍在日志里，界面显示原文；改写只依据对话记录本身，重放结果相同；
//      已经去掉的不再改，所以每来一条新的用户消息，只改一次上一轮的回答，前缀其余部分逐字不变。
//   3. “一轮”从一条用户消息开始；最后一条用户消息之后的回答（当前这一轮）一律不动。

const REASONING = 'reasoning';

/** 改写这个对话：最后一条用户消息之前、带思考块的模型回答去掉思考块。返回改写了几条。 */
export function stripPriorReasoning(session) {
  const seqs = [...session.surface.nodes];
  let lastUser = -1;
  seqs.forEach((seq, index) => {
    const event = session.eventAt(seq);
    if (event?.type === 'user/message' || session.deriveEventMessage(event)?.role === 'user') lastUser = index;
  });
  let rewritten = 0;
  for (let index = 0; index < lastUser; index += 1) {
    const seq = seqs[index];
    const event = session.eventAt(seq);
    if (event?.type !== 'assistant/message') continue;
    const message = session.deriveEventMessage(event);
    const content = Array.isArray(message?.content) ? message.content : [];
    if (!content.some((block) => block?.type === REASONING)) continue;
    const kept = content.filter((block) => block?.type !== REASONING);
    // 只有思考、没有正文与工具调用的回答：留一个空正文块，请求时它与没有内容的回答一样被略过。
    const next = kept.length > 0 ? kept : [{ type: 'text', text: '' }];
    session.append('assistant/message', { ...event.data, message: { ...message, content: next } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    });
    rewritten += 1;
  }
  return rewritten;
}

/** 挂到 dsh 的 agent/pre-step：每次请求模型之前改写一次；出错只记日志，对话照常按原样继续。 */
export function installThinkingHistory(ctx) {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      if (agent?.session) stripPriorReasoning(agent.session);
    } catch (error) {
      ctx.logger?.warn?.(`rulith thinking history: left the conversation as it was (${String(error?.message ?? error).slice(0, 300)})`);
    }
    return next();
  });
}
