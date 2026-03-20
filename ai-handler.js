// ai-handler.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

class AIHandler {
  constructor(config) {
    this.config = config;
    this.client = new GoogleGenerativeAI(config.gemini.apiKey);
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

  async generateResponse(userId, userMessage) {
    const history = this.getHistory(userId);

    const maxLen = this.config.gemini.maxHistoryLength;
    while (history.length >= maxLen) {
      history.shift();
    }

    try {
      const model = this.client.getGenerativeModel({
        model: this.config.gemini.model,
        systemInstruction: this.config.ai.systemPrompt,
      });

      const chat = model.startChat({
        history: history,
      });

      const result = await chat.sendMessage(userMessage);
      const assistantMessage = result.response.text();

      // 履歴に追加
      history.push({ role: "user", parts: [{ text: userMessage }] });
      history.push({ role: "model", parts: [{ text: assistantMessage }] });

      return assistantMessage;

    } catch (error) {
      console.error(`[AIHandler] API error for user ${userId}:`, error.message);
      throw error;
    }
  }
}

module.exports = AIHandler;