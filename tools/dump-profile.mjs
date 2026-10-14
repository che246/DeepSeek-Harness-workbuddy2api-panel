#!/usr/bin/env node
/**
 * 只读地把 desktop profile 合成一遍，确认改动没把配置写坏、插件没被兼容性检查跳过。
 *
 * 桌面版 profile 由 Electron App 独占管理（`dsh --profile desktop --dump-config`
 * 会被 CLI 拒绝），所以这里直接调 app-boot 的导出函数：加载 bundle 层 + 用户
 * patch 层 → `composeEntries` 合成最终树。全程只读，不挂载、不启动、不写文件。
 *
 * 用法：
 *   node tools/dump-profile.mjs           # 打印关键条目与 provider 归属
 *   node tools/dump-profile.mjs --all     # 额外打印整棵树
 */

import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const home = resolveDshHome()
const dir = `${home}/profiles/desktop`
const installAnchor = 'D:/Programs/DeepSeek Harness/resources/app/dsh'

const profile = loadProfileDirectory('dsh', dir, installAnchor)
const layers = [
  ...profile.layers.flatMap((layer) => layer.patches),
  ...profile.patches,
]
const warnings = []
const entries = composeEntries(layers, (message) => warnings.push(message))

console.log(`profile     : ${dir}`)
console.log(`bundle 层数 : ${profile.layers.length}`)
for (const layer of profile.layers) console.log(`  · ${layer.packageName}`)
console.log(`跳过 bundle : ${profile.skippedBundles.length === 0 ? '无' : JSON.stringify(profile.skippedBundles)}`)
console.log(`合成条目    : ${entries.length}`)
console.log(`合成告警    : ${warnings.length === 0 ? '无' : warnings.join(' | ')}\n`)

const rows = entries.filter((entry) => entry && typeof entry === 'object')
const find = (id) => rows.filter((row) => row.id === id || row.name === id)

for (const id of ['llm-pi-ai', 'llm-workbuddy2api', 'dsh-workbuddy2api-connect', 'llm-workbuddy', 'agent-default-model']) {
  const hit = find(id)
  if (hit.length === 0) {
    console.log(`· ${id}: 未出现`)
    continue
  }
  console.log(`· ${id}: ${hit.length} 条`)
  for (const row of hit) console.log(`    name=${row.name ?? '-'} config=${JSON.stringify(row.config ?? null).slice(0, 400)}`)
}

console.log('\n— provider 路由归属（谁声明了哪个路由）—')
let any = false
for (const row of rows) {
  const config = row.config
  if (config === null || typeof config !== 'object') continue
  const dict = config.providers
  if (dict === null || typeof dict !== 'object') continue
  for (const key of Object.keys(dict)) {
    any = true
    console.log(`  ${key} ← ${row.name ?? row.id}`)
  }
}
if (!any) console.log('  （没有 providers 字典 → 没有静态路由；网关路由由插件在运行时注册）')

if (process.argv.includes('--all')) {
  console.log('\n— 整棵树 —')
  console.log(JSON.stringify(entries, undefined, 2))
}
