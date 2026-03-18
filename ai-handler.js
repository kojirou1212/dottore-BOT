// ai-handler.js
const { GoogleGenAI } = require("@google/genai");

class AIHandler {
  constructor(config) {
    this.config = config;
    this.client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
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

    // Gemini形式: role は "user" / "model"
    history.push({ role: "user", parts: [{ text: userMessage }] });

    const maxLen = this.config.gemini.maxHistoryLength;
    while (history.length > maxLen) {
      history.shift();
    }

    try {
      // 最後のユーザーメッセージを除いた部分をhistoryとして渡す
      const chatHistory = history.slice(0, -1);

      const chat = this.client.chats.create({
        model: this.config.gemini.model,
        config: {
          systemInstruction: this.config.ai.systemPrompt,
          maxOutputTokens: this.config.gemini.maxTokens,
        },
        history: chatHistory,
      });

      const response = await chat.sendMessage({
        message: userMessage,
      });

      const assistantMessage = response.text;
      history.push({ role: "model", parts: [{ text: assistantMessage }] });
      return assistantMessage;

    } catch (error) {
      history.pop();
      console.error(`[AIHandler] API error for user ${userId}:`, error.message);
      throw error;
    }
  }
}

module.exports = AIHandler;