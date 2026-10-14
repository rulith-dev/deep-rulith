// 启动器（start-deep-rulith.mjs）里不读设置文件、不启动任何东西的部分，单独放在这里以便测试。
import fs from 'node:fs';
import path from 'node:path';
import { RELIEF_RATIO } from './board-transcript.mjs';

// 上下文的两条线（2026-10-14，所有者：两条线都按模型上下文窗口的比例定，都可在 deep-rulith.json 里设置）：
//   - 减负线 reliefRatio（默认 RELIEF_RATIO 0.7，见 board-transcript.mjs）：最近一次请求的真实提示到了窗口的这个比例，
//     较早的 Rulith 结果与旧回答的长参数一批减负（只在能省够 CLEAR_AT_LEAST 时）。
//   - 压缩线 compactionRatio（默认 COMPACTION_RATIO 0.8）：dsh 的 compaction-basic 在这里把较早的对话压成摘要
//     （摘要要解码几分钟，而且有损）。dsh 的压缩线是
//       min(窗口 × thresholdRatio, 窗口 − 请求的 maxTokens − headroomTokens)
//     （dsh-compaction-basic lib/index.js resolveCompactSpec）。dsh 默认 headroomTokens 65536：262144 的窗口、maxTokens 32768
//     时后一项是 163840，比 0.8 × 窗口先起作用，所以以前实际在约 160K 压缩。这里把 thresholdRatio 设为 compactionRatio，
//     headroomTokens 设为 COMPACTION_HEADROOM_TOKENS（16384），后一项（212992）不再先起作用，压缩线就是 0.8 × 262144 = 209715。
//     dsh 的摘要请求的输出上限默认等于 headroomTokens，所以另设 COMPACTION_SUMMARY_MAX_TOKENS（32768，与 Agent 自己的
//     输出上限相同）：2026-10-14 的三次摘要输出 6～8K token；而 65536 会让压缩线附近的摘要请求（被压缩的一段约 0.8 × 窗口
//     减去保留的尾部，再加输出）贴近窗口。
//   - 减负线必须低于压缩线，否则减负永远轮不到（启动器拒绝启动）。默认两线相差 0.1 × 窗口（262144 时约 26K token），
//     约是一步的增长：通常先减负，减负省不够时才压缩。挪动一条线时连另一条一起看。
//   - 只有 (1 − compactionRatio) × 窗口 ≥ maxTokens + headroomTokens 时压缩线才真是 compactionRatio × 窗口（0.8 时窗口
//     至少 245760）；窗口更小时 dsh 在 窗口 − maxTokens − headroomTokens 处压缩。设置里给了 localContextWindow 时，
//     启动器按这条实际的压缩线检查减负线。
export const COMPACTION_RATIO = 0.8;
export const COMPACTION_HEADROOM_TOKENS = 16384;
export const COMPACTION_SUMMARY_MAX_TOKENS = 32768;

/** dsh compaction-basic 的压缩线（与它的 resolveCompactSpec 同一算式）。 */
export const compactionLine = (contextWindow, ratio, maxTokens, headroomTokens = COMPACTION_HEADROOM_TOKENS) =>
  Math.floor(Math.min(contextWindow * ratio, contextWindow - maxTokens - headroomTokens));

/**
 * 设置里的两条线（缺省取默认值），检查后返回；不合要求时抛错，启动器因此拒绝启动。
 * window／maxTokens：已知的本地模型窗口（localContextWindow）与请求的输出上限，给了就按 dsh 实际的压缩线检查。
 */
export function contextLines(settings = {}, { window, maxTokens } = {}) {
  const reliefRatio = settings.reliefRatio ?? RELIEF_RATIO;
  const compactionRatio = settings.compactionRatio ?? COMPACTION_RATIO;
  for (const [name, value] of [['reliefRatio', reliefRatio], ['compactionRatio', compactionRatio]]) {
    if (typeof value !== 'number' || !(value > 0 && value < 1)) throw new Error(`Deep Rulith: ${name} in the settings must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
  }
  if (reliefRatio >= compactionRatio) {
    throw new Error(`Deep Rulith: reliefRatio (${reliefRatio}) must be below compactionRatio (${compactionRatio}), or dsh compacts before context relief can act`);
  }
  if (Number.isInteger(window) && Number.isInteger(maxTokens)) {
    const line = compactionLine(window, compactionRatio, maxTokens);
    if (Math.floor(reliefRatio * window) >= line) {
      throw new Error(`Deep Rulith: with a ${window}-token window and ${maxTokens} output tokens dsh compacts at ${line} tokens, `
        + `which is not above the relief line ${Math.floor(reliefRatio * window)} (reliefRatio ${reliefRatio}); lower reliefRatio`);
    }
  }
  return { reliefRatio, compactionRatio };
}

/** 交给 dsh 的环境变量：rulith-web.cordis.yml 读它们设定 rulith-runtime 的减负线与 compaction-basic 的压缩配置。 */
export const contextEnv = ({ reliefRatio, compactionRatio }) => ({
  RULITH_DSH_RELIEF_RATIO: String(reliefRatio),
  RULITH_DSH_COMPACTION: JSON.stringify({ thresholdRatio: compactionRatio, headroomTokens: COMPACTION_HEADROOM_TOKENS,
    maxTokens: COMPACTION_SUMMARY_MAX_TOKENS }),
});

// 平台审查（D-1013f）走本机 Worker 的模型路线。下面是写进各个启用了 Worker 的实例 worker.env 的几项。
// 推理模型会把一部分 max_tokens 花在思考上：2026-10-14 用 2～2.5 万字符的审查材料重放，8000 全花在了思考上，所以给 16000。
// Runtime 的 Worker 不另行设定时把一次审查限在 120 s，即使 Gateway 的期限（现在可设到 300 s）更长；Worker 本来就按
// 报价里的 remainingMs 约束自己，所以这里把它自己的上限放到 Gateway 的最大值 300000 ms，实际期限仍由 Gateway 给。
export const REVIEWER_MAX_TOKENS = '16000';
export const REVIEWER_TIMEOUT_MS = '300000';
export const reviewerEnv = ({ baseURL, modelId, key }) => ({
  RULITH_REVIEWER_URL: `${baseURL}/chat/completions`, RULITH_REVIEWER_MODEL: String(modelId),
  RULITH_REVIEWER_KEY: key, RULITH_REVIEWER_MAX_TOKENS: REVIEWER_MAX_TOKENS, RULITH_REVIEWER_TIMEOUT_MS: REVIEWER_TIMEOUT_MS,
});

/**
 * 把这几项写进 managerHome 下每个启用了 Worker 的实例的 local.json（worker.env），其余内容原样保留；已经一样的不写。
 * 先写临时文件再改名，权限 0600（含密钥）。返回写了几个实例。
 */
export function writeReviewerEnv(managerHome, want) {
  const instances = path.join(managerHome, 'instances');
  let written = 0;
  for (const name of fs.existsSync(instances) ? fs.readdirSync(instances) : []) {
    const file = path.join(instances, name, 'local.json');
    if (!fs.existsSync(file)) continue;
    const local = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!local.worker?.enabled) continue;
    const env = local.worker.env ?? {};
    if (Object.entries(want).every(([k, v]) => env[k] === v)) continue;
    local.worker.env = { ...env, ...want };
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    written += 1;
  }
  return written;
}
