// ai-handler.js
const OpenAI = require("openai");

class AIHandler {
  constructor(config) {
    this.config = config;
    this.client = new OpenAI({ apiKey: config.openai.apiKey });
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

    history.push({ role: "user", content: userMessage });

    const maxLen = this.config.openai.maxHistoryLength;
    while (history.length > maxLen) {
      history.shift();
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.openai.model,
        max_tokens: this.config.openai.maxTokens,
        messages: [
          { role: "system", content: this.config.ai.systemPrompt },
          ...history,
        ],
      });

      const assistantMessage = response.choices[0].message.content;
      history.push({ role: "assistant", content: assistantMessage });
      return assistantMessage;

    } catch (error) {
      history.pop();
      console.error(`[AIHandler] API error for user ${userId}:`, error.message);
      throw error;
    }
  }
}

module.exports = AIHandler;