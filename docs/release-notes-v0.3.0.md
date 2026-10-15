# v0.3.0

界面新增一个 **「命令与思考：完全展开」开关**（默认关闭），并修掉一处旧配置的语义错误。

## 新增：命令与思考展开开关

卡片顶部多了一个开关，控制 DSH「工作详情」（思考块 + 工具调用/命令）的展开程度：

| 开关 | 写入的值 | 效果 |
|---|---|---|
| 关（默认） | `ui-chat.transcriptView = standard` | 折叠已完成轮次、步骤分组——DSH 桌面版默认 |
| 开 | `ui-chat.transcriptView = verbose` | **轮次不折叠、步骤不分组**，命令与思考全部摊开 |

- 改的是 DSH 自己那个值（**设置 → 通用 → 工作详情**，同一个 `ui-chat` 设置分节），走 `ctx.configForms.get('ui-chat').set(...)`
- **立即生效，不需要重启**；宿主设置持久化（`settings.yaml`）
- 与 DSH 设置页**双向同步**：卡片订阅了设置变化，在设置页改了档位，开关跟着变
- 开关旁标出当前档位（`compact` 精简 / `standard` 标准 / `detailed` 详细 / `verbose` 完全展开）
- 宿主没有设置服务（headless）时开关禁用并说明原因，卡片与网关同步都不受影响

> 如果你之前靠 `cordis.patch.yml` 里的 `ui-chat.transcriptView: verbose` 默认全展开，这一版把它
> 改成了 `standard`（= 开关关闭），以符合「默认关闭」。想默认全展开：把开关打开，或把配置改回
> `verbose`。注意：在卡片或设置页改过之后，值会落到 `settings.yaml` 并覆盖 `cordis.patch.yml`。

## 其余

- 安装 / 发布流程与上一版相同（`python tools/cut-release.py`）
- 验证台：离线 28 项 + 在线 100 项（新增 12 项开关断言：默认关闭、打开写 `verbose`、关闭写回
  `standard`、设置页改动同步到开关、无设置服务时降级不崩）

> 说明文件里**不要**自带安装小节标题：`cut-release.py` 见到它就跳过追加，Release 正文里反而
> 没有安装步骤。安装章节由工具统一生成（桌面版 / Web / TUI 两条路径）。
