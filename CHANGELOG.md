# CHANGELOG

## 0.2.0 — 2026-11-21

M3：LLM 通道打通并实跑。

- `obsidian://ui-zh?action=scan-all|scan-plugin&id=…|scan-current|translate-pending|restore|toggle|status` 外部触发入口
- 单插件扫描上限 `SCAN_CAP = 450`，防止一次扫描烧掉额度
- 扫描进度写入 `state.json`（`scanProgress` / `batchRun`），中断后可见
- 「上次扫描结果」面板：每个插件候选数 / 写入数 / 打回数 / 时间
- 非界面文案（代码、正则、日志、路径）由模型返回空串 → 记入 `skippedNonUi`，**下次不再花钱**
- LLM 译文写入 `llmCache` 并持久化，重复文案零费用
- 术语掩码扩展到 `%s`、`{0}`、`{{var}}`、`${x}` 变量保护
- 设置页新增扫描日志样式

### 首批实跑结果（2026-11-21）

| 插件 | 分片条目 | 界面串覆盖 |
|---|---|---|
| obsidian-markmind | 543 | 527 / 716（74%） |
| copilot | 309 | 268 / 3666* |
| dataview | 160 | 155 / 361（43%） |
| remotely-save | 101 | 95 / 5002* |
| obsidian-style-settings | 76 | 69 / 108（64%） |
| webviewer-bookmarks | 20 | 12 / 12（100%） |
| 通用 base | 306 | — |

\* 分母含大量打包进去的库代码字符串（日志、错误、日期样例），实际界面串远小于此。

- 合计 1515 条（通用 306 + 分片 1209），两轮请求约 60 次
- 术语大小写归一：`Pdf → PDF`、`api → API`、`id → ID`（独立单词，已回刷存量词条 76 条）
- 待译只剩 4 条，全是插件名/命令名（`Remotely Save`、`Open Copilot Agent Chat`…），按策略保持英文

### 长尾补翻（第二轮，同日）

- 扫描候选加「界面相似度」排序 + 噪声硬过滤（小写开头 / 含括号 / 对象字面量片段），同样预算下命中率从 9% 提到 70%
- 本轮新增 1055 条：copilot +195、obsidian-git +314（未启用插件，提前备好）、excalidraw +214、remotely-save +127、lang-plus +74、markmind +15、dataview +7、style-settings +9
- 分片词条总计 **2677 条**（9 个插件）+ 通用 306 条
- 覆盖：markmind 542/716、copilot 878/3666*、remotely-save 263/5002*、git 304/551、excalidraw 211/1620*、style-settings 77/108、dataview 162/361、webviewer 12/12

### 0.2.1 补丁（同日，Style Settings 主题标题）

- **主题扫描**：Style Settings 的标题/说明来自 `themes/*/theme.css` 与 `snippets/*.css` 的 `/* @settings */` 块，插件 main.js 里没有。新增 `extractCssSettingStrings()` + `scanThemeStyles()`，写入共享分片 `dict/plugins/_theme.json`（Soft Paper / AnuPpuccin / Minimal 共 669 条）
- **上下文判定修复**：独立设置窗口里 `.vertical-tab-nav-item.is-active` 取不到时，改用 `app.setting.lastTabId` / `activeTab`，Dataview 那批 label 之前没翻就是这个原因
- **待办清理修复**：`prunePending()` 改为 `lookupAny()` 全分片查词，避免已有译文重复进队列
- 新增命令「扫描主题样式（Style Settings）」+ 设置页按钮
- 待译从 92 条降到 2 条（只剩 `Remotely Save`、`Copilot Agent Chat` 两个插件/命令名）

## 0.1.0 — 2026-11-21

首个可用版本（M1 骨架 + M2 首批词条），纯词典离线可用。

- 运行时 DOM 翻译：只写 `nodeValue` 与 `placeholder/aria-label/title`，永不 `innerHTML`
- 跳过白名单：编辑器、阅读视图、代码块、公式、表单值、画布、PDF、图形视图
- 原文快照 + 一键还原 + 关闭即还原 + 卸载零残留
- MutationObserver 事件驱动（零轮询），空闲批处理（≤12ms/批，≤6000 节点/子树）
- 词典分片：`base.json`（305 条）/ `glossary.json`（keep + fixed）/ `plugins/<id>.json`
- 术语掩码 + 回填校验，术语丢失即打回
- LLM 通道（OpenAI 兼容 / DeepSeek）：批量 5–80 条、质量闸门、JSON 宽松解析、`response_format` 失败自动重试
- 三个扫描入口：当前界面 / 指定插件（静态读 main.js）/ 全部插件
- 待译队列 + 状态栏计数 + 导出待译清单到剪贴板
- 新插件检测：只提醒，不自动扫描（`autoScanOnNewPlugin` 默认关）
- 首批插件词条：dataview、remotely-save、webviewer-bookmarks、obsidian-style-settings、copilot、obsidian-markmind

### 真机验证（Obsidian 1.15.1，2026-11-21）

- 主窗口 + 独立设置窗口（`settingsPopoutWindow: true`）同时观察，`windows: 2` 时两窗都生效
- Dataview 设置页实测：前 20 个设置项中 8 项变中文（启用内联查询 / 启用 JavaScript 查询 / 视图 / 自动刷新视图 / 刷新间隔 / 日期格式…），其余未收录词条保持英文并进入待译队列
- Remotely Save 设置页实测：插件自带的 3 条未本地化文案被词典接管，`Access Key ID` / `Secret Access Key` 按术语表保持英文
- 还原测试：关闭开关后文本、占位符逐字节回到原文


### 0.2.2 修复（同日，翻译待办全被跳过）

- **根因**：术语掩码用 `new RegExp(term,'gi')` 做子串替换，`AI` / `ID` / `Git` 这类短词会把单词拆碎：
  `Email available for validation` → `Em@@K2@@l av@@K3@@lable for val@@K1@@ation`，
  模型无法还原占位符，全部被判 `token-lost` 打回，表现就是"一口气跳过几百个"。
- **修复**：ASCII 术语改用整词边界匹配（`(?<![A-Za-z0-9])term(?![A-Za-z0-9])`），中文/带符号术语仍按子串。
- 打回提示现在带原因汇总：`打回 312 条（术语丢失 300，非界面 12）`，不再只报个数字。
- 新增真实接口端到端测试 `dev/test-llm.js`（4 条样本全通过，含 `Email available` / `API Token`）。
- 自测 47 项通过。
