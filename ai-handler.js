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

  // 履歴が user/assistant 交互・各エントリが有効かを検証・修復する
  sanitizeHistory(history) {
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (!entry.content || typeof entry.content !== "string" || entry.content.trim() === "") {
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

  // 503/429など一時的エラー用リトライ付きAPI呼び出し
  async _callWithRetry(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const msg = err.message || "";
        const is503 = msg.includes("503") || msg.includes("UNAVAILABLE");
        if (is503) break;
        const isRetryable =
          msg.includes("high demand") ||
          msg.includes("429") ||
          msg.includes("rate_limit") ||
          msg.includes("Resource has been exhausted");

        if (!isRetryable || attempt === maxRetries) break;

        const waitMs = (2 ** attempt) * 1000 + Math.random() * 500;
        console.warn(`[AIHandler] リトライ ${attempt + 1}/${maxRetries} (${Math.round(waitMs)}ms後): ${msg.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError;
  }

  async generateResponse(userId, userMessage, { systemHint } = {}) {
    const history = this.getHistory(userId);

    while (history.length > 0 && history[history.length - 1].role === "user") {
      history.pop();
    }

    history.push({ role: "user", content: userMessage });

    const maxLen = this.config.grok.maxHistoryLength;
    while (history.length > maxLen) {
      history.shift();
    }

    this.sanitizeHistory(history);

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const systemContent = `${this.config.ai.systemPrompt}\n\n現在の日時：${now}${systemHint ? `\n\n${systemHint}` : ""}`;
    const apiKey = this.config.grok.apiKey;
    const url = "https://api.x.ai/v1/chat/completions";
    const chatHistory = history.slice(0, -1);

    const callGrok = async (model, isRetry = false) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemContent },
              ...chatHistory,
              { role: "user", content: userMessage },
            ],
            max_tokens: this.config.grok.maxTokens,
          }),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const data = await res.json();
      if (!res.ok) {
        const msg = data.error?.message ?? res.statusText;
        const code = res.status;
        if (code === 503 || code === 429) throw new Error(`${code}: ${msg}`);
        throw new Error(`API error ${code}: ${msg}`);
      }

      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        const finishReason = data.choices?.[0]?.finish_reason ?? "UNKNOWN";
        console.warn(`[AIHandler] 空応答 finish_reason=${finishReason}`);
        if (finishReason === "content_filter") return "……(その話題には応答できない)";
        if (!isRetry) {
          console.warn("[AIHandler] 空応答のため1回だけ聞き直す");
          return callGrok(model, true);
        }
        throw new Error(`AIからの応答が空でした。(finish_reason=${finishReason})`);
      }

      return text;
    };

    try {
      let assistantMessage;

      try {
        assistantMessage = await this._callWithRetry(() => callGrok(this.config.grok.model));
      } catch (primaryErr) {
        const msg = primaryErr.message || "";
        const isUnavailable =
          msg.includes("503") ||
          msg.includes("UNAVAILABLE") ||
          msg.includes("429") ||
          msg.includes("rate_limit");
        const fallbackModel = this.config.grok.fallbackModel;

        if (isUnavailable && fallbackModel) {
          console.warn(`[AIHandler] プライマリモデル失敗。フォールバック: ${fallbackModel}`);
          assistantMessage = await this._callWithRetry(() => callGrok(fallbackModel));
        } else {
          throw primaryErr;
        }
      }

      history.push({ role: "assistant", content: assistantMessage });
      return assistantMessage;

    } catch (error) {
      if (history.length > 0 && history[history.length - 1].role === "user") {
        history.pop();
      }
      console.error(`[AIHandler] API error for user ${userId}:`, error.message);
      throw error;
    }
  }

  // 履歴なし・低トークンの単発呼び出し（観察メモ生成用）
  async generateSimple(prompt, maxTokens = 150) {
    const model = this.config.grok.fallbackModel || this.config.grok.model;
    const apiKey = this.config.grok.apiKey;
    const url = "https://api.x.ai/v1/chat/completions";

    return this._callWithRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
          }),
        });
      } finally {
        clearTimeout(timeoutId);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(`API error ${res.status}: ${data.error?.message ?? res.statusText}`);
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("空応答");
      return text;
    }, 1);
  }
}

module.exports = AIHandler;
