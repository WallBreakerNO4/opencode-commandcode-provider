/**
 * config 块的进程级冻结与过期重采（disguise.md §9.3 偏离 b）：
 *
 * - 官方语义照抄：进程级只构建一次，首次需要时构建并冻结复用，失败结果同样冻结；
 * - 偏离 b：插件长驻可跨日，冻结值距构建超 24h 后由下一次取值触发**后台**重采——
 *   期间沿用旧值、主请求不等待（与 §6 版本头惰性刷新同节奏，24h、无抖动）；
 * - 防御超时（偏离 a：git 查询 2s/条）在 config-block.ts 采集层实现，本模块不管。
 *
 * 采集经 ConfigRuntime 既有接缝注入（testing.md §3 认可），生产用
 * createNodeConfigRuntime()；采集层承诺整体绝不抛错，此处防御性 catch 仅覆盖
 * 意外（采集器自身 bug），兜一个「非 git 九字段齐全」的显式空值形状让主请求照常发。
 */

import { consoleLogger, type DisguiseLogger } from "./logger.js"
import {
  collectConfigBlock,
  createNodeConfigRuntime,
  currentUtcDate,
  type ConfigBlock,
  type ConfigRuntime,
} from "./config-block.js"

/** 冻结值过期重采间隔（§11 参数速查：24h，与版本头惰性刷新同节奏） */
export const CONFIG_REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 采集意外失败的兜底形状：与非 git 仓库九字段齐全的显式空值同形（§9.1）。
 * cwd/platform 也包防御——工作目录被删时 process.cwd() 本身会 throw，兜底必须
 * 永远可构造，否则主请求拿不到任何 config 块。 */
function emptyConfigBlock(runtime: ConfigRuntime): ConfigBlock {
  const safe = (fn: () => string): string => {
    try {
      return fn()
    } catch {
      return ""
    }
  }
  return {
    workingDir: safe(() => runtime.cwd()),
    date: currentUtcDate(),
    environment: safe(() => runtime.platform()),
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  }
}

function deepFreeze(block: ConfigBlock): ConfigBlock {
  Object.freeze(block.structure)
  Object.freeze(block.recentCommits)
  return Object.freeze(block)
}

export interface FrozenConfigProvider {
  /**
   * 取冻结 config 块：首次调用构建并等待（官方「首次需要时构建」同语义）；此后
   * 同进程恒返回同一冻结对象；24h 过期后返回旧值并后台重采（主请求零等待）。
   */
  get(): Promise<ConfigBlock>
}

export function createFrozenConfigProvider(
  options: { runtime?: ConfigRuntime; logger?: DisguiseLogger } = {},
): FrozenConfigProvider {
  const runtime = options.runtime ?? createNodeConfigRuntime()
  const logger = options.logger ?? consoleLogger()

  let frozen: ConfigBlock | undefined
  let builtAt = 0
  let rebuilding: Promise<void> | undefined

  /** 单轮采集：collectConfigBlock 承诺整体绝不抛错；真抛（采集器自身缺陷）视为本轮采集失败 */
  function build(): Promise<ConfigBlock> {
    return collectConfigBlock(runtime)
  }

  return {
    async get(): Promise<ConfigBlock> {
      if (frozen === undefined) {
        try {
          frozen = deepFreeze(await build())
        } catch (error) {
          // 首次构建意外失败：没有旧值可沿用，兜显式空值形状（主请求照常发）
          logger.warn(`config 块首次构建意外失败，兜空值形状：${error instanceof Error ? error.message : String(error)}`)
          frozen = deepFreeze(emptyConfigBlock(runtime))
        }
        builtAt = Date.now()
        return frozen
      }
      if (Date.now() - builtAt >= CONFIG_REBUILD_INTERVAL_MS && rebuilding === undefined) {
        rebuilding = build()
          .then((block) => {
            frozen = deepFreeze(block)
            builtAt = Date.now()
          })
          .catch((error) => {
            // 重采意外失败沿用旧值（冻结语义），只记日志——旧数据好过空数据
            logger.warn(`config 块重采失败，沿用旧值：${error instanceof Error ? error.message : String(error)}`)
          })
          .finally(() => {
            rebuilding = undefined
          })
      }
      return frozen
    },
  }
}
