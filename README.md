# 語音控制機器人（GitHub Pages）

按住麥克風說話，由 **Gemini** 理解中文語意（含否定、轉折句），控制畫面中的機器人前進、後退、左移、右移或回到中央。

## 功能

- 按住說話（Web Speech API，建議 Chrome / Edge）
- 語音轉文字後送交 Gemini 解析最終意圖
- 支援複雜句，例如：
  - 「不要往前不要往後，今天天氣真好所以請往右」→ 往右
  - 「機器人不會往右走但是他會往前或是往左走」→ 往前

## 本地預覽

用任意靜態伺服器開啟（需 HTTPS 或 localhost 才能用麥克風）：

```bash
npx --yes serve .
```

瀏覽 `http://localhost:3000`，**每次開啟**都會要求輸入 [Gemini API Key](https://aistudio.google.com/apikey)（僅本次瀏覽有效）。

## 部署到 GitHub Pages

1. 在 GitHub 建立新 repository（例如 `voice-robot`）。
2. 將此資料夾內 `index.html`、`styles.css`、`app.js` 推送到 `main` 分支。
3. 到 **Settings → Pages**：
   - Source: **Deploy from a branch**
   - Branch: `main` / `/ (root)`
4. 等待數分鐘，網址為：`https://<你的帳號>.github.io/<repo名稱>/`

### API Key 安全說明

此專案為純前端，API Key 每次進入頁面時輸入，**不會**寫入 GitHub，也**不會**長期存在瀏覽器（僅本次分頁有效）。

若要在公開網站長期使用，建議在 [Google AI Studio](https://aistudio.google.com/apikey) 為金鑰設定 **HTTP 網域限制**（填你的 `*.github.io` 網址），並監控用量。

## 檔案結構

```
├── index.html   # 頁面結構
├── styles.css   # 樣式與機器人外觀
├── app.js       # 語音、Gemini、移動邏輯
└── README.md
```

## 疑難排解

| 問題 | 作法 |
|------|------|
| **Gemini 429 配額用盡** | 點「設定」→ 選 **僅本機規則**（不消耗 API）；或等免費額度每日重置；或到 [AI Studio 用量](https://aistudio.google.com/) 查看 |
| 麥克風無法使用 | 使用 HTTPS（GitHub Pages）或 localhost；允許瀏覽器麥克風權限 |
| Gemini 錯誤 403 | 檢查 API Key、是否啟用 Generative Language API |
| 語意不準 | 改回「自動」或「僅 Gemini」；或在 `buildGeminiPrompt` 補充範例句 |

預設為 **自動**：Gemini 失敗（含 429）時會改用本機否定／轉折規則，仍可控制機器人。
