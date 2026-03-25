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

  // 履歴が user/model 交互・各エントリが有効かを検証・修復する
  sanitizeHistory(history) {
    // parts が空または text が空文字のエントリを除去
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
    // 先頭が model なら user が来るまで削除
    while (history.length > 0 && history[0].role !== "user") {
      history.shift();
    }
    // user/model が交互になっているか確認し、連続している箇所は後ろを削除
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

        const waitMs = (2 ** attempt) * 1000 + Math.random() * 500; // 1s, 2s, 4s + jitter
        console.warn(`[AIHandler] リトライ ${attempt + 1}/${maxRetries} (${Math.round(waitMs)}ms後): ${msg.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError;
  }

  async generateResponse(userId, userMessage) {
    const history = this.getHistory(userId);

    // 末尾が user のまま残っていたら（前回エラー時の残骸）削除
    while (history.length > 0 && history[history.length - 1].role === "user") {
      history.pop();
    }

    history.push({ role: "user", parts: [{ text: userMessage }] });

    const maxLen = this.config.gemini.maxHistoryLength;
    while (history.length > maxLen) {
      history.shift();
    }

    // API呼び出し前に履歴を必ず整合性チェック・修復
    this.sanitizeHistory(history);

    // 現在の日時（日本時間）をシステムプロンプトに注入
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const systemPromptWithTime = `${this.config.ai.systemPrompt}\n\n現在の日時：${now}`;

    try {
      // 最後のuserメッセージはsendMessageで送るため historyからは除く
      const chatHistory = history.slice(0, -1);

      const assistantMessage = await this._callWithRetry(async () => {
        const chat = this.ai.chats.create({
          model: this.config.gemini.model,
          config: {
            systemInstruction: systemPromptWithTime,
            maxOutputTokens: this.config.gemini.maxTokens,
          },
          history: chatHistory,
        });

        const response = await chat.sendMessage({ message: userMessage });

        // response.text は関数なので呼び出す
        const text = typeof response.text === "function"
          ? response.text()
          : response.text;

        if (!text || text.trim() === "") {
          throw new Error("AIからの応答が空でした。");
        }

        return text;
      });

      history.push({ role: "model", parts: [{ text: assistantMessage }] });
      return assistantMessage;

    } catch (error) {
      // 追加した user メッセージだけを取り消す
      if (history.length > 0 && history[history.length - 1].role === "user") {
        history.pop();
      }
      console.error(`[AIHandler] API error for user ${userId}:`, JSON.stringify(error.message));
      throw error;
    }
  }
}

module.exports = AIHandler;