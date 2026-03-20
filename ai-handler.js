// ai-handler.js
const Anthropic = require("@anthropic-ai/sdk");

class AIHandler {
  constructor(config) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
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

    const maxLen = this.config.anthropic.maxHistoryLength;
    while (history.length > maxLen) {
      history.shift();
    }

    try {
      const response = await this.client.messages.create({
        model: this.config.anthropic.model,
        max_tokens: this.config.anthropic.maxTokens,
        system: this.config.ai.systemPrompt,
        messages: history,
      });

      const assistantMessage = response.content[0].text;
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