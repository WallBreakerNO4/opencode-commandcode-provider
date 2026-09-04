/**
 * 设备指纹（disguise.md §8，#9 校准后如实上报真机真值）。
 *
 * - 15 字段 components 结构、thumbmark 联合哈希的拼接序与「五字段不入哈希」结构
 *   照抄调研 §1.2–§1.3（服务端无从校验原像，结构同构无成本）；
 * - 输入换成真机真值：platform / 内核版本 / CPU / 内存 / 时区 / 网卡——真机真值
 *   天然确定，指纹跨进程稳定随之免费获得（MAXeaglet 的 win32 随机池假人格弃用）；
 * - 采集器直接读系统 API（testing.md §1.5：不单测、不抽象注入接口，正确性归
 *   真机人工验收）；哈希纯函数照测（注入固定输入）。
 */

import { exec } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"
import { sha256Hex } from "./hash.js"

const execAsync = promisify(exec)

/**
 * 采集命令（ioreg / reg query / git config）的防御超时，到点按失败处理。取值与
 * §11 参数速查的「git 查询防御超时」同参数（2s/条）同理由（纯客户端防御）；
 * 官方无指纹采集器可照抄，此为采集实现自身的防御决策。
 */
const COLLECT_COMMAND_TIMEOUT_MS = 2000

/** components 15 字段（调研 §1.4）；键序即 wire 序 */
export interface FingerprintComponents {
  machineIdHash: string
  macHashes: string[]
  osUserHash: string
  hostnameHash: string
  gitEmailHash: string
  platform: string
  arch: string
  osRelease: string
  cpuModel: string
  cpuCount: number
  memGiB: number
  isContainer: boolean
  timezone: string
  runtime: string
  collectorVersion: number
}

/** `/alpha/fingerprint/record` 的 body 形状 */
export interface FingerprintBody {
  thumbmark: string
  components: FingerprintComponents
}

/**
 * thumbmark 联合哈希：参与字段为 machineIdHash → macHashes（按序全部）→ osUserHash
 * → hostnameHash → gitEmailHash → platform → osRelease → cpuModel → cpuCount →
 * memGiB，分隔符 `|`；arch / timezone / isContainer / runtime / collectorVersion
 * 五字段不入哈希（调研 §1.3，原样保留该实现取舍）。
 */
export function computeThumbmark(components: FingerprintComponents): string {
  const thumbData = [
    components.machineIdHash,
    ...components.macHashes,
    components.osUserHash,
    components.hostnameHash,
    components.gitEmailHash,
    components.platform,
    components.osRelease,
    components.cpuModel,
    String(components.cpuCount),
    String(components.memGiB),
  ].join("|")
  return sha256Hex(thumbData)
}

/** 组装 record body：thumbmark 重算，components 原样搬运 */
export function buildFingerprintBody(components: FingerprintComponents): FingerprintBody {
  return { thumbmark: computeThumbmark(components), components }
}

async function runCapture(command: string): Promise<string> {
  try {
    const { stdout } = await execAsync(command, { signal: AbortSignal.timeout(COLLECT_COMMAND_TIMEOUT_MS), windowsHide: true })
    return stdout.trim()
  } catch {
    return ""
  }
}

/**
 * machineId 原像：跨重启稳定的机器标识。Linux 读 /etc/machine-id，macOS 读
 * IOPlatformUUID，Windows 读注册表 MachineGuid；取不到时退 hostname 拼接串——
 * 服务端无从校验原像（调研 §1.2），只需保证 64hex 形状与跨进程稳定。
 */
async function machineIdSeed(hostname: string): Promise<string> {
  if (process.platform === "linux") {
    const id = await readFile("/etc/machine-id", "utf8").then((raw) => raw.trim()).catch(() => "")
    if (id) return id
  }
  if (process.platform === "darwin") {
    const out = await runCapture("ioreg -rd1 -c IOPlatformExpertDevice")
    const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1]
    if (uuid) return uuid
  }
  if (process.platform === "win32") {
    const out = await runCapture("reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid")
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1]
    if (guid) return guid
  }
  return `machine-id:${hostname}`
}

/** macHashes 按真实网卡数量生成（#9：多网卡主机 29 个）——非 internal 接口逐个入哈希 */
function macSeeds(): string[] {
  const seeds: string[] = []
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces ?? []) {
      if (!iface.internal) seeds.push(iface.mac)
    }
  }
  return seeds
}

/** 采集真机真值并计算各字段哈希与 thumbmark；进程启动时调用一次（disguise.md §1） */
export async function collectFingerprintComponents(): Promise<FingerprintComponents> {
  const hostname = os.hostname()
  const [machineIdSeedValue, gitEmail] = await Promise.all([
    machineIdSeed(hostname),
    runCapture("git config --get user.email"),
  ])
  // 无 passwd 条目的环境（个别容器）会抛错，退环境变量兜底
  let username = ""
  try {
    username = os.userInfo().username
  } catch {
    username = process.env["USER"] ?? process.env["USERNAME"] ?? ""
  }

  const components: FingerprintComponents = {
    machineIdHash: sha256Hex(machineIdSeedValue),
    macHashes: macSeeds().map(sha256Hex),
    osUserHash: sha256Hex(username),
    hostnameHash: sha256Hex(hostname),
    gitEmailHash: sha256Hex(gitEmail),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? "",
    cpuCount: os.cpus().length,
    memGiB: Math.round(os.totalmem() / 2 ** 30),
    // 抓包样本恒 false（§11.3），真实 CLI 的检测语义无从考证，照抄观测值
    isContainer: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    runtime: "cli",
    collectorVersion: 1,
  }
  return components
}
