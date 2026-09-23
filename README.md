# FormPilot

**English** · [简体中文](README-zh.md)

**An AI quiz assistant for your browser.** FormPilot reads questions and options, generates answers, and selects or fills responses directly on the page.

![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-444444?style=flat-square)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-444444?style=flat-square)
[![Release](https://img.shields.io/github/v/release/Babulubobo/formpilot?style=flat-square&color=444444)](https://github.com/Babulubobo/formpilot/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-444444?style=flat-square)](LICENSE)

[Installation](#installation) · [Get started](#get-started) · [FAQ](#faq) · [Developer guide (中文)](docs/DEVELOPMENT.md)

## Features

- **Answer on the page**: start from the Chrome side panel and let FormPilot interact with the questions, without copying them between the page and a chat.
- **Choices and written answers**: supports radio buttons, checkboxes, dropdowns and text fields for knowledge questions, fill-in-the-blank exercises and open-ended responses.
- **Continue across pages**: looks for the next question or page after filling. Pauses before the final submission by default and explains when a question remains unanswered.
- **Optional reference details**: answers based on the questions. Add background, source material or instructions if useful; no prepared answers are needed.
- **Keep existing answers**: preserves content you have already filled in, shows results and an activity log in the side panel, and lets you stop at any time.
- **Choose your language and theme**: Chinese and English interfaces, with Light, Dark and System appearance settings.

## Installation

Requires **Chrome 116 or later**. Download the extension package from [Releases](https://github.com/Babulubobo/formpilot/releases/latest). No build step or npm dependencies are required; developer mode is still needed until a store version is available.

1. [Download FormPilot-chrome.zip](https://github.com/Babulubobo/formpilot/releases/latest/download/FormPilot-chrome.zip) and extract it into a folder you will keep for the extension.
2. Enter `chrome://extensions` in Chrome's address bar and enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the extracted folder containing **`manifest.json`**.
4. Pin **FormPilot** from the browser toolbar's extensions menu for easy access to the side panel.

In the release assets, choose **FormPilot-chrome.zip**. GitHub's **Source code** archives contain the full repository; if you use one of those instead, select its `extension` subfolder when loading.

## Get started

1. Open the page you want to answer and click the **FormPilot** toolbar icon.
2. Open **Settings & details → Model setup** and enter your **TypeSafe API Key** and **DeepSeek API Key**.
3. Under **Run options**, select **AI autofill** and click **Save settings**. You can leave all reference details blank.
4. Click **Fill form**. There is no need to scan first. If **Allow site & scan** appears, follow Chrome's prompt to allow access to the current site.
5. Review the answers on the page and in the side panel. Auto-advance is enabled by default, with a pause before the final submission so you can check the results.

Your settings are saved in this browser for future runs. To enable automatic submission, check **Allow submit** under Run options. This permission applies only to the current side panel session.

<details>
<summary>No API keys yet? Try the local demo</summary>

The demo is included in the [source repository ZIP](https://github.com/Babulubobo/formpilot/archive/refs/heads/main.zip). Download and extract the source, install Node.js, then run this command in the project directory:

```sh
npm run demo
```

Open the [local demo form](http://127.0.0.1:4173/demo/) and click the FormPilot icon. Under **Run options**, select **Local demo (no AI)**. Open **Reference details**, click **Load sample**, then start filling.

The demo contains 16 questions across 2 pages. It uses fixed rules and fictional details, makes no model calls, and does not represent AI speed or accuracy.

</details>

## FAQ

<details>
<summary>Do I need to fill in personal details first?</summary>

All reference details are optional. The models answer knowledge questions, fill-in-the-blank exercises and open-ended questions from the question content. Reference details supply personal facts, project background or instructions that the models would not otherwise know. You do not need to prepare answers; a short instruction such as "Keep answers brief and in English" is enough. Unknown real names, email addresses and personal history are not invented.

</details>

<details>
<summary>Why does DeepSeek answer choice questions too?</summary>

TypeSafe's JEV evaluates questions and options first. If it is uncertain or skips a choice question, FormPilot sends the question and all its options to DeepSeek for another attempt. DeepSeek also answers text questions. You can see the reason for each call in the **Activity log**.

AI mode requires your own service keys, and the respective providers charge for API usage. Local demo mode does not call these services.

</details>

<details>
<summary>Why did it pause, or fail to find any questions?</summary>

Make sure you are on a regular web page and have granted access by clicking the toolbar icon. Internal browser pages, such as Chrome settings, cannot be processed.

The task pauses if the question structure is incomplete, a choice is unanswered, a filled value cannot be verified, or the next-page button is ambiguous. The side panel shows the reason. Switching tabs or closing the side panel also stops the task while keeping answers already filled in. After addressing the issue, click **Fill form** again to rescan.

FormPilot currently supports native form controls in the main page, ARIA radio groups, and some button- or link-based options. It does not yet support iframes, Shadow DOM, image or Canvas questions, CAPTCHAs, or file uploads. Unusual layouts may still be missed, and model answers need review.

</details>

<details>
<summary>Do I need to enter my API keys again after updating?</summary>

No. Download the latest extension ZIP and replace the files in the original installation folder (the one containing `manifest.json`). Click the reload button on the FormPilot card at `chrome://extensions`, refresh the question page, then close and reopen the side panel. If you originally loaded from source, keep using its `extension` folder.

Settings and keys are retained when you update the same extension installation. Do not uninstall it first: uninstalling clears its local data.

</details>

## Data and permissions

API keys, reference details and settings are stored locally by the extension and are not synced through Chrome Sync. AI mode sends questions, options, relevant page text and reference details to the corresponding model services. Keys are used only to authenticate requests to their respective services and are not embedded in web pages. To remove a key, clear its input and save.

Website access is requested as needed and can be revoked from Chrome's extension details page. Installing FormPilot does not automatically grant read and write access to every website.

## Development and feedback

See the [developer guide (中文)](docs/DEVELOPMENT.md) for local development, model responsibilities, the scanning flow and test instructions.

If a question cannot be recognized or answered on the page, [open an issue](https://github.com/Babulubobo/formpilot/issues) with the page URL, extension version and side panel activity log. Remove personal details from the log first, and never include API keys.

## License and disclaimer

This project is licensed under the [MIT License](LICENSE), which permits use, copying, modification, distribution and commercial use, provided the license and copyright notice are retained.

FormPilot is provided "as is". AI answers may be incorrect, and web automation may perform unintended actions. Review answers and submission settings. See the [disclaimer (中文)](DISCLAIMER.md) for limitations, third-party services and liability information.

This project explicitly opposes using FormPilot for any illegal or criminal activity. Follow applicable laws, the target website's terms, and examination or quiz rules.
