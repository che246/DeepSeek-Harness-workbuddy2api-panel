#!/usr/bin/env node
/**
 * dsh-workbuddy2api-connect 的离线/在线验证台。
 *
 * 用一个假的 Cordis 上下文把插件真的跑起来（真 `apply()`、真 `PiAiAdapter`、真
 * pi-ai、真网关、真 HTTP 处理函数），逐条核对：
 *   1. 纯映射函数（模型名 / 思考档位 / 最大上下文）
 *   2. 真跑插件：拉模型表、注册 provider、逐条上下文比对
 *   3. 真发一条最小对话（含「关闭思考」与「默认档」两条实测）
 *   4. 界面接口：status / save / refresh 三个同源路由，含校验、环回门禁、
 *      凭据写入与热重注册
 *
 * 用法：
 *   node test/verify.mjs             # 在线（会真发 5 条最小对话）
 *   node test/verify.mjs --offline   # 离线：只核对纯映射函数
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  apply,
  bareModelId,
  credentialRefFor,
  deriveRouteId,
  displayNameOf,
  isDeepSeekFamily,
  modelsUrl,
  parseCatalog,
  rateOf,
  reasoningFields,
  toPiModel,
  WEB_BASE,
} from '../lib/index.js'

const offline = process.argv.includes('--offline')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ────────────────────────── [1] 离线：纯映射函数 ──────────────────────────

console.log('\n[1] 纯映射函数（不联网）')

const sample = parseCatalog({
  data: [
    {
      id: 'cn:glm-5.3',
      name: 'GLM-5.3',
      context_length: 1_000_000,
      max_output_tokens: 131_072,
      supports_reasoning: true,
      reasoning_supported_efforts: ['low', 'high', 'max'],
      can_disable_thinking: true,
      supports_images: true,
      credits: 'x0.79',
    },
    {
      id: 'cn:deepseek-v4-flash',
      name: 'Deepseek-V4-Flash',
      context_length: 1_000_000,
      max_output_tokens: 50_000,
      supports_reasoning: true,
      reasoning_supported_efforts: ['low', 'high', 'xhigh'],
      can_disable_thinking: true,
      supports_images: true,
      credits: 'x0.17',
    },
    {
      id: 'cn:auto',
      name: 'Auto',
      context_length: 256_000,
      max_output_tokens: 32_000,
      supports_reasoning: true,
      only_reasoning: true,
      supports_images: true,
    },
  ],
})

check('模型表解析出 3 条', sample.length === 3, `实际 ${sample.length}`)
check('域前缀剥离', bareModelId('global:gpt-5.6') === 'gpt-5.6')
check('deepseek 系判定（裸名口径）', isDeepSeekFamily('cn:deepseek-v4-flash') === true && isDeepSeekFamily('cn:glm-5.3') === false)
check('倍率规范', rateOf(sample[0]) === 'x0.79', `${rateOf(sample[0])}`)
check('倍率后缀只在 showRate 时出现', displayNameOf(sample[0], true) === 'GLM-5.3 · x0.79' && displayNameOf(sample[0], false) === 'GLM-5.3')

const glmReasoning = reasoningFields(sample[0])
check('glm：声明档位照抄', glmReasoning.reasoning === true && glmReasoning.thinkingLevelMap.low === 'low' && glmReasoning.thinkingLevelMap.high === 'high' && glmReasoning.thinkingLevelMap.max === 'max')
check('glm：未声明档位锁死为 null', glmReasoning.thinkingLevelMap.medium === null && glmReasoning.thinkingLevelMap.minimal === null)
check('glm：非 deepseek 系不给 off（网关照抄 thinking 但上游忽略它）', glmReasoning.thinkingLevelMap.off === null)

const dsReasoning = reasoningFields(sample[1])
check('deepseek：can_disable_thinking → off 可用', dsReasoning.thinkingLevelMap.off === 'off')
check('deepseek：xhigh 声明即出现', dsReasoning.thinkingLevelMap.xhigh === 'xhigh')

// 不变式：只有默认档也能明确下发时才提供 off——否则「未选档位」会被 pi-ai 的
// deepseek 分支翻译成 thinking.type=disabled，等于用户没选却被静默关掉思考。
const dsMedium = parseCatalog({ data: [{ id: 'cn:deepseek-only-medium', name: 'DS', supports_reasoning: true, reasoning_supported_efforts: ['medium'], can_disable_thinking: true }] })[0]
check('默认档不在支持集里 → 不给 off（避免静默关思考）', reasoningFields(dsMedium, { defaultLevel: 'high' }).thinkingLevelMap?.off === null)
check('默认档在支持集里 → 给 off', reasoningFields(dsMedium, { defaultLevel: 'medium' }).thinkingLevelMap?.off === 'off')
check('不指定默认档 → 按声明给 off', reasoningFields(dsMedium).thinkingLevelMap?.off === 'off')

const autoReasoning = reasoningFields(sample[2])
check('无档位声明的模型 → 非推理（不给假档位控件）', autoReasoning.reasoning === false)

const dsModel = toPiModel(sample[1], { provider: 'p', baseUrl: 'http://x/v1', defaultContextWindow: 262_144, defaultMaxTokens: 32_768, maxTokensCap: 0, showRate: true })
check('上下文取 context_length', dsModel.contextWindow === 1_000_000, `${dsModel.contextWindow}`)
check('输出上限取 max_output_tokens', dsModel.maxTokens === 50_000, `${dsModel.maxTokens}`)
check('deepseek 走 deepseek thinkingFormat（off 才能变成 thinking.type=disabled）', dsModel.compat.thinkingFormat === 'deepseek')
check('max_tokens 主字段', dsModel.compat.maxTokensField === 'max_tokens')
check('图像能力进 input', dsModel.input.join(',') === 'text,image')

const glmModel = toPiModel(sample[0], { provider: 'p', baseUrl: 'http://x/v1', defaultContextWindow: 262_144, defaultMaxTokens: 32_768, maxTokensCap: 131_072, showRate: false })
check('maxTokensCap 生效', glmModel.maxTokens === 131_072, `${glmModel.maxTokens}`)
check('非 deepseek 不覆盖 thinkingFormat', glmModel.compat.thinkingFormat === undefined)
check('模型表 URL 拼接', modelsUrl('http://127.0.0.1:7863/v1') === 'http://127.0.0.1:7863/v1/models' && modelsUrl('http://127.0.0.1:7863/api/models/') === 'http://127.0.0.1:7863/api/models')
check('凭据名派生', credentialRefFor('workbuddy2apicn') === 'WB2API_KEY_WORKBUDDY2APICN')
check('路由 id 按分组名称派生（ASCII 折小写）', deriveRouteId('work2api-CN', new Set()) === 'work2api-cn', deriveRouteId('work2api-CN', new Set()))
check('路由 id 派生：非 ASCII 名称退化为 wb2api', deriveRouteId('我的网关', new Set()) === 'wb2api', deriveRouteId('我的网关', new Set()))
check('路由 id 派生：重名加序号', deriveRouteId('My GW', new Set(['my-gw'])) === 'my-gw-2', deriveRouteId('My GW', new Set(['my-gw'])))
check('路由 id 派生：空白折叠为单个连字符、保留合法的点', deriveRouteId('  A  b..c  ', new Set()) === 'a-b..c', deriveRouteId('  A  b..c  ', new Set()))
check('路由 id 派生：去掉首尾符号', deriveRouteId('---x---', new Set()) === 'x', deriveRouteId('---x---', new Set()))

if (offline) {
  console.log(`\n离线核对完成：${checks - failures}/${checks} 通过`)
  process.exit(failures === 0 ? 0 : 1)
}

// ────────────────────────── 假上下文 ──────────────────────────

/** 从 DSH 凭据文件的 refs 段解析出 `名称: 值`。 */
function credentialsRefs() {
  const file = process.env['DSH_CREDENTIALS'] ?? join(homedir(), '.dsh', '.credentials.yaml')
  try {
    const text = readFileSync(file, 'utf8')
    const at = text.indexOf('refs:')
    const out = {}
    if (at === -1) return out
    for (const line of text.slice(at).split(/\r?\n/).slice(1)) {
      const match = /^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/.exec(line)
      if (match !== null) out[match[1]] = match[2]
    }
    return out
  } catch {
    return {}
  }
}

const refs = credentialsRefs()
const routes = [
  {
    id: 'workbuddy2apicn',
    displayName: 'work2api-CN',
    baseURL: process.env['WB2API_CN_BASE'] ?? 'http://192.168.1.201:7863/v1',
    apiKeyEnv: 'WORKBUDDY2APICN_API_KEY',
  },
  {
    id: 'workbuddy2api',
    displayName: 'work2api-AI',
    baseURL: process.env['WB2API_GLOBAL_BASE'] ?? 'http://192.168.1.201:7864/v1',
    apiKeyEnv: 'WORKBUDDY2API_API_KEY',
  },
]

const work = mkdtempSync(join(tmpdir(), 'wb2api-verify-'))
const configFile = join(work, 'routes.json')

const logs = []
const effects = []
const httpRoutes = new Map()
const keyWrites = []
let registrations = 0
let registered

const scope = {
  logger: {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message, error) => logs.push(['error', `${message}${error === undefined ? '' : ` ${error?.message ?? error}`}`]),
    debug: () => {},
  },
  get: (service) => {
    if (service === 'credentials') {
      return {
        resolve: async (ref) => (refs[ref] === undefined ? undefined : { value: refs[ref] }),
        set: async (ref, value) => {
          keyWrites.push({ action: 'set', ref, value })
          refs[ref] = value
        },
        unset: async (ref) => {
          keyWrites.push({ action: 'unset', ref })
          delete refs[ref]
        },
      }
    }
    return undefined
  },
  effect: (callback) => {
    const disposer = callback()
    if (typeof disposer === 'function') effects.push(disposer)
  },
  emit: (event) => logs.push(['emit', event]),
  inject: (names, callback) => {
    if (names.includes('webServer')) callback(scope)
  },
  webServer: {
    register: (route) => {
      httpRoutes.set(route.path, route.handler)
      return () => httpRoutes.delete(route.path)
    },
  },
  llm: {
    registerAdapter: (providers, adapter) => {
      registrations += 1
      registered = { providers, adapter }
      return () => {
        registered = undefined
      }
    },
  },
}

apply(scope, { routes, refreshMinutes: 30, timeoutMs: 20_000, showRate: true, maxTokensCap: 0, configFile })

// ────────────────────────── [2] 真跑插件 ──────────────────────────

console.log(`\n[2] 真跑插件（${routes.map((route) => route.id).join(', ')}）`)

check('注册了一次适配器', registered !== undefined, registered === undefined ? '没注册' : `routes=[${registered.providers.join(', ')}]`)

/** 等插件把真模型表拉回来。 */
async function waitForModels(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const models = await registered.adapter.listModels(provider)
    if (models.length > 0) return models
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return []
}

for (const route of routes) {
  const models = await waitForModels(route.id)
  check(`路由 ${route.id} 拉到模型`, models.length > 0, `${models.length} 个`)

  const sampleModel = models[0]
  if (sampleModel === undefined) continue
  const resolved = await registered.adapter.resolveModel(route.id, sampleModel.id)
  check(
    `路由 ${route.id} 首个模型的上下文窗口已带上`,
    typeof resolved.context?.contextWindow === 'number' && resolved.context.contextWindow > 0,
    `${sampleModel.id} → contextWindow=${resolved.context?.contextWindow}`,
  )

  const response = await fetch(modelsUrl(route.baseURL), { headers: { authorization: `Bearer ${refs[route.apiKeyEnv]}` } })
  const raw = parseCatalog(await response.json())
  let mismatched = 0
  for (const entry of raw) {
    const model = await registered.adapter.resolveModel(route.id, entry.id).catch(() => undefined)
    if (model === undefined) { mismatched += 1; continue }
    if (entry.contextWindow !== undefined && model.context?.contextWindow !== entry.contextWindow) mismatched += 1
  }
  check(`路由 ${route.id} 上下文窗口与网关逐条一致`, mismatched === 0, `不一致 ${mismatched}/${raw.length}`)

  const withThinking = raw.filter((entry) => reasoningFields(entry, { defaultLevel: 'high' }).reasoning === true)
  const withOff = raw.filter((entry) => reasoningFields(entry, { defaultLevel: 'high' }).thinkingLevelMap?.off === 'off')
  console.log(
    `    ${route.id}: ${raw.length} 个模型，` +
    `上下文 ${Math.round(Math.min(...raw.map((entry) => entry.contextWindow ?? 0)) / 1000)}K–${Math.round(Math.max(...raw.map((entry) => entry.contextWindow ?? 0)) / 1000)}K，` +
    `带思考档 ${withThinking.length} 个，可关思考 ${withOff.length} 个（${withOff.map((entry) => entry.id).join(', ') || '无'}）`,
  )
}

// ────────────────────────── [3] 真发最小对话 ──────────────────────────

console.log('\n[3] 真发一条最小对话（走插件注册的适配器）')

/** 跑一次 harness 层流式调用，收集分片。 */
async function streamOnce(provider, model, reasoningEffort) {
  const chunks = []
  const options = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回一个字：好' }] }],
    system: '你是极简助手.',
    maxTokens: 32,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
  const iterator = registered.adapter.stream(options)[Symbol.asyncIterator]()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const next = await iterator.next()
    if (next.done === true) break
    chunks.push(next.value)
  }
  return chunks
}

const textOf = (chunks) => chunks
  .filter((chunk) => chunk.type === 'text-delta' || chunk.type === 'text')
  .map((chunk) => chunk.delta ?? chunk.text ?? '')
  .join('')

const cnRoute = routes.find((route) => route.id === 'workbuddy2apicn') ?? routes[0]
if (cnRoute !== undefined) {
  try {
    const chunks = await streamOnce(cnRoute.id, 'cn:glm-5.3', 'high')
    check('glm-5.3（reasoningEffort=high）流式返回正文', textOf(chunks).length > 0, JSON.stringify(textOf(chunks).slice(0, 40)))
  } catch (error) {
    check('glm-5.3（reasoningEffort=high）流式返回正文', false, error.message)
  }

  try {
    const chunks = await streamOnce(cnRoute.id, 'cn:deepseek-v4-flash', 'off')
    const kinds = new Set(chunks.map((chunk) => chunk.type))
    check('deepseek-v4-flash（显式 off）有正文', textOf(chunks).length > 0, JSON.stringify(textOf(chunks).slice(0, 40)))
    check('deepseek-v4-flash（显式 off）没有思考块', !kinds.has('reasoning-delta') && !kinds.has('reasoning'), [...kinds].join(','))
  } catch (error) {
    check('deepseek-v4-flash（显式 off）流式返回正文', false, error.message)
  }

  try {
    const chunks = await streamOnce(cnRoute.id, 'cn:deepseek-v4-flash', undefined)
    const kinds = new Set(chunks.map((chunk) => chunk.type))
    check('deepseek-v4-flash（未给档位）走路由默认档而非静默关思考', kinds.has('reasoning-delta') || kinds.has('reasoning'), [...kinds].join(','))
  } catch (error) {
    check('deepseek-v4-flash（未给档位）走路由默认档', false, error.message)
  }
}

// ────────────────────────── [4] 界面接口 ──────────────────────────

console.log('\n[4] 界面接口（status / save / refresh）')

/** 假响应对象。 */
function fakeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(body) {
      res.body = body === undefined ? undefined : body.toString()
    },
    json() {
      return res.body === undefined ? undefined : JSON.parse(res.body)
    },
  }
  return res
}

/** 假请求对象（async iterable body）。 */
function fakeReq({ method = 'GET', host = '127.0.0.1:19387', origin, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    method,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
}

const handlerFor = (suffix) => httpRoutes.get(`${WEB_BASE}${suffix}`)

check('三个界面路由都挂上了', ['/status', '/save', '/refresh'].every((suffix) => typeof handlerFor(suffix) === 'function'), [...httpRoutes.keys()].join(', '))

{
  const res = fakeRes()
  await handlerFor('/status')(fakeReq(), res)
  const body = res.json()
  check('GET status 返回 200', res.statusCode === 200, `HTTP ${res.statusCode}`)
  check('status 列出两条路由', body?.routes?.length === 2, `${body?.routes?.length}`)
  check('status 带模型数与上下文范围', body?.routes?.[0]?.models > 0 && body?.routes?.[0]?.contextMax > 0, `models=${body?.routes?.[0]?.models} ctx=${body?.routes?.[0]?.contextMin}–${body?.routes?.[0]?.contextMax}`)
  check('status 报告密钥已配置', body?.routes?.every((route) => route.hasKey === true) === true)
  check('status 绝不回传密钥本身', !res.body.includes(refs['WORKBUDDY2API_API_KEY'] ?? '###') && !res.body.includes(refs['WORKBUDDY2APICN_API_KEY'] ?? '###'))
  check('status 带配置文件路径与刷新周期', typeof body?.configFile === 'string' && body.configFile === configFile, body?.configFile)
}

{
  const res = fakeRes()
  await handlerFor('/status')(fakeReq({ host: 'evil.example.com' }), res)
  check('非环回 Host 被拒（403）', res.statusCode === 403, `HTTP ${res.statusCode}`)
}

{
  const res = fakeRes()
  await handlerFor('/status')(fakeReq({ origin: 'https://evil.example.com' }), res)
  check('非环回 Origin 被拒（403）', res.statusCode === 403, `HTTP ${res.statusCode}`)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ id: 'bad id', baseURL: 'http://127.0.0.1:1/v1' }] } }), res)
  check('非法路由 id 被拒（400）', res.statusCode === 400 && /不合法/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ displayName: '', baseURL: 'http://127.0.0.1:1/v1' }] } }), res)
  check('既无 id 也无分组名称被拒（400）', res.statusCode === 400 && /分组名称/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ displayName: 'X', baseURL: 'http://127.0.0.1:1/v1' }, { displayName: 'X', baseURL: 'http://127.0.0.1:2/v1' }] } }), res)
  check('分组名称重复被拒（400）', res.statusCode === 400 && /分组名称重复/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ id: 'x', baseURL: 'ftp://example.com' }] } }), res)
  check('非 http(s) URL 被拒（400）', res.statusCode === 400 && /http/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ id: 'dup', baseURL: 'http://127.0.0.1:1/v1' }, { id: 'dup', baseURL: 'http://127.0.0.1:2/v1' }] } }), res)
  check('重复路由 id 被拒（400）', res.statusCode === 400 && /重复/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const before = registrations
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        // 既有路由：只改分组名、**不带凭据名**（界面正常保存时的形态）
        { id: 'workbuddy2apicn', displayName: 'CN-改过名', baseURL: routes[0].baseURL },
        // 新路由：界面上填一个 Key，凭据名留空 → 由宿主派生
        { id: 'myroute', displayName: '我的网关', baseURL: routes[1].baseURL, apiKey: refs['WORKBUDDY2API_API_KEY'] },
      ],
    },
  }), res)
  const body = res.json()
  check('保存成功并返回 200', res.statusCode === 200, `HTTP ${res.statusCode} ${body?.error ?? ''}`)
  check('保存后热重注册（未重启）', registrations > before, `${before} → ${registrations}`)
  check('新路由已生效', registered?.providers?.includes('myroute') === true, `routes=[${registered?.providers?.join(', ')}]`)
  check('改名生效', body?.routes?.some((route) => route.id === 'workbuddy2apicn' && route.displayName === 'CN-改过名') === true)
  check(
    '未带凭据名的既有路由沿用原凭据名（不会被改成派生名而丢密钥）',
    body?.routes?.find((route) => route.id === 'workbuddy2apicn')?.apiKeyEnv === 'WORKBUDDY2APICN_API_KEY',
    body?.routes?.find((route) => route.id === 'workbuddy2apicn')?.apiKeyEnv,
  )
  check(
    '新路由的密钥写进凭据库（按派生凭据名）',
    keyWrites.some((write) => write.action === 'set' && write.ref === credentialRefFor('myroute') && write.value === refs['WORKBUDDY2API_API_KEY']),
    JSON.stringify(keyWrites),
  )
  const onDisk = readFileSync(configFile, 'utf8')
  check('配置文件已落盘且不含明文密钥', JSON.parse(onDisk).routes.length === 2 && !onDisk.includes(refs['WORKBUDDY2API_API_KEY']), `routes=${JSON.parse(onDisk).routes.map((route) => route.id).join(',')}`)
  check('新路由也拉到了模型表（密钥经凭据库生效）', body?.routes?.find((route) => route.id === 'myroute')?.models > 0, `models=${body?.routes?.find((route) => route.id === 'myroute')?.models}`)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'CN', baseURL: routes[0].baseURL },
        { id: 'myroute', displayName: '我的网关', baseURL: routes[1].baseURL, clearKey: true },
      ],
    },
  }), res)
  check('清除 Key 走凭据库 unset', keyWrites.some((write) => write.action === 'unset' && write.ref === credentialRefFor('myroute')), JSON.stringify(keyWrites.slice(-2)))
  check('清除后状态显示未配置密钥', res.json()?.routes?.find((route) => route.id === 'myroute')?.hasKey === false)
}

{
  const res = fakeRes()
  await handlerFor('/refresh')(fakeReq({ method: 'POST' }), res)
  const body = res.json()
  check('POST refresh 返回 200', res.statusCode === 200, `HTTP ${res.statusCode}`)
  check(
    'refresh 后两条路由都有模型表（被清掉密钥的那条沿用上一份）',
    body?.routes?.every((route) => route.models > 0) === true,
    JSON.stringify(body?.routes?.map((route) => `${route.id}:${route.models}`)),
  )
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'CN', baseURL: routes[0].baseURL, apiKeyEnv: 'WORKBUDDY2APICN_API_KEY' },
        { id: 'badkey', displayName: '错误密钥', baseURL: routes[1].baseURL, apiKey: 'sk-definitely-wrong-key' },
      ],
    },
  }), res)
  const bad = res.json()?.routes?.find((route) => route.id === 'badkey')
  check('错误密钥的失败如实出现在状态里（不是静默空表）', typeof bad?.error === 'string' && /401|invalid_api_key/u.test(bad.error), bad?.error)
}

{
  // 界面只填「分组名称 / URL / Key」：新路由不带 id → 宿主按分组名称派生；
  // 既有路由回传 id（界面不展示）→ 改名不换 provider 名。
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'CN-再次改名', baseURL: routes[0].baseURL },
        { displayName: 'My Gateway', baseURL: routes[1].baseURL, apiKey: refs['WORKBUDDY2API_API_KEY'] },
      ],
    },
  }), res)
  const body = res.json()
  check(
    '新路由不带 id → 按分组名称派生',
    body?.routes?.some((route) => route.id === 'my-gateway' && route.displayName === 'My Gateway') === true,
    JSON.stringify(body?.routes?.map((route) => `${route.id}:${route.displayName}`)),
  )
  check(
    '既有路由改名后 provider 名保持不变（不破坏既有会话与默认模型）',
    body?.routes?.some((route) => route.id === 'workbuddy2apicn' && route.displayName === 'CN-再次改名') === true,
    JSON.stringify(body?.routes?.map((route) => `${route.id}:${route.displayName}`)),
  )
  check(
    '派生路由的凭据名跟着派生 id 走',
    keyWrites.some((write) => write.action === 'set' && write.ref === credentialRefFor('my-gateway')),
    JSON.stringify(keyWrites.slice(-1)),
  )
  check('派生出来的新路由也拉到了模型表', body?.routes?.find((route) => route.id === 'my-gateway')?.models > 0, `models=${body?.routes?.find((route) => route.id === 'my-gateway')?.models}`)
}

// 复位到最初两条路由（配置写在临时目录，这里只是让状态自洽）
{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'work2api-CN', baseURL: routes[0].baseURL, apiKeyEnv: 'WORKBUDDY2APICN_API_KEY' },
        { id: 'workbuddy2api', displayName: 'work2api-AI', baseURL: routes[1].baseURL, apiKeyEnv: 'WORKBUDDY2API_API_KEY' },
      ],
    },
  }), res)
  check('复位回两条路由且都能拉到模型', res.json()?.routes?.every((route) => route.models > 0) === true, JSON.stringify(res.json()?.routes?.map((route) => `${route.id}:${route.models}`)))
}

// ────────────────────────── [5] 客户端卡片 ──────────────────────────

console.log('\n[5] 客户端卡片（结构化核对：手写 React 桩）')

/**
 * 极简 React 桩：只实现本卡片用到的 5 个 API。
 * `useState` 按**每次渲染内的调用顺序**占槽位（所以每次渲染前要 `__begin()` 把游标
 * 归零，槽位本身跨渲染保留），`useEffect` 立刻执行回调（测试里靠它触发首次读取），
 * `createElement` 返回可遍历的普通对象。
 */
function createReactStub() {
  const slots = []
  const cleanups = []
  let cursor = 0
  return {
    slots,
    cleanups,
    /** 每次渲染前调用：重置 hook 游标。 */
    __begin() {
      cursor = 0
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      }]
    },
    useEffect(callback) {
      cleanups.push(callback())
    },
    useCallback(callback) {
      return callback
    },
  }
}

/** 深度优先找出第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 收集整棵树里的文本。 */
function collectText(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const child of node) collectText(child, out)
  else if (node !== null && typeof node === 'object') for (const child of node.children ?? []) collectText(child, out)
  return out
}

const loaderRegistrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => loaderRegistrations.push(registration) } }
await import(new URL('../lib/client.js', import.meta.url).href)

check('客户端 bundle 走 window.__ModuleLoader__.load 注册', loaderRegistrations.length === 1 && loaderRegistrations[0].id === 'dsh-workbuddy2api-connect', loaderRegistrations.map((entry) => entry.id).join(', '))

const reactStub = createReactStub()
const clientModule = loaderRegistrations[0].factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`客户端 bundle 要求了未声明的依赖：${specifier}`)
})
check('导出 name / apply / inject', typeof clientModule.apply === 'function' && clientModule.inject.includes('slots'), `${clientModule.name} inject=[${clientModule.inject}]`)

const slots = {
  registered: [],
  inject(name, callback) {
    check('挂到 plugins.bundle.config 插槽', name === 'plugins.bundle.config', name)
    callback()
  },
  register(options, Component) {
    this.registered.push({ options, Component })
    return () => {}
  },
}
clientModule.apply({ slots })
check(
  '注册键 = 包名（插件页按包名分发）',
  slots.registered.length === 1 && slots.registered[0].options.key === 'dsh-workbuddy2api-connect',
  JSON.stringify(slots.registered[0]?.options),
)

const cardStatus = {
  ok: true,
  configFile: 'C:/Users/x/.dsh/.workbuddy2api-connect.json',
  refreshMinutes: 30,
  updatedAt: '2026-10-15T03:00:00.000Z',
  routes: [
    {
      id: 'workbuddy2apicn',
      displayName: 'work2api-CN',
      baseURL: 'http://192.168.1.201:7863/v1',
      apiKeyEnv: 'WORKBUDDY2APICN_API_KEY',
      hasKey: true,
      reasoning: null,
      models: 20,
      fetchedAt: Date.now() - 60_000,
      source: 'live',
      error: null,
      contextMin: 192_000,
      contextMax: 1_000_000,
      efforts: ['low', 'high', 'max'],
      offCount: 3,
    },
  ],
}

const hostCalls = []
globalThis.fetch = async (url, options) => {
  hostCalls.push({ url: String(url), body: options?.body === undefined ? undefined : JSON.parse(options.body) })
  return { ok: true, status: 200, json: async () => cardStatus }
}

const Card = slots.registered[0].Component
/** 一次渲染（先归零 hook 游标）。 */
const render = (props) => {
  reactStub.__begin()
  return Card(props)
}
check('summary 视图返回一句话', typeof render({ view: 'summary' }) === 'string', render({ view: 'summary' }))

let tree = render({ view: 'page' })
await new Promise((resolve) => setTimeout(resolve, 30))
tree = render({ view: 'page' })

/** 收集所有 <span> 文本（字段标签就是 span；提示语是 div，不会混进来）。 */
const collectSpans = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectSpans(child, out)
    return out
  }
  if (node.type === 'span') out.push(...collectText(node))
  for (const child of node.children ?? []) collectSpans(child, out)
  return out
}

/** 收集一棵树里的全部 <input>（每次调用返回新数组）。 */
const collectInputs = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectInputs(child, out)
    return out
  }
  if (node.type === 'input') out.push(node)
  for (const child of node.children ?? []) collectInputs(child, out)
  return out
}

const inputs = collectInputs(tree)
const textInputs = inputs.filter((input) => input.props.type !== 'checkbox')
const fieldLabels = collectSpans(tree).join(' | ')
check(
  '卡片只渲染三个字段输入项（分组名称 / URL / Key）',
  textInputs.length === 3 && inputs.filter((input) => input.props.type === 'password').length === 1,
  `字段输入 ${textInputs.length} 个（含 1 个「清除 Key」复选框，共 ${inputs.length} 个 input）`,
)
check('字段标签就是这三样', fieldLabels.includes('分组名称') && fieldLabels.includes('URL（OpenAI 兼容基地址）') && /(^|\| )Key/u.test(fieldLabels), fieldLabels)
check('界面不再展示路由 id 与凭据名', !fieldLabels.includes('路由 id') && !fieldLabels.includes('凭据名'), fieldLabels)

const valueOf = (props) => textInputs.find((input) => input.props.value === props)?.props.value
check('URL 输入框带上了宿主返回的地址', valueOf('http://192.168.1.201:7863/v1') === 'http://192.168.1.201:7863/v1')
check(
  'Key 输入框留空、并标明已保存（不会被回显）',
  inputs.some((input) => input.props.type === 'password' && input.props.value === '' && /留空/u.test(input.props.placeholder ?? '')) && fieldLabels.includes('Key（已保存，留空不改）'),
)
check('路由状态显示模型数与上下文', /20 个模型/u.test(collectText(tree).join(' | ')) && /上下文 192K–1000K/u.test(collectText(tree).join(' | ')), collectText(tree).join(' | ').slice(0, 200))

const saveButton = findNode(tree, (node) => node.type === 'button' && collectText(node).join('') === '保存并生效')
check('找到「保存并生效」按钮', saveButton !== undefined)
saveButton?.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 30))
const saveCall = hostCalls.find((call) => call.url.endsWith('/save'))
check('保存把路由发给了宿主接口', saveCall !== undefined && saveCall.body.routes.length === 1, JSON.stringify(saveCall?.body))
check(
  '保存体回传既有路由的 id（改名不换 provider）且不带凭据名',
  saveCall?.body?.routes?.[0]?.id === 'workbuddy2apicn' && saveCall?.body?.routes?.[0]?.apiKeyEnv === undefined,
  JSON.stringify(saveCall?.body?.routes?.[0]),
)
check('保存成功后卡片给出提示', /已保存并生效/u.test(collectText(render({ view: 'page' })).join(' | ')))

const addButton = findNode(tree, (node) => node.type === 'button' && collectText(node).join('') === '＋ 添加路由')
addButton?.props.onClick()
tree = render({ view: 'page' })
const rowsAfterAdd = collectInputs(tree)
const emptyNames = rowsAfterAdd.filter((input) => input.props.placeholder === '例如 work2api-CN' && input.props.value === '')
const emptyUrls = rowsAfterAdd.filter((input) => input.props.placeholder === 'http://127.0.0.1:7863/v1' && input.props.value === '')
check('「添加路由」新增一行（id 留空待派生）', emptyNames.length === 1, `空的分组名称输入框 ${emptyNames.length} 个`)
check('新行的分组名称与 URL 都待填', emptyNames.length === 1 && emptyUrls.length === 1)

// ────────────────────────── 收尾 ──────────────────────────

console.log('\n— 插件日志 —')
for (const [level, message] of logs) if (level === 'info' || level === 'warn' || level === 'error') console.log(`  [${level}] ${message}`)

// 先拆干净（释放适配器注册 + 清掉自调度定时器），再退出：否则 Windows 上
// libuv 会在仍有未关闭句柄时抛 async.c 断言。
for (const disposer of effects) {
  try {
    disposer()
  } catch {
    // 释放失败不影响核对结论
  }
}
rmSync(work, { recursive: true, force: true })
await new Promise((resolve) => setTimeout(resolve, 100))

console.log(`\n在线核对完成：${checks - failures}/${checks} 通过`)
process.exitCode = failures === 0 ? 0 : 1
