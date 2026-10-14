#!/usr/bin/env node
/** 扫一遍 DSH 安装里的 dsh.client 声明，打印 platform / inject / external 约定。 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const roots = [
  'D:/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai',
  'D:/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@earendil-works',
]

const rows = []
for (const root of roots) {
  if (!existsSync(root)) continue
  // root 本身就是 scope 目录（…/node_modules/@deepseek-ai），其下每个子目录是一个包
  for (const pkg of readdirSync(root, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const pkgJson = join(root, pkg.name, 'package.json')
    if (!existsSync(pkgJson)) continue
    try {
      const manifest = JSON.parse(readFileSync(pkgJson, 'utf8'))
      const decl = manifest.dsh?.client
      if (decl === undefined) continue
      const clientExport = manifest.exports?.['./client']
      rows.push({
        name: manifest.name,
        platform: decl.platform,
        immediately: decl.immediately,
        inject: decl.inject ?? [],
        external: decl.external ?? [],
        clientExport: typeof clientExport === 'string' ? clientExport : JSON.stringify(clientExport),
      })
    } catch {
      // 忽略读不了的包
    }
  }
}

console.log(`共 ${rows.length} 个包声明了 dsh.client\n`)
for (const row of rows) {
  console.log(`${row.name}`)
  console.log(`    platform=${row.platform} immediately=${row.immediately ?? '-'} client=${row.clientExport}`)
  if (row.inject.length > 0) console.log(`    inject  = ${row.inject.join(', ')}`)
  if (row.external.length > 0) console.log(`    external= ${row.external.join(', ')}`)
}
