// ai-handler.js
const { GoogleGenAI } = require("@google/genai");

class AIHandler {
  constructor(config) {
    this.config = config;
    this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
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

    try {
      const chatHistory = history.slice(0, -1);

      const assistantMessage = await this._callWithRetry(async () => {
        const chat = this.ai.chats.create({
          model: this.config.gemini.model,
          config: {
            systemInstruction: systemPromptWithTime,
            maxOutputTokens: this.config.gemini.maxTokens,
            thinkingConfig: { thinkingBudget: 0 }, // 思考モード無効化
          },
          history: chatHistory,
        });

        const response = await chat.sendMessage({ message: userMessage });

        const text = typeof response.text === "function"
          ? response.text()
          : response.text;

        if (!text || text.trim() === "") {
          const candidate = response.candidates?.[0];
          const finishReason = candidate?.finishReason ?? "UNKNOWN";
          console.warn(`[AIHandler] 空応答 finishReason=${finishReason}`);

          if (finishReason === "SAFETY") {
            return "……(その話題には応答できない)";
          }
          if (finishReason === "RECITATION") {
            return "……(著作権の都合で応答できない)";
          }
          throw new Error(`AIからの応答が空でした。(finishReason=${finishReason})`);
        }

        return text;
      });

      history.push({ role: "model", parts: [{ text: assistantMessage }] });
      return assistantMessage;

    } catch (error) {
      if (history.length > 0 && history[history.length - 1].role === "user") {
        history.pop();
      }
      console.error(`[AIHandler] API error for user ${userId}:`, JSON.stringify(error.message));
      throw error;
    }
  }
}

module.exports = AIHandler;