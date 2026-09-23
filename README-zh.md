# FormPilot

[English](README.md) · **简体中文**

**浏览器里的答题助手。** 读取网页题目和选项，用 AI 作答，直接在原网页完成选择与填写。

![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-444444?style=flat-square)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-444444?style=flat-square)
[![Release](https://img.shields.io/github/v/release/Babulubobo/formpilot?style=flat-square&color=444444)](https://github.com/Babulubobo/formpilot/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-444444?style=flat-square)](LICENSE)

[安装](#安装) · [开始使用](#开始使用) · [常见问题](#常见问题) · [开发文档](docs/DEVELOPMENT.md)

## 特性

- **在原网页答题**：在 Chrome 侧栏启动，读取当前页面并操作题目控件，无需来回复制题目和答案。
- **选择与文字作答**：识别单选、复选、下拉选项和文字输入框；支持知识题、填空与开放题。
- **连续处理多页**：填完后寻找下一题或下一页，默认在最终提交前暂停；题目未完成时显示原因。
- **参考资料可留空**：模型根据题目作答，也可补充背景、材料或回答要求，不用提前准备答案。
- **保留已有答案**：不覆盖已经填写的内容，侧栏显示本次结果与执行记录，可随时停止。
- **按习惯使用**：支持中文、英文，以及白天、黑夜、跟随系统三种外观。

## 安装

需要 **Chrome 116 或更新版本**。从 [Releases](https://github.com/Babulubobo/formpilot/releases/latest) 下载扩展包，无需构建或安装 npm 依赖；目前尚未上架商店，安装仍需开启开发者模式。

1. [下载 FormPilot-chrome.zip](https://github.com/Babulubobo/formpilot/releases/latest/download/FormPilot-chrome.zip)，解压到一个用于长期存放扩展的文件夹。
2. 在 Chrome 地址栏输入 `chrome://extensions`，开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压后包含 **`manifest.json`** 的文件夹。
4. 在浏览器工具栏的扩展菜单中固定 **FormPilot**，方便打开侧栏。

Release 附件请选择 **FormPilot-chrome.zip**。GitHub 自动提供的 **Source code** 是完整源码；如果下载的是源码包，加载时仍选择其中的 `extension` 子文件夹。

## 开始使用

1. 打开要作答的网页，点击工具栏的 **FormPilot** 图标。
2. 展开「设置与资料」→「模型连接」，填入自己的 **TypeSafe API Key** 和 **DeepSeek API Key**。
3. 在「运行选项」中选择「AI 自动填写」，点击「保存资料与设置」。参考资料可以全部留空。
4. 点击 **「开始填写」**。无需先扫描；如果出现「授权此网站并扫描」，按 Chrome 提示允许访问当前网站。
5. 在网页与侧栏查看结果。默认自动翻页，最终提交前会暂停，方便检查答案。

设置会保存在当前浏览器，之后打开题目页即可开始。需要自动提交时，在运行选项中勾选「允许最终提交」；该选择只在当前侧栏会话中生效。

<details>
<summary>没有 API Key？先体验本地演示</summary>

演示页包含在 [完整源码 ZIP](https://github.com/Babulubobo/formpilot/archive/refs/heads/main.zip) 中。下载并解压源码、安装 Node.js 后，在项目目录运行：

```sh
npm run demo
```

打开 [本地演示问卷](http://127.0.0.1:4173/demo/)，点击 FormPilot 图标。在「运行选项」中选择「本地演示（不调用 AI）」，再到「参考资料」点击「载入示例资料」，然后开始填写。

演示包含 2 页、16 道题，使用固定规则与虚构资料，不调用模型，不能代表 AI 的速度或准确率。

</details>

## 常见问题

<details>
<summary>必须先填写个人资料吗？</summary>

资料全部选填。知识题、填空和开放题由模型根据题目回答；参考资料用来补充它无法知道的个人事实、项目背景或作答要求。无需预先写好答案，也可以只填一句「用英文简短回答」。未知的真实姓名、邮箱和经历不会编造。

</details>

<details>
<summary>为什么选择题也会调用 DeepSeek？</summary>

TypeSafe 的 JEV 先判断题目和选项；遇到不确定或跳过的选择题，会把题干与全部选项交给 DeepSeek 再判断。文字题也由 DeepSeek 回答。具体调用原因可以在「执行记录」中查看。

AI 模式需要配置自己的服务密钥，API 用量由对应服务计费；本地演示模式不调用这些服务。

</details>

<details>
<summary>为什么会暂停，或提示没有找到题目？</summary>

先确认打开的是普通网页，并通过工具栏图标授予当前页面权限；浏览器设置页等内部页面无法处理。

题目结构不完整、选项未作答、填写结果无法确认或翻页按钮不明确时，任务会暂停，原因显示在侧栏。切换标签页或关闭侧栏也会停止任务，已填写的答案保留。处理问题后，再次点击「开始填写」会重新扫描。

目前支持主页面中的原生表单控件、ARIA 单选组及部分按钮或链接式选项；尚不支持 iframe、Shadow DOM、图片或 Canvas 题目、验证码与文件上传。特殊布局仍可能漏检，模型答案也需要核对。

</details>

<details>
<summary>更新插件后，需要重新填 API Key 吗？</summary>

不需要。下载新版扩展 ZIP，用其中的文件更新原来的安装文件夹（包含 `manifest.json` 的目录），在 `chrome://extensions` 中点击 FormPilot 卡片上的刷新按钮，再刷新题目网页、关闭并重新打开侧栏即可。如果最初从源码安装，继续沿用原来的 `extension` 文件夹。

沿用同一个扩展安装时，设置与 Key 会保留。不要先卸载扩展；卸载会清除其本机数据。

</details>

## 数据与权限

API Key、参考资料和设置保存在扩展的本机存储，不通过 Chrome Sync 同步。AI 模式会把题目、选项、相关页面文字和参考资料发送给对应的模型服务；Key 仅用于对应服务的请求认证，不会嵌入网页。清空 Key 输入框并保存可将其移除。

网站访问权限按需申请，可在 Chrome 的扩展详情中撤回。安装时不会直接获得全部网站的读写权限。

## 开发与反馈

本地运行、模型分工、扫描流程和测试方法见 [开发文档](docs/DEVELOPMENT.md)。

遇到无法识别或操作的题目，可以 [提交 Issue](https://github.com/Babulubobo/formpilot/issues)，附上页面链接、扩展版本和侧栏执行记录。请先移除记录中的个人资料，不要附带 API Key。

## 许可与免责声明

本项目采用 [MIT License](LICENSE)，允许使用、复制、修改、分发及商业使用，须保留许可证与版权声明。

FormPilot 按“现状”提供，AI 答案可能出错，网页自动化也可能发生误操作。请核对答案与提交设置；功能边界、第三方服务及责任限制见 [免责声明](DISCLAIMER.md)。

本项目明确反对将 FormPilot 用于任何违法犯罪活动。请遵守适用法律法规、目标网站条款及考试、测验规则。
