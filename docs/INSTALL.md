# Windows 安装指南

## 1. 准备环境

- Zotero 10（清单也允许 11，未单独验收）。
- 一个现有 Obsidian 库，目录下应存在 `.obsidian`。
- 已配置默认模型的 DeepSeek Harness；需提供 agents、agentPresets、sessions、sessionPersistence、llm、attachments 服务。
- Node.js 22.19+、Python 3.11+，可在终端运行 `node --version` 与 `python --version`。

## 2. 安装两个 Zotero 插件

在 Zotero 的插件管理器中使用“从文件安装插件”，依次选择归档桥 `obsidian-literature-bridge-0.3.4.xpi` 与阅读插件 `zotero-nature-reader-0.2.9.xpi`。

通过 **工具 → Obsidian 文献笔记** 打开管理窗口，选择自己的库目录和笔记文件夹（默认相对文件夹 `文献阅读`）。发布版的库路径为空，必须先配置。

## 3. 配置 Python

源码目录需要保留在固定位置。打开该目录的 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-python.ps1
```

脚本仅在本项目的 `.venv` 内安装 PDF 依赖，不需要修改系统 Python 包。

## 4. 准备外部 Nature 技能

本项目不随包分发本机的 Nature 技能。请使用你已取得的、具备相应使用授权的技能目录。默认结构：

```text
%USERPROFILE%\.codex\skills\
  nature-reader\SKILL.md
  nature-reader\static\core\principles.md
  nature-reader\static\core\workflow.md
  nature-reader\static\core\output-contract.md
  nature-reader\static\fragments\source\pdf-text.md
  nature-reader\references\grounding-rules.md
  nature-shared\core\terminology-ledger.md
```

其他同目录 `nature-*` 技能可以一并被发现。自定义接入可通过 `backend/plugin.mjs` 的 `apply(ctx, config)` 配置 `skillRoot`、`python`、`workRoot`、`dshHome` 和 `agentPreset`，均是本机路径或配置值，不需要独立 API 密钥。

## 5. 接入 Harness

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-harness.ps1
```

脚本验证必要文件，备份并只更新自己的标记区块。默认 Desktop profile 位于 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`；其他路径使用 `-ProfilePath` 参数。随后重启 Harness。

本机连接文件由配套端自动生成在 `%USERPROFILE%\.dsh\zotero-nature\connection.json`，包含随机端口与凭据，由 Zotero 自动读取。该文件属于运行数据，不应提交到 Git。

## 6. 使用与更新

打开文献 PDF，使用阅读助手开始精读。再次打开读取已有结果；问答、图解与标注自动保存。首次生成内容会调用你配置的模型，可能消耗相应额度；演示模式不调用模型。

后续从 Releases 下载新版 XPI 手动更新。源码位置改变时重新运行 Harness 接入脚本。`work/` 是正文与生成进度缓存；Zotero 数据目录中的 `nature-reader/` 和 `obsidian-literature-bridge/` 保存定位、映射及归档状态，按自己的备份方案保留。

常见情况：

- 未连接：检查 Harness 已启动、默认模型有效、配套插件加载成功。
- 缺少 Nature 文件：按上面的资源列表检查外部技能目录。
- Obsidian 待同步：检查库目录可用、`.obsidian` 存在、笔记管理区标记完整。
- 扫描 PDF 无正文：先完成 OCR；首版不内置 OCR。
- 模型不支持图像：系统会说明仅依据图注与正文；不声称看过图片。
