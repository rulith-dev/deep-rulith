// Deep Rulith 的板视图转录（D-1008e，所有者 2026-10-08 批准沿用最初 galaxy-core 的 delta-history 设计）。
//
// Rulith 每个工具结果都带当时整块板（view）和操作条（operations）。原样留在对话里，几十份几乎相同的板叠在一起：
// 模型要自己比对哪里变了（幻觉的来源），旧板还可能被当成当前局面，上下文也越滚越大。这里在每次请求模型之前，
// 把对话里 Rulith 的结果改写成两种形态（只改模型看到的那份；界面上的对话原文不变）：
//   - 最新一份：整块板，每行一项；比上一份板新增的行前标 `+`，消失的行以 `-` 列出；
//   - 更早的：只留这一步的变化（`+`／`-` 行）。
// 结果本身（accepted、result、teaching、errorCode 等）每一份都原样保留，所以失败一步的教学不会被压掉。
//
// 不变式（中文写明，便于审计）：
//   1. 变化相对的是“这个对话里上一份板”，一步不跳；从第一份板起把各步变化依次叠加，正好得到最新整块板。
//      第一份板没有前一份，它的每一行都标 `+`，所以历史里第一份就是当时的整块板。
//   2. 改写只依据对话记录本身（无内存状态），重启或回放后重算结果相同；已经改好的不再改，所以每一步通常只把
//      上一份“最新”降为变化，前缀其余部分逐字不变，模型服务的前缀缓存照常命中。
//   3. 这不是第二份真相：板的真相仍在 Rulith，这里只是把它沿时间拆成“历次变化 + 最新全量”给模型看。
//   4. 读不懂的结果（传输错误、ReadArtifact 等不带板的结果）原样不动。

const FULL_PREFIX = 'Board now (';
const DELTA_PREFIX = 'Board changes at this step';
export const FULL_HEAD = 'Board now (whole Board; + added, - removed since your previous Board):';
export const FULL_FIRST = 'Board now (whole Board; your first Board in this conversation, so every line is +):';
export const DELTA_HEAD = 'Board changes at this step (+ added, - removed; the latest result shows the whole Board):';
export const DELTA_NONE = 'Board changes at this step: none (the latest result shows the whole Board).';
const ERROR_PREFIX = 'Error: ';

/** 板摊成行：对象逐键展开，数组每个元素一行（元素本身是一行 JSON），标量一行。行内不含换行（JSON 已转义）。 */
function flatten(prefix, value, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(`${prefix}: []`);
    for (const item of value) out.push(`${prefix}: ${JSON.stringify(item)}`);
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) out.push(`${prefix}: {}`);
    for (const key of keys) flatten(`${prefix}.${key}`, value[key], out);
  } else {
    out.push(`${prefix}: ${JSON.stringify(value)}`);
  }
}

/** 一份 Rulith 回答（工具结果里的那层 JSON）的板行：view 的各段，再加 operations。 */
export function boardLines(answer) {
  const out = [];
  for (const key of Object.keys(answer.view)) flatten(key, answer.view[key], out);
  if (Object.hasOwn(answer, 'operations')) flatten('operations', answer.operations, out);
  return out;
}

/** 回答中除板以外的部分（结果、教学、错误码……），一行紧凑 JSON。 */
function restLine(answer, isError) {
  const { view: _view, operations: _operations, ...rest } = answer;
  return (isError ? ERROR_PREFIX : '') + JSON.stringify(rest);
}

const countLines = (lines) => {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};
const expand = (counts) => [...counts].flatMap(([line, n]) => Array(n).fill(line));
const section = (line) => line.slice(0, line.indexOf(': '));

/** 多重集比较：curr 中多出来的行标 `+`；prev 中没有了的行另列为 `-`，放在同一段最后一行之后。 */
function mark(prev, curr) {
  const remaining = new Map(prev ?? []);
  const rows = curr.map((line) => {
    const left = remaining.get(line) ?? 0;
    if (left > 0) { remaining.set(line, left - 1); return { mark: ' ', line }; }
    return { mark: '+', line };
  });
  // 消失的行按字典序排列，与 prev 是怎样得来的（原样／整块／由变化叠加）无关，重算总得到同一段文本。
  for (const gone of expand(remaining).sort()) {
    const at = rows.findLastIndex((row) => section(row.line) === section(gone));
    rows.splice(at === -1 ? rows.length : at + 1, 0, { mark: '-', line: gone });
  }
  return rows;
}

/** 最新一份：结果行 + 整块板（带 +／-）。prev 为 null 表示本对话还没有过板。 */
export function renderFull(first, curr, prev) {
  const rows = mark(prev, curr);
  return [first, prev === null ? FULL_FIRST : FULL_HEAD, ...rows.map((row) => `${row.mark} ${row.line}`)].join('\n');
}

/** 历史一份：结果行 + 只有变化的行。 */
export function renderDelta(first, curr, prev) {
  const changed = mark(prev, curr).filter((row) => row.mark !== ' ');
  return [first, changed.length > 0 ? DELTA_HEAD : DELTA_NONE, ...changed.map((row) => `${row.mark} ${row.line}`)].join('\n');
}

/**
 * 认出一份工具结果的形态。
 * - raw：Rulith 原样的回答（可能带 dsh 加的 `Error: ` 前缀），且带板；
 * - full／delta：已经改写过的；
 * - null：不是带板的 Rulith 结果，不动。
 */
export function classify(text) {
  const [, second = ''] = text.split('\n', 2);
  if (second.startsWith(FULL_PREFIX)) return { kind: 'full', text };
  if (second.startsWith(DELTA_PREFIX)) return { kind: 'delta', text };
  const isError = text.startsWith(ERROR_PREFIX);
  try {
    const outer = JSON.parse(isError ? text.slice(ERROR_PREFIX.length) : text);
    if (!outer || !Array.isArray(outer.content)) return null;
    const answer = JSON.parse(outer.content.map((part) => part?.text ?? '').join(''));
    if (!answer || typeof answer !== 'object' || !answer.view || typeof answer.view !== 'object' || Array.isArray(answer.view)) return null;
    return { kind: 'raw', first: restLine(answer, isError), lines: boardLines(answer) };
  } catch {
    return null;
  }
}

/** 已改写文本里的结果行与板：full 给出当时整块板；delta 给出变化（叠加到上一份上）。 */
function parseRendered(item) {
  const lines = item.text.split('\n');
  // 只认带标记的板行；最新一份末尾可能附有写板提醒（WRITE_NOTE），它不是板的一部分。
  const rows = lines.slice(2).filter((line) => /^[ +-] /.test(line)).map((line) => ({ mark: line[0], line: line.slice(2) }));
  return { first: lines[0], rows };
}

/**
 * 给出对话里每一份带板结果应有的文本。items 按对话顺序给出 classify 的结果（null 已滤掉）；
 * 返回与之对齐的数组：需要改写的给新文本，已经是应有形态的给 null。
 */
// G1（D-1008j，取自 galaxy-core 实测：提醒把所学写到板上，写板次数与板上事实都明显增加）：最新一份结果之前，
// 连续这么多次 Rulith 调用都没有被接受的 ApplyBatch，就在最新一份末尾附一句提醒。只出现在最新一份里，
// 降为变化时随之消失，所以不在对话里堆积。
export const WRITE_NOTE_AFTER = 6;
export const writeNote = (n) => `Note: ${n} Rulith calls since your last accepted ApplyBatch. Record what you have learned on the Board before relying on it.`;
const acceptedBatch = (item) => {
  if (item.tool !== 'ApplyBatch') return false;
  const first = item.kind === 'raw' ? item.first : item.text.split('\n')[0];
  try { return JSON.parse(first.replace(/^Error: /, '')).accepted === true; } catch { return false; }
};

export function plan(items) {
  let prev = null; // 上一份板的多重集（行 → 次数）
  let sinceWrite = 0;
  for (const item of items) sinceWrite = acceptedBatch(item) ? 0 : sinceWrite + 1;
  return items.map((item, index) => {
    const last = index === items.length - 1;
    let first;
    let curr;
    if (item.kind === 'raw') {
      first = item.first;
      curr = item.lines;
    } else {
      const parsed = parseRendered(item);
      first = parsed.first;
      if (item.kind === 'full') {
        curr = parsed.rows.filter((row) => row.mark !== '-').map((row) => row.line);
      } else {
        const next = new Map(prev ?? []);
        for (const row of parsed.rows) {
          if (row.mark === '+') next.set(row.line, (next.get(row.line) ?? 0) + 1);
          else if (row.mark === '-') {
            const left = (next.get(row.line) ?? 0) - 1;
            if (left > 0) next.set(row.line, left); else next.delete(row.line);
          }
        }
        curr = expand(next);
      }
    }
    const note = last && sinceWrite >= WRITE_NOTE_AFTER ? `\n${writeNote(sinceWrite)}` : '';
    const wanted = last ? renderFull(first, curr, prev) + note : renderDelta(first, curr, prev);
    prev = countLines(curr);
    return wanted === item.text ? null : wanted;
  });
}

const textOf = (message) => (Array.isArray(message?.content) ? message.content.map((part) => (part?.type === 'text' ? part.text : '')).join('') : '');

/**
 * 在一次请求模型之前改写这个对话：只动带板的 Rulith 工具结果，用 dsh 自己的“替换”记录（原文仍在日志里，
 * 界面显示原文），与 dsh 的工具结果裁剪器同一做法。返回改写了几份。
 */
export function rewriteSession(session) {
  const found = [];
  const toolOf = new Map(); // 调用 ID → 工具名，取自模型消息里的工具调用块
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type === 'assistant/message') {
      for (const block of session.deriveEventMessage(event)?.content ?? []) if (block?.type === 'tool-call') toolOf.set(block.id, block.name);
      continue;
    }
    if (event?.type !== 'tool/result') continue;
    const message = session.deriveEventMessage(event);
    const item = classify(textOf(message));
    if (item === null) continue;
    item.tool = toolOf.get(message.toolCallId);
    found.push({ seq, event, message, item });
  }
  const wanted = plan(found.map((entry) => entry.item));
  let rewritten = 0;
  found.forEach((entry, index) => {
    const text = wanted[index];
    if (text === null) return;
    session.append('tool/result', { ...entry.event.data, message: { ...entry.message, content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
      sourceEventSeqs: [entry.seq],
    });
    rewritten += 1;
  });
  return rewritten;
}

/** 挂到 dsh 的 agent/pre-step：每次请求模型之前改写一次；出错只记日志，对话照常按原样继续。 */
export function installBoardTranscript(ctx) {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      if (agent?.session) rewriteSession(agent.session);
    } catch (error) {
      ctx.logger?.warn?.(`rulith board transcript: left the conversation as it was (${String(error?.message ?? error).slice(0, 300)})`);
    }
    return next();
  });
}
