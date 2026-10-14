import { createHash } from 'node:crypto';
// Deep Rulith 的板视图转录（D-1008e，所有者 2026-10-08 批准沿用最初 galaxy-core 的 delta-history 设计）。
//
// Rulith 每个工具结果都带当时整块板（view）和操作条（operations）。原样留在对话里，几十份几乎相同的板叠在一起：
// 模型要自己比对哪里变了（幻觉的来源），旧板还可能被当成当前局面，上下文也越滚越大。这里在每次请求模型之前，
// 把对话里 Rulith 的结果改写成两种形态（只改模型看到的那份；界面上的对话原文不变）：
//   - 最新一份：整块板，每行一项；比上一份板新增的行前标 `+`，消失的行以 `-` 列出；
//   - 更早的：只留这一步的变化（`+`／`-` 行）。
//
// 10-09 模型的反馈（项目内容，事后报告）：表头说“整块板”，而视图自己写着 rootScope.lossy 与 dropped，两者打架——这里
// 给的其实是“Rulith 这次返回的整个视图”，省略了什么由视图自己说；未变的行只靠两个空格，不醒目，改标 `=`；Get
// 的动作行带 description 与 inputSchema、其他结果不带，同一批动作每次交替调用都整批 +/- 一遍，是渲染噪声——比较时不看这两项。
//
// 结果怎样读（2026-10-14，所有者：工具结果要读得自然，不要满屏反斜杠）：板以外的部分（结果头）是一行紧凑 JSON。
// Worker 的输出由平台作为字符串带回，原样就是 JSON 里套着转义的 JSON；这里把“本身是一行 JSON（对象或数组）”的字符串解开，
// 作为嵌套的值放回——只在重新编码能逐字还原原字符串时才解开，所以展示无损。多行或超过 TEXT_LONG 个字符的字符串在这行里
// 换成 "<text N>"，原文作为文本块接在这行之后，块头写明字段路径与行数：`<text 1> result.result.head (12 lines):`。
// 全部换行都是 CRLF 时去掉 CR 并在块头注明 `CRLF line endings`（改文件要知道）。块按行数截取，所以内容里的任何一行
// 都不会被认成板行、提示或标记。这只是展示：Board 与 dsh 记下的原始工具结果不变。一份结果的样子在它第一次进入转录时
// 定下，此后逐字沿用（缓存稳定）；之前按旧样子（一行转义 JSON）排过的结果照旧读、照旧显示。
// 不带板的 Rulith 结果（Get 读 artifact 等）同样只排结果头；其他工具（子 Agent 等）的结果不动。
//
// 上下文减负（2026-10-14，所有者：只在上下文空间不够时才减负，仿 Anthropic context editing 的 trigger／keep／clear_at_least；
// 取代 10-14 上午的两个滑动窗口——它们每当一份大结果或长参数滑出窗口就改一次前缀，79 步里约 20 次让缓存退到 40～90K）：
//   - 两条线都按模型上下文窗口的比例定（窗口取 dsh 自己用的那个：会话里最新 request/context 的 contextWindow；
//     本地模型来自 deep-rulith.json 的 localContextWindow），都可在 deep-rulith.json 设置：
//       减负线 = reliefRatio × 窗口（默认 RELIEF_RATIO 0.7）——本文件；
//       压缩线 = compactionRatio × 窗口（默认 0.8）——dsh 的 compaction-basic，由启动器经 rulith-web.cordis.yml 设定
//       （thresholdRatio，并把 headroomTokens 调小到不再先起作用；见 launcher-settings.mjs）。
//     启动器要求减负线低于压缩线，否则拒绝启动。两线之间约是一步的增长（262144 窗口时约 26K token），所以通常先减负，
//     减负不够时才轮到 dsh 的压缩（摘要要解码几分钟，而且有损）。挪动一条线时要连另一条一起看。
//   - 触发：dsh 记下的最近一次模型请求的真实提示大小（assistant/message 的 usage：inputTokens + cacheReadTokens，
//     有 cacheWriteTokens 的也算上）达到减负线。
//     那次请求之后 dsh 压缩过（有 compaction/summary），那次的用量已不代表现在的对话，不触发；不知道窗口或用量，也不触发。
//   - 一批（keep）：比最近 KEEP 份工具结果（带板与否都算）更早的最新一份带板结果成为新的边界。上一个边界之后、新边界及之前的
//     Rulith 结果一次全部减负：结果头超过 CLEAR_FIRST_LINE 个字符时压成一行仍可解析的紧凑 JSON（只留 accepted、errorCode、tool、
//     requestExecuted、result.action/ok/status，并写明清掉了多少字符；文本块随之去掉），其中超过 LONG_LINE 的 `+` 行与 `-` 行
//     一样只显示短身份；新边界那份末尾加一行减负标记（RELIEF_MARK，outgoing-trim.mjs）。发出副本时，最新一个标记之前的模型
//     回答里的长参数一并缩短（outgoing-trim.mjs）。
//   - 够才做（clear_at_least）：这一批估计至少省 CLEAR_AT_LEAST 个 token 才做——结果减负前后的字符差，加上新落到边界之前的
//     旧回答里长参数缩短省下的字符，按 CHARS_PER_TOKEN 折算。不够就什么都不改，余下的交给 dsh 的压缩。
//   - 一批之后，边界及之前的一切不再变，直到下一次触发。
//
// 单一真相放在会话里（而不是只在发出的副本里）：触发要用 dsh 记下的用量与请求上下文，只有会话日志里有（发出的请求只带消息）；
// Rulith 结果本来就以 dsh 的“替换”记录改写；而模型回答 dsh 不许替换，长参数只能在发出的副本里缩短。所以由这里在请求前
// 判断并把边界写成结果末尾的标记（替换记录，原文仍在日志里），outgoing-trim.mjs 只读这个标记。两者由同一个标记定边界，
// 永远一致；重启或回放会话日志得到同一个边界、同样的字节。
//
// 不变式（中文写明，便于审计）：
//   1. 变化相对的是“这个对话里上一份板”，一步不跳；从第一份板起把各步变化依次叠加，正好得到最新整块板。
//      第一份板没有前一份，它的每一行都标 `+`，所以历史里第一份就是当时的整块板。
//   2. 改写只依据会话记录本身（对话、dsh 记下的用量与请求上下文；无内存状态），重启或回放后重算结果相同；已经改好的不再改。
//      低于减负线时，每一步只把上一份“最新”降为变化，前缀其余部分逐字不变，模型服务的前缀缓存照常命中；
//      一批减负改的是边界及之前尚未减负的结果，此后它们不再变。以前的决定不因对话变长而改动。
//   3. 这不是第二份真相：板的真相仍在 Rulith，这里只是把它沿时间拆成“历次变化 + 最新全量”给模型看。
//   4. 读不懂的结果（传输错误等不是 JSON 的结果）原样不动。
//   5. 减负只改显示，不改比较：短身份就是该行比较用的身份（identity），由改写后的文本重算，每一份的 +／- 与不减负时
//      完全相同；已经减负的不再改（紧凑行带 cleared，短身份按原样就是它自己的身份），第二遍什么也不变。
//   6. dsh 压缩把从对话开头起的一段换成摘要。标记若在被压缩的那段里，它之前的一切也都在里面，剩下的对话里没有边界，
//      也没有比边界更早的东西；若在保留的尾部，边界照旧。压缩后的第一次请求之前不触发（用量已过时）。
//      压缩后剩下的头几份变化失去了它们的上一份板，按剩下的重算一次（只少了指向被压缩部分的 `-` 行），就在压缩之后、
//      同一次请求之前（dsh 的压缩在 agent/pre-step 里先跑），而压缩本身已经改了前缀，所以不多一次缓存失效。
//   7. 10-14 上午用滑动窗口减负过的会话照旧读：带 cleared 的结果头与短身份是固定点，不再改；它们没有标记，
//      所以直到下一批之前，旧回答的长参数照常发出。

import { projectToolCall } from '../tool-history.mjs';
import { NOTE_PREFIX } from './shadow-reviewer.mjs';
import { RELIEF_MARK, shortenArguments } from './outgoing-trim.mjs';

// 旧表头（10-09 之前改写过的会话）仍然认得，下一次改写时换成新表头。
const FULL_PREFIXES = ['Board view now (', 'Board now ('];
const DELTA_PREFIXES = ['Board view changes at this step', 'Board changes at this step'];
export const FULL_HEAD = 'Board view now (the whole view Rulith returned; + new since your previous view, - gone since then, = unchanged):';
export const FULL_FIRST = 'Board view now (the whole view Rulith returned; your first view in this conversation, so every line is +):';
export const DELTA_HEAD = 'Board view changes at this step (+ new, - gone; unchanged lines left out; the latest result shows the whole view):';
export const DELTA_NONE = 'Board view changes at this step: none (the latest result shows the whole view).';
const ERROR_PREFIX = 'Error: ';
const RULITH_TOOLS = new Set(['Get', 'Set', 'Execute']);

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

// ---- 结果头：解开嵌套 JSON，长文本成块 ----

/** 单行字符串超过这么多字符就作为文本块显示（多行的一律成块）。 */
export const TEXT_LONG = 400;
/** 文本块的块头：`<text N> <字段路径> (<行数> lines[, CRLF line endings]):`，之后正好是这么多行原文。 */
const BLOCK_LABEL = /^<text (\d+)> .+ \((\d+) lines?(?:, CRLF line endings)?\):$/;
export const textRef = (n) => `<text ${n}>`;

/** 一行紧凑 JSON（对象或数组）且重新编码逐字还原的字符串，返回解开的值；否则 undefined。 */
function nestedJson(text) {
  if (text[0] !== '{' && text[0] !== '[') return undefined;
  if (text.includes('\n')) return undefined;
  let value;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  return JSON.stringify(value) === text ? value : undefined;
}

const pathOf = (path, key) => (typeof key === 'number' ? `${path}[${key}]`
  : /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`);

/** 逐层解开嵌套 JSON；多行或很长的字符串换成 <text N>，原文收进 blocks。对象用 fromEntries 重建，`__proto__` 也只是普通的键。 */
function present(value, path, blocks) {
  if (typeof value === 'string') {
    const nested = nestedJson(value);
    if (nested !== undefined) return present(nested, path, blocks);
    if (!value.includes('\n') && value.length <= TEXT_LONG) return value;
    blocks.push({ path, text: value });
    return textRef(blocks.length);
  }
  if (Array.isArray(value)) return value.map((item, index) => present(item, pathOf(path, index), blocks));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, present(item, pathOf(path, key), blocks)]));
  }
  return value;
}

/** 一个文本块：块头 + 原文各行。全部换行都是 CRLF 时去掉行尾的 CR，块头注明；否则原样（CR 照留）。 */
function textBlock(n, { path, text }) {
  let lines = text.split('\n');
  const crlf = lines.length > 1 && lines.slice(0, -1).every((line) => line.endsWith('\r'));
  if (crlf) lines = lines.map((line, index) => (index < lines.length - 1 ? line.slice(0, -1) : line));
  const count = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}${crlf ? ', CRLF line endings' : ''}`;
  return [`${textRef(n)} ${path} (${count}):`, ...lines];
}

/** 一份回答的结果头：除板以外的部分（结果、教学、错误码……），一行紧凑 JSON，后接文本块。 */
export function renderHead(answer, isError) {
  const { view: _view, operations: _operations, ...rest } = answer;
  const blocks = [];
  const shown = present(rest, '', blocks);
  return [(isError ? ERROR_PREFIX : '') + JSON.stringify(shown), ...blocks.flatMap((block, index) => textBlock(index + 1, block))].join('\n');
}

/** 已排好的文本里结果头占几行：第一行，加上紧随其后按编号与行数截取的文本块。 */
function headLength(lines) {
  let at = 1;
  for (let n = 1; at < lines.length; n += 1) {
    const match = BLOCK_LABEL.exec(lines[at]);
    if (!match || Number(match[1]) !== n) break;
    at += 1 + Number(match[2]);
  }
  return Math.min(at, lines.length);
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

/** 最新一份：结果头 + 整块板（带 +／-）。prev 为 null 表示本对话还没有过板。 */
export function renderFull(first, curr, prev) {
  const rows = mark(prev, curr);
  return [first, prev === null ? FULL_FIRST : FULL_HEAD, ...rows.map((row) => `${row.mark} ${row.line}`)].join('\n');
}

/**
 * 历史一份：结果头 + 只有变化的行。old 为真（在减负边界及之前）时减负：结果头压成紧凑 JSON，
 * 超过 LONG_LINE 的 `+` 行显示它的身份（identity；长行即短身份），与 `-` 行一样，重算时得到同一个身份。
 */
export function renderDelta(first, curr, prev, old = false) {
  const changed = mark(prev, curr).filter((row) => row.mark !== '=');
  const shown = (row) => (old && row.mark === '+' && row.line.length > LONG_LINE ? identity(row.line) : row.line);
  return [old ? clearFirst(first) : first, changed.length > 0 ? DELTA_HEAD : DELTA_NONE,
    ...changed.map((row) => `${row.mark} ${shown(row)}`)].join('\n');
}

// ---- 减负的参数 ----

/** 最近这么多份工具结果（不论是否带板）及发出它们的调用在一批减负里不动。 */
export const KEEP = 6;
/** 默认减负线：最近一次请求的真实提示达到模型上下文窗口的这个比例时触发（deep-rulith.json 的 reliefRatio 可改）。 */
export const RELIEF_RATIO = 0.7;
/** 一批至少要省这么多 token 才做，否则留给 dsh 的压缩。 */
export const CLEAR_AT_LEAST = 20000;
/**
 * 字符折算 token：2026-10-14 game-demo 会话（Qwen 分词，板与参数多为 JSON、十六进制摘要、代码）实测每 token 2.7～2.9 个字符。
 * 取 3，估计偏低，所以够 CLEAR_AT_LEAST 时实际省下的只会更多；中文文本约每 token 1～1.5 个字符，同样只会低估。
 */
export const CHARS_PER_TOKEN = 3;
/** 结果头（不含板的结果 JSON 与其文本块）超过这么多字符，减负时压成紧凑 JSON。 */
export const CLEAR_FIRST_LINE = 1500;
/** 紧凑 JSON 里保留的字段：短的才留（按 JSON 计不超过这么多字符），长的照样清掉。 */
const KEPT_FIELD = 200;
const clearedNote = (n) => `${n} characters of this earlier result were cleared to save context; the Board holds the state`;

/**
 * 减负后的结果头：太长时换成一行仍可解析的紧凑 JSON，保留 accepted、errorCode、tool、requestExecuted 与
 * result.action／ok／status（有且短时），另加 cleared 写明清掉了多少字符（第一行与文本块合计）。dsh 的 `Error: ` 前缀照留。
 * 读不懂的、已经带 cleared 的，原样返回（所以第二遍不变）。
 */
export function clearFirst(first) {
  const isError = first.startsWith(ERROR_PREFIX);
  const size = first.length - (isError ? ERROR_PREFIX.length : 0);
  if (size <= CLEAR_FIRST_LINE) return first;
  const line = first.split('\n', 1)[0];
  let rest;
  try { rest = JSON.parse(isError ? line.slice(ERROR_PREFIX.length) : line); } catch { return first; }
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
  kept.cleared = clearedNote(size);
  return (isError ? ERROR_PREFIX : '') + JSON.stringify(kept);
}

// ---- 认出一份工具结果 ----

/** MCP 结果（dsh 存下的工具结果第一行，可能带 `Error: `）里的 Rulith 回答；不是时返回 null。 */
function mcpAnswer(text) {
  const isError = text.startsWith(ERROR_PREFIX);
  try {
    const outer = JSON.parse(isError ? text.slice(ERROR_PREFIX.length) : text);
    if (!outer || !Array.isArray(outer.content)) return null;
    const answer = JSON.parse(outer.content.map((part) => part?.text ?? '').join(''));
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    return { answer, isError };
  } catch {
    return null;
  }
}

/** 原样的工具结果：第一行是 MCP 结果，之后只可能是宿主附加的建议行（shadow-reviewer 的 NOTE_PREFIX）。 */
function rawParts(text) {
  const lines = text.split('\n');
  const notes = lines.slice(1).filter((line) => line.startsWith(NOTE_PREFIX));
  const body = lines.filter((line, index) => index === 0 || !line.startsWith(NOTE_PREFIX)).join('\n');
  return { body, notes };
}

/**
 * 认出一份带板工具结果的形态。
 * - raw：Rulith 原样的回答（可能带 dsh 加的 `Error: ` 前缀），且带板；结果头在这里一次排好；
 * - full／delta：已经改写过的（结果头逐字沿用）；
 * - null：不是带板的 Rulith 结果，不动。
 * 已改写的文本按结构读：结果头（第一行与按行数截取的文本块）、表头、板行，其后只可能是写板提醒、建议行与减负标记。
 */
export function classify(text) {
  const lines = text.split('\n');
  const headEnd = headLength(lines);
  const header = lines[headEnd] ?? '';
  const kind = FULL_PREFIXES.some((prefix) => header.startsWith(prefix)) ? 'full'
    : DELTA_PREFIXES.some((prefix) => header.startsWith(prefix)) ? 'delta' : null;
  if (kind !== null) {
    let at = headEnd + 1;
    const rows = [];
    // `=` 未变；旧会话里未变是两个空格。
    for (; at < lines.length && /^[ =+-] /.test(lines[at]); at += 1) rows.push({ mark: lines[at][0] === ' ' ? '=' : lines[at][0], line: lines[at].slice(2) });
    const tail = lines.slice(at);
    return { kind, text, first: lines.slice(0, headEnd).join('\n'), rows,
      notes: tail.filter((line) => line.startsWith(NOTE_PREFIX)), marked: tail.includes(RELIEF_MARK) };
  }
  const { body, notes } = rawParts(text);
  const parsed = mcpAnswer(body);
  const view = parsed?.answer.view;
  if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
  return { kind: 'raw', text, first: renderHead(parsed.answer, parsed.isError), lines: boardLines(parsed.answer), notes, marked: false };
}

/**
 * 不带板的 Rulith 结果（Get 读 artifact、被拒的调用等）：原样的（第一行是 MCP 结果）先排好结果头；已排好的（第一行是回答本身
 * 的 JSON）读出结果头。两种之后都只能是建议行。读不懂的（传输错误等纯文本、多出别的行）返回 null，不动。
 */
export function classifyPlain(text) {
  const lines = text.split('\n');
  const isError = lines[0].startsWith(ERROR_PREFIX);
  let value;
  try { value = JSON.parse(isError ? lines[0].slice(ERROR_PREFIX.length) : lines[0]); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const onlyNotes = (rest) => rest.every((line) => line.startsWith(NOTE_PREFIX));
  if (Array.isArray(value.content)) {
    const parsed = mcpAnswer(lines[0]);
    if (parsed === null || !onlyNotes(lines.slice(1))) return null;
    return { text, first: renderHead(parsed.answer, parsed.isError), notes: lines.slice(1) };
  }
  const headEnd = headLength(lines);
  if (!onlyNotes(lines.slice(headEnd))) return null;
  return { text, first: lines.slice(0, headEnd).join('\n'), notes: lines.slice(headEnd) };
}

// G1（D-1008j，取自 galaxy-core 实测：提醒把所学写到板上，写板次数与板上事实都明显增加）：最新一份结果之前，
// 连续这么多次 Rulith 调用都没有被接受的 Set，就在最新一份末尾附一句提醒。只出现在最新一份里，
// 降为变化时随之消失，所以不在对话里堆积。
export const WRITE_NOTE_AFTER = 6;
export const writeNote = (n) => `Note: ${n} Rulith calls since your last accepted Set. Record what you have learned on the Board before relying on it.`;
const acceptedBatch = (item) => {
  if (item.tool !== 'Set') return false;
  try { return JSON.parse(item.first.split('\n', 1)[0].replace(/^Error: /, '')).accepted === true; } catch { return false; }
};

/**
 * 给出对话里每一份带板结果应有的文本（items 按对话顺序给出 classify 的结果，null 已滤掉）。boundary 是减负边界在 items 里的
 * 下标（-1 为没有）：它及之前的历史结果减负，它本身末尾带减负标记；已经带标记的照留。
 */
function render(items, boundary) {
  let prev = null; // 上一份板的多重集（身份 → 次数）
  const lineOf = new Map(); // 身份 → 最近一次显示的原行（长行的身份是短摘要，重算时要还原出原行）
  let sinceWrite = 0;
  for (const item of items) sinceWrite = acceptedBatch(item) ? 0 : sinceWrite + 1;
  return items.map((item, index) => {
    const last = index === items.length - 1;
    let curr;
    if (item.kind === 'raw') {
      curr = item.lines;
    } else if (item.kind === 'full') {
      curr = item.rows.filter((row) => row.mark !== '-').map((row) => row.line);
    } else {
      const next = new Map(prev ?? []);
      for (const row of item.rows) {
        const key = identity(row.line);
        if (row.mark === '+') { next.set(key, (next.get(key) ?? 0) + 1); lineOf.set(key, row.line); }
        else if (row.mark === '-') {
          const left = (next.get(key) ?? 0) - 1;
          if (left > 0) next.set(key, left); else next.delete(key);
        }
      }
      curr = expand(next).map((key) => lineOf.get(key) ?? key);
    }
    const note = last && sinceWrite >= WRITE_NOTE_AFTER ? `\n${writeNote(sinceWrite)}` : '';
    const advisory = item.notes.length ? '\n' + item.notes.join('\n') : '';
    const relief = item.marked || index === boundary ? `\n${RELIEF_MARK}` : '';
    const body = last ? renderFull(item.first, curr, prev) + note : renderDelta(item.first, curr, prev, index <= boundary);
    for (const line of curr) lineOf.set(identity(line), line);
    prev = countLines(curr.map(identity));
    return body + advisory + relief;
  });
}

/** 已有的减负边界：最新一份带减负标记的结果（items 下标），没有为 -1。 */
const markedBoundary = (items) => items.findLastIndex((item) => item.marked);

/** 每一份应有的文本；已经是应有形态的给 null。boundary 默认是已有的边界（不触发新的一批）。 */
export function plan(items, { boundary = markedBoundary(items) } = {}) {
  return render(items, boundary).map((text, index) => (text === items[index].text ? null : text));
}

/** 不带板的 Rulith 结果应有的文本：结果头（在边界之前时减负）加建议行。 */
const renderPlain = (item, old) => (old ? clearFirst(item.first) : item.first) + (item.notes.length ? '\n' + item.notes.join('\n') : '');

/** 一个模型回答里的长参数在发出副本里缩短后省下的字符数（与 outgoing-trim.mjs 同一个函数）。 */
function argumentSavings(message) {
  let saved = 0;
  for (const block of message?.content ?? []) {
    if (block?.type === 'tool-call' && typeof block.arguments === 'string') saved += block.arguments.length - shortenArguments(block.arguments).length;
  }
  return saved;
}

/**
 * 最近一次模型请求的真实提示大小（dsh 记在 assistant/message 的 usage 里：inputTokens + cacheReadTokens，另有
 * cacheWriteTokens 的服务也算上——与 dsh 的 token-meter 算压力的口径相同）。那之后 dsh 压缩过（有 compaction/summary），
 * 或没有记用量，返回 null：不知道现在多大，就不触发。
 */
export function latestPromptTokens(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'compaction/summary') return null;
    if (event?.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (!usage || typeof usage.inputTokens !== 'number') return null;
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  }
  return null;
}

const textOf = (message) => (Array.isArray(message?.content) ? message.content.map((part) => (part?.type === 'text' ? part.text : '')).join('') : '');

/**
 * 在一次请求模型之前改写这个对话：只动 Rulith 的工具结果，用 dsh 自己的“替换”记录（原文仍在日志里，界面显示原文），
 * 与 dsh 的工具结果裁剪器同一做法。到了减负线时按上面的规则判断要不要做一批。返回改写了几份。
 * options：reliefRatio、keep、clearAtLeast 覆盖默认值；onBatch(info) 在做了一批时被调用（日志与回放统计用）。
 */
export function rewriteSession(session, options = {}) {
  const { reliefRatio = RELIEF_RATIO, keep = KEEP, clearAtLeast = CLEAR_AT_LEAST, onBatch } = options;
  const entries = []; // Rulith 结果：带板的（board）与不带板的
  const replies = []; // 模型回答及其在对话里的位置
  const toolOf = new Map(); // 调用 ID → 工具名，取自模型消息里的工具调用块
  let results = 0; // 对话里的工具结果（带板与否都算），用来判断哪些结果在最近 KEEP 份之外
  const nodes = [...session.surface.nodes];
  nodes.forEach((seq, position) => {
    const event = session.eventAt(seq);
    if (event?.type === 'assistant/message') {
      const message = session.deriveEventMessage(event);
      replies.push({ position, message });
      for (const block of message?.content ?? []) if (block?.type === 'tool-call') toolOf.set(block.id, projectToolCall(block).name);
      return;
    }
    if (event?.type !== 'tool/result') return;
    results += 1;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const tool = toolOf.get(message.toolCallId);
    const item = classify(text);
    if (item !== null) {
      item.tool = tool;
      entries.push({ seq, event, message, item, board: true, ordinal: results, position });
      return;
    }
    if (!RULITH_TOOLS.has(tool)) return;
    const plain = classifyPlain(text);
    if (plain !== null) entries.push({ seq, event, message, item: plain, board: false, ordinal: results, position });
  });
  for (const entry of entries) entry.item.later = results - entry.ordinal;
  const board = entries.filter((entry) => entry.board);
  const items = board.map((entry) => entry.item);
  const textsFor = (boundary) => {
    const boardTexts = render(items, boundary);
    const before = boundary === -1 ? -1 : board[boundary].position;
    let next = 0;
    return entries.map((entry) => (entry.board ? boardTexts[next++] : renderPlain(entry.item, entry.position < before)));
  };
  let boundary = markedBoundary(items);
  let wanted = textsFor(boundary);
  // 减负线：最近一次请求的真实提示达到 reliefRatio × 上下文窗口。
  const contextWindow = session.requestContext?.()?.contextWindow;
  const prompt = latestPromptTokens(session);
  if (Number.isFinite(contextWindow) && prompt !== null && prompt >= Math.floor(reliefRatio * contextWindow)) {
    const candidate = items.findLastIndex((item) => item.later >= keep);
    if (candidate > boundary) {
      const batch = textsFor(candidate);
      let freedChars = 0;
      batch.forEach((text, index) => { freedChars += wanted[index].length - text.length; });
      const from = boundary === -1 ? -1 : board[boundary].position;
      const to = board[candidate].position;
      for (const reply of replies) if (reply.position > from && reply.position < to) freedChars += argumentSavings(reply.message);
      const freedTokens = Math.floor(freedChars / CHARS_PER_TOKEN);
      if (freedTokens >= clearAtLeast) {
        boundary = candidate;
        wanted = batch;
        onBatch?.({ prompt, trigger: Math.floor(reliefRatio * contextWindow), contextWindow, freedChars, freedTokens, boundarySeq: board[candidate].seq });
      }
    }
  }
  let rewritten = 0;
  entries.forEach((entry, index) => {
    const text = wanted[index];
    if (text === entry.item.text) return;
    session.append('tool/result', { ...entry.event.data, message: { ...entry.message, content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
      sourceEventSeqs: [entry.seq],
    });
    rewritten += 1;
  });
  return rewritten;
}

/**
 * 挂到 dsh 的 agent/pre-step：每次请求模型之前改写一次（dsh 的压缩在同一瀑布里先跑）；出错只记日志，对话照常按原样继续。
 * options.reliefRatio 来自 rulith-runtime 的配置（deep-rulith.json 的 reliefRatio，经启动器的环境变量）。
 */
export function installBoardTranscript(ctx, options = {}) {
  const { reliefRatio = RELIEF_RATIO } = options;
  if (!(reliefRatio > 0 && reliefRatio < 1)) throw new Error(`rulith board transcript: reliefRatio must be between 0 and 1 (got ${reliefRatio})`);
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      if (agent?.session) rewriteSession(agent.session, { reliefRatio, onBatch: (info) => ctx.logger?.info?.(
        `rulith context relief: prompt ${info.prompt} >= ${info.trigger} tokens (${reliefRatio} of ${info.contextWindow}); `
        + `relieved up to seq ${info.boundarySeq}, about ${info.freedTokens} tokens freed`) });
    } catch (error) {
      ctx.logger?.warn?.(`rulith board transcript: left the conversation as it was (${String(error?.message ?? error).slice(0, 300)})`);
    }
    return next();
  });
}
