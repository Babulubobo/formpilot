# FormPilot 开发文档

[返回中文 README](../README-zh.md)

FormPilot 是 Chrome Manifest V3 侧栏扩展。生产运行没有 npm 依赖，不需要构建或本地浏览器代理；`extension/` 可直接加载。

## 本地运行

在 `chrome://extensions` 开启开发者模式，加载项目中的 `extension/` 文件夹，然后打开需要填写的网页。

修改扩展后，在 `chrome://extensions` 中重新加载 FormPilot，再刷新测试网页并重新打开侧栏。沿用原来的加载目录，以保留扩展本机数据。

## 处理流程

### 1. 扫描题目

页面脚本先通过原生控件、label/ARIA 关系和邻近文字提取题目。行内填空会组合输入框前后的可见文字，用 `THIS BLANK` / `OTHER BLANK` 区分同一句中的多个空格。

除原生控件外，还识别具有可见标签的隐藏单选/复选框、ARIA 单选组，并将重复排列的按钮或链接作为候选选项组。站内搜索框会被过滤。

题干缺失、选项重复或只读到内部编号时，先将局部可见文字、候选元素 ID、相对位置和关联证据交给 JEV 判断结构。模型只能选择网页已有候选的 ID，由程序复制原文并绑定控件；不生成标签文字或 CSS 选择器。导航和工具按钮等候选可被排除。

首次结构判断仍不确定时，扩大对应区域的文字候选范围重试一次。结构仍不完整则停止答题和翻页。结构判断阈值暂定为 `0.85`，尚未通过真实页面评测校准。

确认后的对应关系缓存在当前文档中。元素身份或候选文字变化时使对应区域缓存失效；异步模型结果返回后也重新检查来源，避免旧结果绑定到新题目。明确字段和未变化的已确认区域不额外调用结构模型。

「扫描页面」仅执行本地扫描；「开始填写」才会调用模型恢复结构并作答。现有菜鸟教程和 IndiaBIX 的站点适配仍用于已验证的题目、开始、翻页和成绩状态。

### 2. 生成答案

- **JEV** 使用 `jev-latest`，批量判断字段与选择选项；明确对应的事实资料可直接复制。
- **DeepSeek** 回答文字题，并复核 JEV 置信度低于 `0.8` 或返回 `skip` 的单选、下拉题。转交时包含题干与全部选项，与待回答文字题合并请求。
- DeepSeek 型号由下拉框选择：Flash（`deepseek-flash`，默认）或 V4 Pro（`deepseek-v4-pro`），均关闭思考模式。

选择题答案限制为网页已有选项的 ID。仍无法回答时返回原因，在侧栏显示。开放题可以起草为计划或期望；未知个人事实、已有经历、实际公司数据和明确同意不会编造。任务中已填答案及来源会传到后续页面，帮助保持一致。

结构阈值 `0.85` 与答题转交阈值 `0.8` 是两个独立判断，均为暂定参数，不是正确率承诺。执行记录分别展示结构判断、答题结果与转交原因。

### 3. 执行与检查

页面脚本执行点击和写入，再检查控件实际值与网页原生校验。保留已有非空内容、已勾选项，以及用户在模型等待期间作出的修改。

自定义选项必须能通过原生 `checked`、`aria-checked` / `aria-pressed`、`data-selected` 或 `selected` / `active` 类回读状态，否则暂停。站点适配可另行处理其已知状态。

必填项或选择题仍未作答、整页无可用答案、翻页目标不明确时停止。支持常见的「下一页 / 下一步 / Continue / Next」按钮，以及通过同一网址加载下一题的测验。默认自动翻页，最终提交默认关闭；普通页面只报告「已点击提交」，不视为服务器已经接受。

任务固定在开始时的标签页，切换标签页或关闭侧栏会停止。每次最多处理 80 个字段、运行 20 轮。

## 支持边界

支持主页面中的文本、邮箱、网址、电话、数字、日期、textarea、单选下拉框、单选组、复选框，以及上述部分自定义选项。支持常见使用原生控件的 React 表单。

尚不处理截图/OCR、Canvas、iframe、Shadow DOM、多选下拉框、文件上传、密码、验证码或跨站连续任务。非常规布局仍可能漏检或暂停。

## 权限与存储

- `activeTab`：工具栏点击后临时授权当前网页。缺少权限时，通过用户点击「授权此网站并扫描」按需申请当前网站访问权限。
- `tabs`：读取目标标签的地址与标题，本身不授予网页读写权限。
- `scripting` / `sidePanel` / `storage`：注入页面脚本、显示侧栏和保存设置。
- 固定 API 域名为 `api.typesafe.ai` 与 `api.deepseek.com`；普通网站的权限通过 `optional_host_permissions` 按需申请。

API Key 与用户偏好分开保存在 `chrome.storage.local`。存储访问级别限制为 `TRUSTED_CONTEXTS`，内容脚本不能读取。保存设置或开始任务时持久保存；重新加载同一个扩展、重启浏览器后保留，不使用 Chrome Sync。清空 Key 并保存可移除，卸载扩展会清除本机数据。

AI 请求包含本轮题目、选项、相关文字和参考资料，发往对应模型服务。最终提交授权仅在当前侧栏会话有效，不持久保存。

界面支持中英文，默认跟随浏览器语言；主题默认跟随系统。手动选择分别保存在本机。网页题目、用户资料和已填答案保持原文。

## 测试

运行 Node 内置测试：

```sh
npm test
```

覆盖模型返回值校验、批量调用、错误处理、已有值保护、必填项、停止、提交开关、翻页反馈、结构候选与本地化等逻辑。

浏览器测试需要 Playwright 和 Chromium：

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

测试使用临时服务器与独立浏览器配置，不读取日常浏览器数据，不调用真实模型。

- 首先加载未修改权限的扩展副本，实际触发无权限注入失败，验证授权入口、拒绝授权、授权期间换页及内部页提示；原生权限确认框的选择使用模拟结果。
- 随后在另一临时配置中，仅预授予本地测试地址权限，验证 DOM 注入、侧栏、资料保存及模拟 API 链路。生产 manifest 不包含该预授权。
- 使用无站点标记的 ARIA、分栏、按钮、链接和隐藏原生控件布局，检查候选覆盖、来源绑定、扩展重扫、缓存、过期结果拒绝和点击状态。

这些检查验证代码行为，不代表真实 JEV 或 DeepSeek 的语义识别与答题准确率。浏览器测试会将截图写入被 Git 忽略的 `test-results/`。

已有 Playwright 环境时，可设置 `PLAYWRIGHT_MODULE_PATH` 指向其 `index.mjs`，通过 `PLAYWRIGHT_BROWSERS_PATH` 指定浏览器缓存目录。

真实 API Key 只在扩展设置中填写；独立示例 `jev.mjs` 从环境变量 `TYPESAFE_API_KEY` 读取。环境文件、私钥、本地工具配置、日志和测试输出已加入 Git 忽略规则，不应提交实际凭据。

## 发布 Release

GitHub Release 使用与 `extension/manifest.json` 一致的版本标签（如 `v0.2.0`），更新说明保存在 `docs/releases/`。安装包固定命名为 `FormPilot-chrome.zip`，供 README 的最新版本下载链接使用。

发布前运行 `npm test`，完成需要的浏览器验证，并确认工作区已提交且没有凭据或本地数据。以下命令从当前提交中打包扩展文件，在 ZIP 根目录保留 `manifest.json`，并附带许可证与免责声明：

```sh
git archive --format=zip --output=FormPilot-chrome.zip --add-file=LICENSE --add-file=DISCLAIMER.md HEAD:extension
```

检查解压后的扩展能加载，再推送提交。创建 Release 时指定已经验证的完整提交 SHA，避免默认分支移动后版本标签与安装包不一致：

```sh
git push origin main
gh release create v0.2.0 FormPilot-chrome.zip --target "$(git rev-parse HEAD)" --title "FormPilot v0.2.0" --notes-file docs/releases/v0.2.0.md --latest
```

后续发布同步替换版本号与说明文件路径，不覆盖已有 Release。该流程发布 GitHub 安装包，不涉及浏览器商店审核或自动更新。

## 代码导航

- `extension/manifest.json` / `background.js`：权限、侧栏入口与存储隔离。
- `extension/content.js`：页面读取、结构候选、填写与点击。
- `extension/brain.js`：结构判断、JEV 答题与 DeepSeek 生成及复核。
- `extension/runner.js`：填写校验、翻页、停止与提交控制。
- `extension/sidepanel.*` / `i18n.js` / `_locales/`：侧栏与中英文本地化。
- `tests/`：Node 测试与浏览器验证。
- `jev.mjs`：独立 TypeSafe API 示例。

接口文档：[TypeSafe API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Confidence](https://docs.typesafe.ai/confidence)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。
