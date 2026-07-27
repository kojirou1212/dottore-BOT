// twitter-handler.js
const { TwitterApi } = require("twitter-api-v2");

class TwitterHandler {
  constructor(config) {
    this.config = config;
    const client = new TwitterApi({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accessToken: config.accessToken,
      accessSecret: config.accessSecret,
    });
    this.client = client.readWrite;
    this.userId = null;
  }

  // 429（レート制限）用リトライ付きAPI呼び出し
  async _callWithRetry(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isRateLimit = err.code === 429 || !!err.rateLimit;
        if (!isRateLimit || attempt === maxRetries) break;

        const resetMs = err.rateLimit?.reset ? err.rateLimit.reset * 1000 - Date.now() : 0;
        const waitMs = Math.max(resetMs, (2 ** attempt) * 1000) + Math.random() * 500;
        console.warn(`[TwitterHandler] レート制限。リトライ ${attempt + 1}/${maxRetries} (${Math.round(waitMs)}ms後)`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError;
  }

  async getUserId() {
    if (this.userId) return this.userId;
    const me = await this._callWithRetry(() => this.client.v2.me());
    this.userId = me.data.id;
    return this.userId;
  }

  truncate(text) {
    const max = this.config.maxTweetLength || 280;
    const trimmed = (text || "").trim();
    if (trimmed.length <= max) return trimmed;
    return trimmed.slice(0, max - 1).trimEnd() + "…";
  }

  async postTweet(text) {
    const body = this.truncate(text);
    const res = await this._callWithRetry(() => this.client.v2.tweet(body));
    console.log(`[TwitterHandler] 投稿完了: ${res.data.id}`);
    return res.data;
  }

  async replyTweet(text, inReplyToTweetId) {
    const body = this.truncate(text);
    const res = await this._callWithRetry(() =>
      this.client.v2.tweet(body, { reply: { in_reply_to_tweet_id: inReplyToTweetId } })
    );
    console.log(`[TwitterHandler] リプライ完了: ${res.data.id} -> ${inReplyToTweetId}`);
    return res.data;
  }

  // 自分宛てのメンションを取得（sinceId以降のみ・差分取得でread課金を最小化）
  async getMentions(sinceId) {
    const userId = await this.getUserId();
    const params = {
      max_results: 20,
      "tweet.fields": ["author_id", "created_at", "conversation_id"],
    };
    if (sinceId) params.since_id = sinceId;

    const res = await this._callWithRetry(() => this.client.v2.userMentionTimeline(userId, params));
    return res.tweets ?? [];
  }
}

module.exports = TwitterHandler;
