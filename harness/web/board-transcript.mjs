import { createHash } from 'node:crypto';
// Deep Rulith 的板视图转录（D-1008e，所有者 2026-10-08 批准沿用最初 galaxy-core 的 delta-history 设计）。
//
// Rulith 每个工具结果都带当时整块板（view）和操作条（operations）。原样留在对话里，几十份几乎相同的板叠在一起：
// 模型要自己比对哪里变了（幻觉的来源），旧板还可能被当成当前局面，上下文也越滚越大。这里在每次请求模型之前，
// 把对话里 Rulith 的结果改写成两种形态（只改模型看到的那份；界面上的对话原文不变）：
//   - 最新一份：整块板，每行一项；比上一份板新增的行前标 `+`，消失的行以 `-` 列出；
//   - 更早的：只留这一步的变化（`+`／`-` 行）。
// 结果本身（accepted、result、teaching、errorCode 等）在最近 KEEP_RESULTS 份工具结果里原样保留，所以刚失败一步的教学不会被压掉；
// 更早的结果见下面的“旧结果减负”。
//
// 旧结果减负（2026-10-14，所有者：只有 Board 上的才算数，对话记录可以丢；两次压缩后上下文仍有 ~180K/262K，近几份 Rulith
// 结果每份 10～23 万字符）：比最近 KEEP_RESULTS 份工具结果更早的 Rulith 结果，第一行超过 CLEAR_FIRST_LINE 个字符时换成
// 一行仍可解析的紧凑 JSON（只留 accepted、errorCode、tool、requestExecuted、result.action/ok/status，并写明清掉了多少字符）；
// 其中超过 LONG_LINE 的 `+` 行与 `-` 行一样只显示短身份。最新一份整块板永远原样。
// 旧工具调用的参数（例如写文件的整段文本）不在这里清：dsh 拒绝替换 assistant/message（它内嵌模型原始输出流，
// 不能带 sourceEventSeqs；见 tool-history.mjs），插件自定义事件类型又会让会话重启后无法读回。
//
// 10-09 模型的反馈（项目内容，事后报告）：表头说“整块板”，而视图自己写着 rootScope.lossy 与 dropped，两者打架——这里
// 给的其实是“Rulith 这次返回的整个视图”，省略了什么由视图自己说；未变的行只靠两个空格，不醒目，改标 `=`；Get
// 的动作行带 description 与 inputSchema、其他结果不带，同一批动作每次交替调用都整批 +/- 一遍，是渲染噪声——比较时不看这两项。
//
// 不变式（中文写明，便于审计）：
//   1. 变化相对的是“这个对话里上一份板”，一步不跳；从第一份板起把各步变化依次叠加，正好得到最新整块板。
//      第一份板没有前一份，它的每一行都标 `+`，所以历史里第一份就是当时的整块板。
//   2. 改写只依据对话记录本身（无内存状态），重启或回放后重算结果相同；已经改好的不再改，所以每一步通常只把
//      上一份“最新”降为变化，前缀其余部分逐字不变，模型服务的前缀缓存照常命中。
//   3. 这不是第二份真相：板的真相仍在 Rulith，这里只是把它沿时间拆成“历次变化 + 最新全量”给模型看。
//   4. 读不懂的结果（传输错误、Get artifact 等不带板的结果）原样不动。
//   5. 减负只改显示，不改比较：短身份就是该行比较用的身份（identity），由改写后的文本重算，每一份的 +／- 与不减负时
//      完全相同；已经减负的不再改（紧凑行带 cleared，短身份按原样就是它自己的身份），第二遍什么也不变。

import { projectToolCall } from '../tool-history.mjs';
import { NOTE_PREFIX } from './shadow-reviewer.mjs';

// 旧表头（10-09 之前改写过的会话）仍然认得，下一次改写时换成新表头。
const FULL_PREFIXES = ['Board view now (', 'Board now ('];
const DELTA_PREFIXES = ['Board view changes at this step', 'Board changes at this step'];
export const FULL_HEAD = 'Board view now (the whole view Rulith returned; + new since your previous view, - gone since then, = unchanged):';
export const FULL_FIRST = 'Board view now (the whole view Rulith returned; your first view in this conversation, so every line is +):';
export const DELTA_HEAD = 'Board view changes at this step (+ new, - gone; unchanged lines left out; the latest result shows the whole view):';
export const DELTA_NONE = 'Board view changes at this step: none (the latest result shows the whole view).';
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

/**
 * 很长的一行（例如操作栏里补交的一份旧结果）以“段名 + 摘要 + 长度”作身份。消失的行显示的是身份，所以模型看到的是
 * “- operations: #… (106197 characters)”，而不是把同一大块再抄一遍（2026-10-14：一份约 10 万字符的旧视图在两次压缩后仍占满上下文）。
 * 新增与未变的行照原样显示；由改写后的文本重算上一份板时，短身份按原样就是它自己的身份，重算结果不变。
 */
export const LONG_LINE = 2000;
const LONG_IDENTITY = /^[^:]*: #[0-9a-f]{16} \(\d+ characters\)$/;
function longIdentity(line) {
  if (line.length <= LONG_LINE || LONG_IDENTITY.test(line)) return line;
  return `${section(line)}: #${createHash('sha256').update(line).digest('hex').slice(0, 16)} (${line.length} characters)`;
}

/**
 * 比较用的身份：动作行去掉说明部分 description 与 inputSchema（只有 Get 的结果带它们，其他结果不带；它们是同一个
 * 动作定义的另一种渲染，不是板的变化）。显示仍用原行，所以带说明的结果照样给模型看。其余行的身份就是行本身。
 */
export function identity(line) {
  if (!line.startsWith('actions: ')) return longIdentity(line);
  try {
    const row = JSON.parse(line.slice('actions: '.length));
    if (!row || typeof row !== 'object' || Array.isArray(row)) return longIdentity(line);
    if (!Object.hasOwn(row, 'inputSchema') && !Object.hasOwn(row, 'description')) return longIdentity(line);
    const { inputSchema: _schema, description: _description, ...rest } = row;
    return longIdentity(`actions: ${JSON.stringify(rest)}`);
  } catch {
    return longIdentity(line);
  }
}

/**
 * 多重集比较（按 identity）：curr 中多出来的行标 `+`；prev 中没有了的行另列为 `-`，放在同一段最后一行之后。prev 是身份的
 * 多重集；curr 是本次的原行，显示时照原样。
 */
function mark(prev, curr) {
  const remaining = new Map(prev ?? []);
  const rows = curr.map((line) => {
    const key = identity(line);
    const left = remaining.get(key) ?? 0;
    if (left > 0) { remaining.set(key, left - 1); return { mark: '=', line }; }
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

/**
 * 历史一份：结果行 + 只有变化的行。old 为真（比最近 KEEP_RESULTS 份工具结果更早）时减负：结果行压成紧凑 JSON，
 * 超过 LONG_LINE 的 `+` 行显示它的身份（identity；长行即短身份），与 `-` 行一样，重算时得到同一个身份。
 */
export function renderDelta(first, curr, prev, old = false) {
  const changed = mark(prev, curr).filter((row) => row.mark !== '=');
  const shown = (row) => (old && row.mark === '+' && row.line.length > LONG_LINE ? identity(row.line) : row.line);
  return [old ? clearFirst(first) : first, changed.length > 0 ? DELTA_HEAD : DELTA_NONE,
    ...changed.map((row) => `${row.mark} ${shown(row)}`)].join('\n');
}

/** 最近这么多份工具结果（不论是否带板）原样保留；更早的减负。 */
export const KEEP_RESULTS = 6;
/** 旧结果的第一行（不含板的结果 JSON）超过这么多字符就压成紧凑 JSON。 */
export const CLEAR_FIRST_LINE = 1500;
/** 紧凑 JSON 里保留的字段：短的才留（按 JSON 计不超过这么多字符），长的照样清掉。 */
const KEPT_FIELD = 200;
const clearedNote = (n) => `${n} characters of this earlier result were cleared to save context; the Board holds the state`;

/**
 * 旧结果的第一行：太长时换成一行仍可解析的紧凑 JSON，保留 accepted、errorCode、tool、requestExecuted 与
 * result.action／ok／status（有且短时），另加 cleared 写明清掉了多少字符。dsh 的 `Error: ` 前缀照留。
 * 读不懂的、已经带 cleared 的，原样返回（所以第二遍不变）。
 */
export function clearFirst(first) {
  const isError = first.startsWith(ERROR_PREFIX);
  const body = isError ? first.slice(ERROR_PREFIX.length) : first;
  if (body.length <= CLEAR_FIRST_LINE) return first;
  let rest;
  try { rest = JSON.parse(body); } catch { return first; }
  if (!rest || typeof rest !== 'object' || Array.isArray(rest) || Object.hasOwn(rest, 'cleared')) return first;
  const pick = (from, keys) => {
    const out = {};
    for (const key of keys) {
      if (Object.hasOwn(from, key) && from[key] !== undefined && JSON.stringify(from[key]).length <= KEPT_FIELD) out[key] = from[key];
    }
    return out;
  };
  const kept = pick(rest, ['accepted', 'errorCode', 'tool', 'requestExecuted']);
  if (rest.result && typeof rest.result === 'object' && !Array.isArray(rest.result)) {
    const result = pick(rest.result, ['action', 'ok', 'status']);
    if (Object.keys(result).length > 0) kept.result = result;
  }
  kept.cleared = clearedNote(body.length);
  return (isError ? ERROR_PREFIX : '') + JSON.stringify(kept);
}

/**
 * 认出一份工具结果的形态。
 * - raw：Rulith 原样的回答（可能带 dsh 加的 `Error: ` 前缀），且带板；
 * - full／delta：已经改写过的；
 * - null：不是带板的 Rulith 结果，不动。
 */
export function classify(text) {
  // One-shot advisory notes are appended by the Host, outside the authority's JSON. Preserve them at their step.
  const notes = text.split('\n').filter((line) => line.startsWith(NOTE_PREFIX));
  text = text.split('\n').filter((line) => !line.startsWith(NOTE_PREFIX)).join('\n');
  const [, second = ''] = text.split('\n', 2);
  if (FULL_PREFIXES.some((prefix) => second.startsWith(prefix))) return { kind: 'full', text, notes };
  if (DELTA_PREFIXES.some((prefix) => second.startsWith(prefix))) return { kind: 'delta', text, notes };
  const isError = text.startsWith(ERROR_PREFIX);
  try {
    const outer = JSON.parse(isError ? text.slice(ERROR_PREFIX.length) : text);
    if (!outer || !Array.isArray(outer.content)) return null;
    const answer = JSON.parse(outer.content.map((part) => part?.text ?? '').join(''));
    if (!answer || typeof answer !== 'object' || !answer.view || typeof answer.view !== 'object' || Array.isArray(answer.view)) return null;
    return { kind: 'raw', first: restLine(answer, isError), lines: boardLines(answer), notes };
  } catch {
    return null;
  }
}

/** 已改写文本里的结果行与板：full 给出当时整块板；delta 给出变化（叠加到上一份上）。 */
function parseRendered(item) {
  const lines = item.text.split('\n');
  // 只认带标记的板行（`=` 未变；旧会话里未变是两个空格）；最新一份末尾可能附有写板提醒（WRITE_NOTE），它不是板的一部分。
  const rows = lines.slice(2).filter((line) => /^[ =+-] /.test(line))
    .map((line) => ({ mark: line[0] === ' ' ? '=' : line[0], line: line.slice(2) }));
  return { first: lines[0], rows };
}

/**
 * 给出对话里每一份带板结果应有的文本。items 按对话顺序给出 classify 的结果（null 已滤掉）；
 * 返回与之对齐的数组：需要改写的给新文本，已经是应有形态的给 null。
 */
// G1（D-1008j，取自 galaxy-core 实测：提醒把所学写到板上，写板次数与板上事实都明显增加）：最新一份结果之前，
// 连续这么多次 Rulith 调用都没有被接受的 Set，就在最新一份末尾附一句提醒。只出现在最新一份里，
// 降为变化时随之消失，所以不在对话里堆积。
export const WRITE_NOTE_AFTER = 6;
export const writeNote = (n) => `Note: ${n} Rulith calls since your last accepted Set. Record what you have learned on the Board before relying on it.`;
const acceptedBatch = (item) => {
  if (item.tool !== 'Set') return false;
  const first = item.kind === 'raw' ? item.first : item.text.split('\n')[0];
  try { return JSON.parse(first.replace(/^Error: /, '')).accepted === true; } catch { return false; }
};

// 每一份之后还有几份工具结果：rewriteSession 按对话里全部工具结果数好放在 item.later；没有时（直接调用 plan）
// 按 items 里排在它后面的份数。keepResults 只为测试比较“减负与不减负”而可调。
export function plan(items, { keepResults = KEEP_RESULTS } = {}) {
  let prev = null; // 上一份板的多重集（行 → 次数）
  const lineOf = new Map(); // 身份 → 最近一次显示的原行（长行的身份是短摘要，重算时要还原出原行）
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
          const key = identity(row.line);
          if (row.mark === '+') { next.set(key, (next.get(key) ?? 0) + 1); lineOf.set(key, row.line); }
          else if (row.mark === '-') {
            const left = (next.get(key) ?? 0) - 1;
            if (left > 0) next.set(key, left); else next.delete(key);
          }
        }
        curr = expand(next).map((key) => lineOf.get(key) ?? key);
      }
    }
    const note = last && sinceWrite >= WRITE_NOTE_AFTER ? `\n${writeNote(sinceWrite)}` : '';
    const advisory = item.notes?.length ? '\n' + item.notes.join('\n') : '';
    const old = (item.later ?? items.length - 1 - index) >= keepResults;
    const wanted = (last ? renderFull(first, curr, prev) + note : renderDelta(first, curr, prev, old)) + advisory;
    for (const line of curr) lineOf.set(identity(line), line);
    prev = countLines(curr.map(identity));
    return wanted === item.text + advisory ? null : wanted;
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
  let results = 0; // 对话里的工具结果（带板与否都算），用来判断哪些结果已在最近 KEEP_RESULTS 份之外
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type === 'assistant/message') {
      for (const block of session.deriveEventMessage(event)?.content ?? []) if (block?.type === 'tool-call') toolOf.set(block.id, projectToolCall(block).name);
      continue;
    }
    if (event?.type !== 'tool/result') continue;
    results += 1;
    const message = session.deriveEventMessage(event);
    const item = classify(textOf(message));
    if (item === null) continue;
    item.tool = toolOf.get(message.toolCallId);
    found.push({ seq, event, message, item, ordinal: results });
  }
  for (const entry of found) entry.item.later = results - entry.ordinal;
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
