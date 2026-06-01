// --- Constants & Config ---
const STORAGE_PARSE_MODE = "parse_mode";
const STEP_PX = 56;
const GEMINI_MODELS = [
  "gemini-3.5-flash",        // 2026年5月最新推出，速度極快、專為 Agent 工作流優化的主力 Flash 模型
  "gemini-3.1-pro-preview",  // 目前最強的高級推理、複雜邏輯與程式碼生成模型
  "gemini-3.1-flash-lite",   // 超輕量、超低延遲且極具成本優化的版本
  "gemini-2.5-pro",          // 2.5 世代的旗艦穩定版
  "gemini-2.5-flash",        // 2.5 世代的通用效能平衡版
];

const ACTION_LABELS = {
  forward: "往前",
  backward: "往後",
  left: "往左",
  right: "往右",
  center: "回到中央",
  none: "不移動",
};

// --- DOM Elements ---
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
  btnOpenSettingsMain: document.getElementById("btnOpenSettingsMain"),
  manualInput: document.getElementById("manualInput"),
  btnManualSend: document.getElementById("btnManualSend"),
  coordinateBadge: document.getElementById("coordinateBadge"),
  voiceWave: document.getElementById("voiceWave"),
  globalStatusIndicator: document.getElementById("globalStatusIndicator"),
  apiKeyGroup: document.getElementById("apiKeyGroup"),
};

// --- State Machine ---
const state = {
  x: 0, // grid coordinate
  y: 0, // grid coordinate
  centerX: 0,
  centerY: 0,
  maxX: 0,
  maxY: 0,
};

let apiKey = "";
let parseMode = localStorage.getItem(STORAGE_PARSE_MODE) || "auto";
let recognition = null;
let isListening = false;
let isProcessing = false;
let stopRequested = false;

// --- Local Parsing Logic (Fallback / Local Mode) ---
const DIRECTION_RULES = [
  { action: "forward", pattern: /往前|向前|前進|前走|前移|朝前/g },
  { action: "backward", pattern: /往後|向後|後退|後走|後移|朝後/g },
  { action: "left", pattern: /往左|向左|左移|左走|朝左|左轉/g },
  { action: "right", pattern: /往右|向右|右移|右走|朝右|右轉/g },
];

const CENTER_PATTERN = /回(到)?中央|回(到)?中間|歸位|回原點|回家|置中/;
const CLAUSE_SPLIT = /[，。；、]|但是|但|不過|然而|所以|因此|那就|請你?|麻煩/;
const NEGATION_BEFORE = /(不要|別|勿|沒有?|不能|不可|不會|不願|不想|非)\s*$/;

/**
 * Parses user text using rules.
 * Handles conjunctions (like "但是", "但") and negations (like "不要往前").
 * @param {string} userText 
 * @returns {{ action: string, reason: string, source: string }}
 */
function parseIntentLocally(userText) {
  const text = userText.replace(/\s+/g, "");

  // 1. Check for center command
  if (CENTER_PATTERN.test(text)) {
    const idx = text.search(CENTER_PATTERN);
    const before = text.slice(Math.max(0, idx - 6), idx);
    if (!NEGATION_BEFORE.test(before)) {
      return { action: "center", reason: "偵測到回到中央的指令", source: "local" };
    }
  }

  // 2. Split clauses to analyze structure (e.g. "but" / "however" transitions)
  const clauses = text.split(CLAUSE_SPLIT).filter(Boolean);
  const segments = clauses.length ? clauses : [text];

  const mentions = [];

  segments.forEach((clause, clauseIndex) => {
    for (const { action, pattern } of DIRECTION_RULES) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = re.exec(clause)) !== null) {
        const at = match.index;
        const before = clause.slice(Math.max(0, at - 6), at);
        
        let negated = NEGATION_BEFORE.test(before);
        // Special double check (e.g. "不會往右走")
        if (/不會\s*$/.test(before) || /不會.*走/.test(before + match[0])) {
          negated = true;
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

  // Filter out negated commands
  const affirmative = mentions.filter(m => !m.negated);

  if (!affirmative.length) {
    return { action: "none", reason: "僅偵測到否定或未匹配到方向", source: "local" };
  }

  // Find mentions in the latest clause (usually last instruction has priority)
  const maxClauseIndex = Math.max(...affirmative.map(m => m.clauseIndex));
  const inLatestClause = affirmative.filter(m => m.clauseIndex === maxClauseIndex);

  // Pick the first affirmative direction in the latest active clause
  const chosen = inLatestClause[0] || affirmative[0];

  return {
    action: chosen.action,
    reason: `本地規則辨識為「${ACTION_LABELS[chosen.action]}」`,
    source: "local",
  };
}

// --- Gemini API Logic ---
function buildGeminiPrompt(userText) {
  return `你是語意指令解析器。使用者用中文控制畫面上的機器人移動。

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
  const key = apiKey.trim();
  if (!key) throw new Error("尚未設定 Gemini API Key");

  const body = {
    contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(userText) }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
    },
  };

  let errorDetails = null;

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        errorDetails = { status: res.status, text };
        continue; // Try next model
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("AI 回傳格式有誤");
        parsed = JSON.parse(match[0]);
      }

      const action = String(parsed.action || "none").toLowerCase();
      const valid = ["forward", "backward", "left", "right", "center", "none"];
      
      if (!valid.includes(action)) {
        return { action: "none", reason: parsed.reason || "無法辨識指令", source: `gemini:${model}` };
      }

      return {
        action,
        reason: parsed.reason || ACTION_LABELS[action],
        source: `gemini:${model}`,
      };
    } catch (err) {
      errorDetails = { status: 0, text: err.message };
    }
  }

  // If all models failed
  const err = new Error(
    errorDetails?.status === 429
      ? "Gemini API 配額已用盡 (429)"
      : `Gemini API 呼叫失敗: ${errorDetails?.text || "未知錯誤"}`
  );
  err.quotaExceeded = errorDetails?.status === 429;
  throw err;
}

async function parseIntent(userText) {
  if (parseMode === "local") {
    return parseIntentLocally(userText);
  }

  if (parseMode === "gemini") {
    return await parseIntentWithGemini(userText);
  }

  // Auto Mode: Try Gemini first, fallback to local if quota exceeded or offline
  if (!apiKey.trim()) {
    const localRes = parseIntentLocally(userText);
    localRes.reason = `${localRes.reason} (未輸入 API Key，自動切換至本地模式)`;
    return localRes;
  }

  try {
    return await parseIntentWithGemini(userText);
  } catch (err) {
    console.warn("Gemini parsing failed, falling back to local:", err);
    const localRes = parseIntentLocally(userText);
    localRes.reason = `${localRes.reason} (${err.quotaExceeded ? "API 配額用盡" : "API 錯誤"}，自動改用本地模式)`;
    return localRes;
  }
}

// --- Movement & Arena Math ---
function measureArena() {
  const rect = elements.arena.getBoundingClientRect();
  const robotRect = elements.robot.getBoundingClientRect();
  const halfRobot = robotRect.width / 2;
  
  state.centerX = rect.width / 2;
  state.centerY = rect.height / 2;
  state.maxX = Math.floor((rect.width / 2 - halfRobot - 8) / STEP_PX);
  state.maxY = Math.floor((rect.height / 2 - halfRobot - 8) / STEP_PX);
}

function updateCoordinateDisplay() {
  elements.coordinateBadge.textContent = `(${state.x}, ${-state.y})`;
}

function applyRobotPosition(stateClass = "") {
  const left = state.centerX + state.x * STEP_PX;
  const top = state.centerY + state.y * STEP_PX;
  
  elements.robot.style.left = `${left}px`;
  elements.robot.style.top = `${top}px`;
  
  updateCoordinateDisplay();

  // Reset classes
  elements.robot.className = "robot";
  if (stateClass) {
    elements.robot.classList.add(stateClass);
  }
}

function resetToCenter() {
  state.x = 0;
  state.y = 0;
  applyRobotPosition();
}

function moveByAction(action) {
  measureArena();
  let animationClass = "";

  switch (action) {
    case "forward":
      if (state.y > -state.maxY) {
        state.y -= 1;
      }
      break;
    case "backward":
      if (state.y < state.maxY) {
        state.y += 1;
      }
      break;
    case "left":
      if (state.x > -state.maxX) {
        state.x -= 1;
      }
      break;
    case "right":
      if (state.x < state.maxX) {
        state.x += 1;
      }
      break;
    case "center":
      resetToCenter();
      return;
    case "none":
    default:
      return;
  }

  applyRobotPosition();
}

// --- Status Updates ---
function updateIndicator(status) {
  elements.globalStatusIndicator.className = `pulse-indicator ${status}`;
  
  // Update robot core light state
  elements.robot.classList.remove("listening", "processing", "success", "error");
  if (status === "listening") elements.robot.classList.add("listening");
  if (status === "processing") elements.robot.classList.add("processing");
  if (status === "success") elements.robot.classList.add("success");
  if (status === "error") elements.robot.classList.add("error");
}

function setStatus(text, status = "idle") {
  elements.statusText.textContent = text;
  updateIndicator(status);
}

function setIntent(text, isError = false) {
  elements.intentDisplay.textContent = text;
  elements.intentDisplay.className = `intent-text ${isError ? "error" : ""}`;
}

// --- Speech Recognition Module ---
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus("您的瀏覽器不支援 Web Speech API，請使用 Chrome/Edge", "error");
    elements.btnTalk.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "zh-TW";
  recognition.interimResults = true;
  recognition.continuous = false; // Only active when button triggered to prevent constant loops

  let speechResult = "";
  let hadError = false;

  recognition.onstart = () => {
    isListening = true;
    stopRequested = false;
    speechResult = "";
    hadError = false;
    elements.voiceWave.classList.add("active");
    elements.btnTalk.classList.add("is-listening");
    elements.btnTalk.querySelector(".btn-label").textContent = "點擊結束並送出";
    setStatus("正在聆聽語令，請說話...", "listening");
  };

  recognition.onresult = (event) => {
    const resultText = Array.from(event.results)
      .map(res => res[0].transcript)
      .join("");
    speechResult = resultText;
    elements.transcript.textContent = resultText;
  };

  recognition.onerror = (event) => {
    hadError = true;
    if (event.error === "no-speech") {
      setStatus("未偵測到聲音，請再試一次", "error");
    } else if (event.error === "not-allowed") {
      setStatus("麥克風存取被拒絕，請允許麥克風權限", "error");
    } else {
      setStatus(`語音辨識錯誤: ${event.error}`, "error");
    }
    console.error("SpeechRecognition error:", event.error);
  };

  recognition.onend = () => {
    isListening = false;
    elements.voiceWave.classList.remove("active");
    elements.btnTalk.classList.remove("is-listening");
    elements.btnTalk.querySelector(".btn-label").textContent = "點擊開始說話";

    const text = speechResult.trim();
    if (text) {
      handleCommand(text);
    } else {
      if (!hadError) {
        setStatus("這次沒聽到內容。請再點麥克風，或直接打字送出", "idle");
      }
    }
  };
}

async function handleCommand(text) {
  if (isProcessing) return;
  isProcessing = true;
  setStatus("AI 語意分析中...", "processing");
  setIntent("分析中...");

  try {
    const { action, reason, source } = await parseIntent(text);
    const label = ACTION_LABELS[action] || action;
    const from = source.startsWith("gemini") ? "Gemini AI" : "本地解析";
    
    setIntent(`${label} — ${reason} (${from})`);
    
    if (action === "none") {
      setStatus("語令解析完成，不需移動", "success");
    } else {
      moveByAction(action);
      setStatus(`成功執行指令: ${label}`, "success");
    }
  } catch (err) {
    console.error("Failed to process command:", err);
    setStatus("解析失敗，請檢查網路或金鑰", "error");
    setIntent(err.message, true);
  } finally {
    isProcessing = false;
  }
}

function startListening() {
  if (isListening || isProcessing) return;
  
  if (parseMode !== "local" && !apiKey.trim()) {
    openSettings();
    setStatus("請先輸入 Gemini API Key 或選用純本地模式", "error");
    return;
  }

  elements.transcript.textContent = "聆聽中...";
  try {
    recognition.start();
  } catch (err) {
    console.error("Failed to start recognition:", err);
    isListening = false;
    setStatus("麥克風啟動失敗，請重新點擊", "error");
  }
}

function stopListening() {
  if (!isListening) return;
  stopRequested = true;
  recognition.stop();
}

function toggleListening() {
  if (isListening) {
    stopListening();
  } else {
    startListening();
  }
}

// --- Settings Dialog ---
function openSettings() {
  elements.apiKeyInput.value = apiKey;
  const radio = elements.settingsForm.querySelector(`input[name="parseMode"][value="${parseMode}"]`);
  if (radio) radio.checked = true;
  toggleApiKeyField(parseMode);
  elements.settingsDialog.showModal();
}

function toggleApiKeyField(mode) {
  if (mode === "local") {
    elements.apiKeyGroup.style.display = "none";
  } else {
    elements.apiKeyGroup.style.display = "flex";
  }
}

// --- Initialization ---
function init() {
  measureArena();
  resetToCenter();

  window.addEventListener("resize", () => {
    measureArena();
    applyRobotPosition();
  });

  // Settings Events
  elements.btnOpenSettingsMain.addEventListener("click", openSettings);
  
  elements.settingsForm.querySelector(".radio-group").addEventListener("change", (e) => {
    toggleApiKeyField(e.target.value);
  });

  elements.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = elements.settingsForm.querySelector('input[name="parseMode"]:checked').value;
    const key = elements.apiKeyInput.value.trim();

    if (mode !== "local" && !key) {
      alert("請輸入 Gemini API Key，或切換為純本地解析。");
      return;
    }

    apiKey = key;
    parseMode = mode;
    localStorage.setItem(STORAGE_PARSE_MODE, parseMode);
    elements.settingsDialog.close();
    setStatus(`設定已套用 (${mode === "local" ? "純本地" : "Gemini"})`, "idle");
  });

  // Talk Button
  elements.btnTalk.addEventListener("click", toggleListening);

  // Center Button
  elements.btnCenter.addEventListener("click", () => {
    resetToCenter();
    setStatus("機器人已回到畫面中央", "idle");
    setIntent("回到中央");
  });

  // Manual Command
  const sendManual = () => {
    const text = elements.manualInput.value.trim();
    if (!text) return;
    elements.transcript.textContent = text;
    elements.manualInput.value = "";
    handleCommand(text);
  };

  elements.btnManualSend.addEventListener("click", sendManual);
  elements.manualInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendManual();
    }
  });

  setupSpeechRecognition();
  
  // Prompt settings modal on startup
  setTimeout(openSettings, 400);
}

init();
