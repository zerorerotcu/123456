const STORAGE_KEY = "gemini_api_key";
const STEP_PX = 56;
const GEMINI_MODEL = "gemini-2.0-flash";

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
let recognition = null;
let isListening = false;
let isProcessing = false;

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

function showSettingsIfNeeded() {
  if (!getApiKey()) {
    elements.settingsDialog.showModal();
    return false;
  }
  return true;
}

function saveApiKey(key) {
  apiKey = key.trim();
  localStorage.setItem(STORAGE_KEY, apiKey);
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(userText) }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API 錯誤 (${res.status})：${errText.slice(0, 200)}`);
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
    return { action: "none", reason: parsed.reason || "無法辨識動作" };
  }

  return {
    action,
    reason: parsed.reason || ACTION_LABELS[action],
  };
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
  setStatus("AI 正在理解語意…");
  setIntent("分析中…");

  try {
    const { action, reason } = await parseIntentWithGemini(trimmed);
    const label = ACTION_LABELS[action] || action;
    setIntent(`${label} — ${reason}`);

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
    if (!key) return;
    saveApiKey(key);
    elements.settingsDialog.close();
    setStatus("API Key 已儲存，請按住按鈕說話");
  });

  elements.btnCenter.addEventListener("click", () => {
    resetToCenter();
    setStatus("已回到畫面中央");
    setIntent(ACTION_LABELS.center);
  });

  bindTalkButton();

  if (!getApiKey()) {
    elements.settingsDialog.showModal();
  } else {
    setStatus("準備就緒，請按住麥克風按鈕說話");
  }
}

init();
