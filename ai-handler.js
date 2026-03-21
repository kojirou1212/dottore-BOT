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

  // 履歴が user/model 交互になっているか検証・修復する
  sanitizeHistory(history) {
    // 先頭が model なら user が来るまで削除
    while (history.length > 0 && history[0].role !== "user") {
      history.shift();
    }
    // user/model が交互になっているか確認し、連続している箇所は後ろを削除
    let i = 0;
    while (i < history.length - 1) {
      if (history[i].role === history[i + 1].role) {
        history.splice(i + 1, 1); // 同じroleが連続していたら後ろを削除
      } else {
        i++;
      }
    }
    // 末尾が model で終わっている場合はそのまま（次のuserメッセージを追加するため問題なし）
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

    try {
      // 最後のuserメッセージはsendMessageで送るため、historyからは除く
      const chatHistory = history.slice(0, -1);

      const chat = this.ai.chats.create({
        model: this.config.gemini.model,
        config: {
          systemInstruction: this.config.ai.systemPrompt,
          maxOutputTokens: this.config.gemini.maxTokens,
        },
        history: chatHistory,
      });

      const response = await chat.sendMessage({ message: userMessage });

      const assistantMessage = response.text;
      history.push({ role: "model", parts: [{ text: assistantMessage }] });
      return assistantMessage;

    } catch (error) {
      // 追加した user メッセージだけを取り消す
      if (history.length > 0 && history[history.length - 1].role === "user") {
        history.pop();
      }
      console.error(`[AIHandler] API error for user ${userId}:`, error.message);
      throw error;
    }
  }
}

module.exports = AIHandler;