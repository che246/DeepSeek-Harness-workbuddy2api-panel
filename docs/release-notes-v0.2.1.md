# v0.2.1

把 **WorkBuddy2API 网关**的模型目录自动同步进 **DeepSeek Harness**，并带一个可视界面来增删网关路由。

## 宿主侧

- 启动时与之后按周期拉每条路由的 `/v1/models`，把 `name` / `reasoning_supported_efforts` / `context_length` / `max_output_tokens` / `supports_images` / `credits` 映射成 pi-ai model descriptor，注册成 DSH 的 provider 路由
- 模型表变化下一个刷新周期自动跟上；拉取失败保留上一份模型表并按 10s→20s→… 退避重试；另有磁盘缓存，首启网关不可达也不会出现空分组
- 路由配置存 `$DSH_HOME/.workbuddy2api-connect.json`；**密钥只进 DSH 凭据库**（`ctx.credentials`），配置文件里只有凭据名

## 界面

「插件」页 → 本插件配置区，每张卡**只填三样**：

| 字段 | 说明 |
|---|---|
| 分组名称 | 模型选择器里显示的分组名 |
| URL | 网关的 OpenAI 兼容基地址 |
| Key | 只写不回显；已保存时留空不改，可勾选清除 |

- 路由 id（provider 名）与凭据名由**分组名称自动派生**，新建时确定、之后改名不变（避免既有会话与 `agent-default-model` 指空）
- **保存即热重注册**并重拉模型表，不需要重启
- 状态行显示 `N 个模型 · 上下文 192K–1000K · 思考档 low/high/max · 可关思考 3 个 · 上次刷新`；失败时原样显示网关错误（如 `HTTP 401 invalid_api_key`）

## 思考档位

- 按网关声明逐档映射，未声明的档位显式写 `null`——pi-ai 对缺键的默认不对称，只写声明的档才不会让用户看到假档位
- 「关闭思考」只给 **deepseek 系**：下发 `thinking: {type: 'disabled'}`（实测真能关）。非 deepseek 系链路上没有关闭手段（`reasoning_effort: off` 会被网关降级回最低档，`thinking` 字段被上游忽略），所以不提供
- 守住一条不变式：**只有该模型的默认档能明确下发时才提供 `off`**，避免用户没选档位却被静默关掉思考

## 验证

```sh
node test/verify.mjs --offline   # 28 项：映射与派生规则
node test/verify.mjs             # 88 项：真连网关 + 真发最小对话 + 界面接口 + 客户端卡片
```

在线部分用一个假 Cordis 上下文把插件真跑起来（真 `apply`、真 `PiAiAdapter`、真 pi-ai、真网关、真 HTTP 处理函数），核对逐条上下文一致、思考开关的实际行为、界面接口的环回门禁与校验、热重注册、密钥写入与不回显、客户端卡片的字段与请求体。

## 已知边界

- 首次装/升级需要重启一次（provider 路由与客户端 bundle 都在 boot 时装配）
- 同一个 provider 路由不能被两个适配器拥有：本插件接管后请把 `@deepseek-ai/dsh-llm-pi-ai` 里同名的 `providers` 条目清空
- `max_output_tokens` 是上游声称值（网关侧实测普遍虚高），插件如实透传，可用 `maxTokensCap` 钳制
