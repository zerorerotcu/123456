const STORAGE_KEY = "gemini_api_key";
const STORAGE_PARSE_MODE = "parse_mode";
const STEP_PX = 56;
/** 配額較寬的模型優先；429 時會依序嘗試下一個 */
const GEMINI_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash-8b",
  "gemini-2.0-flash",
];

const ACTION_LABELS = {
  forward: "往前",
  backward: "往後",
  left: "往左",
  right: "往右",
  center: "回到中央",
  none: "不移動",
};

const elements = {
  arena: document.getElementById("arena"),
  robot: document.getElementById("robot"),
  btnTalk: document.getElementById("btnTalk"),
  btnCenter: document.getElementById("btnCenter"),
  statusText: document.getElementById("statusText"),
  transcript: document.getElementById("transcript"),
  intentDisplay: document.getElementById("intentDisplay"),
  settingsDialog: document.getElementById("settingsDialog"),
  settingsForm: document.getElementById("settingsForm"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  btnOpenSettings: document.getElementById("btnOpenSettings"),
  btnOpenSettingsMain: document.getElementById("btnOpenSettingsMain"),
};

/** @type {{ x: number, y: number, centerX: number, centerY: number, maxX: number, maxY: number }} */
const state = {
  x: 0,
  y: 0,
  centerX: 0,
  centerY: 0,
  maxX: 0,
  maxY: 0,
};

let apiKey = localStorage.getItem(STORAGE_KEY) || "";
let parseMode = localStorage.getItem(STORAGE_PARSE_MODE) || "auto";
let recognition = null;
let isListening = false;
let isProcessing = false;

const DIRECTION_RULES = [
  { action: "forward", pattern: /往前|向前|前進|前走|前移|朝前/g },
  { action: "backward", pattern: /往後|向后|後退|后退|後走|后移|朝後|朝后/g },
  { action: "left", pattern: /往左|向左|左移|左走|朝左|左转|左轉/g },
  { action: "right", pattern: /往右|向右|右移|右走|朝右|右转|右轉/g },
];

const CENTER_PATTERN = /回(到)?中央|回(到)?中間|歸位|回原點|回家|置中/;
const CLAUSE_SPLIT = /[，。；、]|但是|但|不過|不过|然而|所以|因此|那就|請你?|麻煩/;
const NEGATION_BEFORE = /(不要|別|勿|沒有?|不能|不可|不會|不願|不想|非)\s*$/;

function setStatus(text) {
  elements.statusText.textContent = text;
}

function setIntent(text, isError = false) {
  elements.intentDisplay.textContent = text;
  elements.intentDisplay.classList.toggle("error", isError);
}

function getApiKey() {
  return apiKey.trim();
}

function getParseMode() {
  return parseMode;
}

function needsApiKey() {
  return getParseMode() === "gemini";
}

function showSettingsIfNeeded() {
  if (getParseMode() === "local") return true;
  if (!getApiKey()) {
    openSettings();
    return false;
  }
  return true;
}

function openSettings() {
  syncSettingsForm();
  elements.settingsDialog.showModal();
}

function saveSettings(key, mode) {
  apiKey = key.trim();
  parseMode = mode;
  localStorage.setItem(STORAGE_KEY, apiKey);
  localStorage.setItem(STORAGE_PARSE_MODE, parseMode);
}

function syncSettingsForm() {
  elements.apiKeyInput.value = apiKey;
  const radio = elements.settingsForm.querySelector(
    `input[name="parseMode"][value="${parseMode}"]`
  );
  if (radio) radio.checked = true;
}

function isQuotaError(status, bodyText) {
  return status === 429 || /quota|rate limit|exceeded/i.test(bodyText || "");
}

/**
 * 本機語意解析：處理否定與轉折句（Gemini 配額用盡時的備援）
 * @returns {{ action: string, reason: string, source: string }}
 */
function parseIntentLocally(userText) {
  const text = userText.replace(/\s+/g, "");

  if (CENTER_PATTERN.test(text)) {
    const idx = text.search(CENTER_PATTERN);
    const before = text.slice(Math.max(0, idx - 8), idx);
    if (!NEGATION_BEFORE.test(before)) {
      return { action: "center", reason: "偵測到回到中央的指令", source: "local" };
    }
  }

  const clauses = text.split(CLAUSE_SPLIT).filter(Boolean);
  const segments = clauses.length ? clauses : [text];

  /** @type {{ action: string, index: number, clauseIndex: number, negated: boolean }[]} */
  const mentions = [];

  segments.forEach((clause, clauseIndex) => {
    for (const { action, pattern } of DIRECTION_RULES) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = re.exec(clause)) !== null) {
        const at = match.index;
        const before = clause.slice(Math.max(0, at - 12), at);
        let negated = NEGATION_BEFORE.test(before);
        if (/不會\s*$/.test(before) || /不會.*走/.test(before + match[0])) {
          negated = true;
        }
        if (/會\s*$/.test(before) && !/不會\s*$/.test(before)) {
          negated = false;
        }
        mentions.push({
          action,
          index: at,
          clauseIndex,
          negated,
        });
      }
    }
  });

  const affirmative = mentions.filter((m) => !m.negated);
  if (!affirmative.length) {
    return { action: "none", reason: "僅偵測到否定或未辨識方向", source: "local" };
  }

  const laterClause = Math.max(...affirmative.map((m) => m.clauseIndex));
  const inLater = affirmative.filter((m) => m.clauseIndex === laterClause);
  const pool = inLater.length > 1 ? inLater : affirmative;

  pool.sort((a, b) => {
    if (a.clauseIndex !== b.clauseIndex) return b.clauseIndex - a.clauseIndex;
    return a.index - b.index;
  });

  const chosen = pool[0];
  return {
    action: chosen.action,
    reason: `本機規則辨識為「${ACTION_LABELS[chosen.action]}」`,
    source: "local",
  };
}

function measureArena() {
  const rect = elements.arena.getBoundingClientRect();
  const robotRect = elements.robot.getBoundingClientRect();
  const halfRobot = robotRect.width / 2;
  state.centerX = rect.width / 2;
  state.centerY = rect.height / 2;
  state.maxX = Math.floor((rect.width / 2 - halfRobot - 8) / STEP_PX);
  state.maxY = Math.floor((rect.height / 2 - halfRobot - 8) / STEP_PX);
}

function applyRobotPosition(animateClass = "") {
  const left = state.centerX + state.x * STEP_PX;
  const top = state.centerY + state.y * STEP_PX;
  elements.robot.style.left = `${left}px`;
  elements.robot.style.top = `${top}px`;

  elements.robot.classList.remove(
    "moving-forward",
    "moving-backward",
    "moving-left",
    "moving-right"
  );
  if (animateClass) {
    elements.robot.classList.add(animateClass);
    window.setTimeout(() => {
      elements.robot.classList.remove(animateClass);
    }, 500);
  }
}

function resetToCenter() {
  state.x = 0;
  state.y = 0;
  applyRobotPosition();
}

function moveByAction(action) {
  measureArena();
  let animateClass = "";

  switch (action) {
    case "forward":
      if (state.y > -state.maxY) {
        state.y -= 1;
        animateClass = "moving-forward";
      }
      break;
    case "backward":
      if (state.y < state.maxY) {
        state.y += 1;
        animateClass = "moving-backward";
      }
      break;
    case "left":
      if (state.x > -state.maxX) {
        state.x -= 1;
        animateClass = "moving-left";
      }
      break;
    case "right":
      if (state.x < state.maxX) {
        state.x += 1;
        animateClass = "moving-right";
      }
      break;
    case "center":
      resetToCenter();
      return;
    case "none":
    default:
      return;
  }

  applyRobotPosition(animateClass);
}

function buildGeminiPrompt(userText) {
  return `你是語音指令解析器。使用者用中文（可能夾雜口語、贅句、轉折）控制畫面上的機器人移動。

請仔細分析「否定、雙重否定、轉折、但、不過、然而、所以、請」等語氣，找出使用者最終真正希望機器人執行的「單一」動作。

規則：
1. 「不要往前」「別往左」等否定該方向，不代表執行其他方向，除非句中明確要求另一方向。
2. 若同時提到多個被否定的方向，又明確說「請往右」「往右走」等，以明確肯定的方向為準。
   例：「不要往前不要往後，今天天氣真好所以請往右」→ right
3. 若說「不會往右」但「會往前或是往左」，以最先出現的明確肯定動作為準（通常為 forward/backward/left/right 其中之一）。
   例：「機器人不會往右走但是他會往前或是往左走」→ forward
4. 「回中央」「回到中間」「歸位」「回家」→ center
5. 若完全無法判斷要移動的方向 → none
6. 只輸出 JSON，不要 markdown，格式：
{"action":"forward|backward|left|right|center|none","reason":"簡短中文說明"}

使用者說的話：
${userText}`;
}

async function parseIntentWithGemini(userText) {
  const key = getApiKey();
  if (!key) throw new Error("請先設定 Gemini API Key");

  const body = {
    contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(userText) }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  };

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const errText = res.ok ? "" : await res.text();

    if (!res.ok) {
      if (isQuotaError(res.status, errText)) {
        lastError = { status: res.status, body: errText, quota: true };
        continue;
      }
      throw new Error(formatGeminiError(res.status, errText));
    }

    const data = await res.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("無法解析 AI 回傳的 JSON");
      parsed = JSON.parse(match[0]);
    }

    const action = String(parsed.action || "none").toLowerCase();
    const valid = ["forward", "backward", "left", "right", "center", "none"];
    if (!valid.includes(action)) {
      return {
        action: "none",
        reason: parsed.reason || "無法辨識動作",
        source: `gemini:${model}`,
      };
    }

    return {
      action,
      reason: parsed.reason || ACTION_LABELS[action],
      source: `gemini:${model}`,
    };
  }

  const err = new Error(formatGeminiError(lastError?.status || 429, lastError?.body || ""));
  err.quotaExceeded = true;
  throw err;
}

function formatGeminiError(status, errText) {
  if (isQuotaError(status, errText)) {
    return (
      "Gemini 免費配額已用完（429）。請改選「僅本機規則」、等候配額重置，" +
      "或至 Google AI Studio 查看用量／升級方案。"
    );
  }
  let snippet = "";
  try {
    const j = JSON.parse(errText);
    snippet = j?.error?.message || "";
  } catch {
    snippet = errText.slice(0, 120);
  }
  return `Gemini API 錯誤 (${status})${snippet ? `：${snippet}` : ""}`;
}

async function parseIntent(userText) {
  const mode = getParseMode();

  if (mode === "local") {
    return parseIntentLocally(userText);
  }

  if (mode === "gemini") {
    const result = await parseIntentWithGemini(userText);
    return result;
  }

  if (!getApiKey()) {
    return parseIntentLocally(userText);
  }

  try {
    return await parseIntentWithGemini(userText);
  } catch (err) {
    if (err.quotaExceeded || isQuotaError(429, err.message)) {
      const local = parseIntentLocally(userText);
      local.reason = `${local.reason}（Gemini 配額不足，已自動改用本機）`;
      return local;
    }
    throw err;
  }
}

async function handleTranscript(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    setStatus("沒有聽到內容，請再試一次");
    return;
  }

  elements.transcript.textContent = trimmed;
  isProcessing = true;
  elements.btnTalk.disabled = true;
  const modeLabel =
    getParseMode() === "local"
      ? "本機規則"
      : getParseMode() === "gemini"
        ? "Gemini"
        : "自動";
  setStatus(`正在以「${modeLabel}」理解語意…`);
  setIntent("分析中…");

  try {
    const { action, reason, source } = await parseIntent(trimmed);
    const label = ACTION_LABELS[action] || action;
    const via = source?.startsWith("gemini") ? "Gemini" : "本機";
    setIntent(`${label} — ${reason}（${via}）`);

    if (action === "none") {
      setStatus("已理解，但不需要移動機器人");
    } else {
      moveByAction(action);
      setStatus(`已執行：${label}`);
    }
  } catch (err) {
    console.error(err);
    setIntent(err.message || "解析失敗", true);
    setStatus("發生錯誤，請檢查 API Key 或網路");
  } finally {
    isProcessing = false;
    elements.btnTalk.disabled = false;
  }
}

function createSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    setStatus("此瀏覽器不支援語音辨識，請使用 Chrome 或 Edge");
    elements.btnTalk.disabled = true;
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang = "zh-TW";
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  let finalText = "";

  rec.onstart = () => {
    finalText = "";
    isListening = true;
    elements.robot.classList.add("listening");
    elements.btnTalk.setAttribute("aria-pressed", "true");
    elements.btnTalk.querySelector(".btn-label").textContent = "放開結束";
    setStatus("正在聆聽…");
  };

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      if (result.isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    elements.transcript.textContent = (finalText + interim).trim() || "…";
  };

  rec.onerror = (event) => {
    if (event.error === "no-speech") {
      setStatus("沒有偵測到語音，請再試一次");
      return;
    }
    if (event.error === "aborted") return;
    setStatus(`語音錯誤：${event.error}`);
  };

  rec.onend = () => {
    isListening = false;
    elements.robot.classList.remove("listening");
    elements.btnTalk.setAttribute("aria-pressed", "false");
    elements.btnTalk.querySelector(".btn-label").textContent = "按住說話";

    const text = finalText.trim() || elements.transcript.textContent.trim();
    if (text && text !== "…" && !isProcessing) {
      handleTranscript(text);
    } else if (!isProcessing) {
      setStatus("準備就緒");
    }
  };

  return rec;
}

function startListening() {
  if (!showSettingsIfNeeded() || isProcessing || isListening) return;

  if (!recognition) recognition = createSpeechRecognition();
  if (!recognition) return;

  try {
    recognition.start();
  } catch {
    /* 已在執行 */
  }
}

function stopListening() {
  if (recognition && isListening) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
}

function bindTalkButton() {
  const start = (e) => {
    e.preventDefault();
    startListening();
  };
  const stop = (e) => {
    e.preventDefault();
    stopListening();
  };

  elements.btnTalk.addEventListener("mousedown", start);
  elements.btnTalk.addEventListener("mouseup", stop);
  elements.btnTalk.addEventListener("mouseleave", stop);

  elements.btnTalk.addEventListener("touchstart", start, { passive: false });
  elements.btnTalk.addEventListener("touchend", stop);
  elements.btnTalk.addEventListener("touchcancel", stop);
}

function init() {
  measureArena();
  resetToCenter();
  window.addEventListener("resize", () => {
    measureArena();
    applyRobotPosition();
  });

  elements.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = elements.apiKeyInput.value.trim();
    const mode =
      elements.settingsForm.querySelector('input[name="parseMode"]:checked')
        ?.value || "auto";
    if (mode !== "local" && !key) {
      setStatus("請輸入 API Key，或改選「僅本機規則」");
      return;
    }
    saveSettings(key, mode);
    elements.settingsDialog.close();
    const hint =
      mode === "local"
        ? "已使用本機規則（不呼叫 API）"
        : "設定已儲存，請按住按鈕說話";
    setStatus(hint);
  });

  elements.btnOpenSettings?.addEventListener("click", openSettings);
  elements.btnOpenSettingsMain?.addEventListener("click", openSettings);

  elements.btnCenter.addEventListener("click", () => {
    resetToCenter();
    setStatus("已回到畫面中央");
    setIntent(ACTION_LABELS.center);
  });

  bindTalkButton();

  syncSettingsForm();

  if (getParseMode() === "local") {
    setStatus("本機規則模式，請按住麥克風按鈕說話（不需 API）");
  } else if (!getApiKey()) {
    openSettings();
  } else {
    setStatus("準備就緒，請按住麥克風按鈕說話");
  }
}

init();
