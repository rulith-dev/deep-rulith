// 启动器（start-deep-rulith.mjs）里不读设置文件、不启动任何东西的部分，单独放在这里以便测试。
import fs from 'node:fs';
import path from 'node:path';
import { COMPACTION_HEADROOM_TOKENS, COMPACTION_RATIO, COMPACTION_SUMMARY_MAX_TOKENS, RELIEF_RATIO } from './context-relief.mjs';

/**
 * 设置里的两条线（deep-rulith.json 的 reliefRatio 与 compactionRatio，缺省取默认值；含义见 context-relief.mjs）。
 * 只拒绝本身不成立的设置：比例不在 0 与 1 之间，或减负比例不小于压缩比例——这时启动器拒绝启动。窗口较小、dsh 实际的
 * 压缩线更低时不拒绝：实际的减负线在运行时按会话的路线压到压缩线之前（board-transcript.mjs 记日志）。
 */
export function contextLines(settings = {}) {
  const reliefRatio = settings.reliefRatio ?? RELIEF_RATIO;
  const compactionRatio = settings.compactionRatio ?? COMPACTION_RATIO;
  for (const [name, value] of [['reliefRatio', reliefRatio], ['compactionRatio', compactionRatio]]) {
    if (typeof value !== 'number' || !(value > 0 && value < 1)) throw new Error(`Deep Rulith: ${name} in the settings must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
  }
  if (reliefRatio >= compactionRatio) {
    throw new Error(`Deep Rulith: reliefRatio (${reliefRatio}) must be below compactionRatio (${compactionRatio}), or dsh compacts before context relief can act`);
  }
  return { reliefRatio, compactionRatio };
}

/**
 * 交给 dsh 的环境变量：rulith-web.cordis.yml 读它们设定 rulith-runtime 的减负比例，以及 dsh compaction-basic 的压缩配置
 * （thresholdRatio、headroomTokens、摘要的输出上限；rulith-runtime 也读同一份，好算出实际的压缩线）。
 */
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
