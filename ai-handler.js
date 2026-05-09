// ai-handler.js
class AIHandler {
  constructor(config) {
    this.config = config;
    this.conversationHistory = new Map();
  }

  getHistory(userId) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    return this.conversationHistory.get(userId);
  }

  clearHistory(userId) {
    this.conversationHistory.delete(userId);
  }

  clearAllHistory() {
    const count = this.conversationHistory.size;
    this.conversationHistory.clear();
    console.log(`[AIHandler] 全ユーザーの会話履歴をクリア (${count}件)`);
    return count;
  }

  // 履歴が user/model 交互・各エントリが有効かを検証・修復する
  sanitizeHistory(history) {
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (
        !entry.parts ||
        !Array.isArray(entry.parts) ||
        entry.parts.length === 0 ||
        !entry.parts[0].text ||
        entry.parts[0].text.trim() === ""
      ) {
        history.splice(i, 1);
      }
    }
    while (history.length > 0 && history[0].role !== "user") {
      history.shift();
    }
    let i = 0;
    while (i < history.length - 1) {
      if (history[i].role === history[i + 1].role) {
        history.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }

  // 503など一時的エラー用リトライ付きAPI呼び出し
  async _callWithRetry(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const msg = err.message || "";
        const isRetryable =
          msg.includes("503") ||
          msg.includes("UNAVAILABLE") ||
          msg.includes("high demand") ||
          msg.includes("429") ||
          msg.includes("Resource has been exhausted");

        if (!isRetryable || attempt === maxRetries) break;

        const waitMs = (2 ** attempt) * 1000 + Math.random() * 500;
        console.warn(`[AIHandler] リトライ ${attempt + 1}/${maxRetries} (${Math.round(waitMs)}ms後): ${msg.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError;
  }

  async generateResponse(userId, userMessage) {
    const history = this.getHistory(userId);

    while (history.length > 0 && history[history.length - 1].role === "user") {
      history.pop();
    }

    history.push({ role: "user", parts: [{ text: userMessage }] });

    const maxLen = this.config.gemini.maxHistoryLength;
    while (history.length > maxLen) {
      history.shift();
    }

    this.sanitizeHistory(history);

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const systemPromptWithTime = `${this.config.ai.systemPrompt}\n\n現在の日時：${now}`;
    const chatHistory = history.slice(0, -1);
    const apiKey = this.config.gemini.apiKey;

    const callGemini = async (model) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPromptWithTime }] },
            contents: [...chatHistory, { role: "user", parts: [{ text: userMessage }] }],
            generationConfig: {
              maxOutputTokens: this.config.gemini.maxTokens,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const data = await res.json();
      if (data.error) {
        const code = data.error.code;
        const msg = data.error.message ?? "";
        if (code === 503 || msg.includes("high demand") || msg.includes("UNAVAILABLE")) {
          throw new Error(`503: ${msg}`);
        }
        throw new Error(`API error ${code}: ${msg}`);
      }

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      // thought パーツ（thinking mode）を除いた最初のテキストパーツを取得
      const textPart = parts.find((p) => !p.thought && typeof p.text === "string");
      const text = textPart?.text?.trim();

      if (!text) {
        const finishReason = candidate?.finishReason ?? "UNKNOWN";
        console.warn(`[AIHandler] 空応答 finishReason=${finishReason} parts=${JSON.stringify(parts.map(p => ({ thought: !!p.thought, textLen: p.text?.length ?? 0 })))}`);
        if (finishReason === "SAFETY") return "……(その話題には応答できない)";
        if (finishReason === "RECITATION") return "……(著作権の都合で応答できない)";
        throw new Error(`AIからの応答が空でした。(finishReason=${finishReason})`);
      }

      return text;
    };

    try {
      let assistantMessage;

      try {
        assistantMessage = await this._callWithRetry(() => callGemini(this.config.gemini.model));
      } catch (primaryErr) {
        const msg = primaryErr.message || "";
        const isUnavailable = msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand");
        const fallbackModel = this.config.gemini.fallbackModel;

        if (isUnavailable && fallbackModel) {
          console.warn(`[AIHandler] プライマリモデル失敗。フォールバック: ${fallbackModel}`);
          assistantMessage = await this._callWithRetry(() => callGemini(fallbackModel));
        } else {
          throw primaryErr;
        }
      }

      history.push({ role: "model", parts: [{ text: assistantMessage }] });
      return assistantMessage;

    } catch (error) {
      if (history.length > 0 && history[history.length - 1].role === "user") {
        history.pop();
      }
      console.error(`[AIHandler] API error for user ${userId}:`, error.message);
      throw error;
    }
  }
}

module.exports = AIHandler;
