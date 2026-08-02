module.exports = {
  apps: [
    {
      name: "dottore-server-a",
      script: "bot.js",
      env: {
        CONFIG_PATH: "config.json",
        VC_STATE_FILE: "vc-state-a.json"
      },
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: "dottore-server-b",
      script: "bot.js",
      env: {
        CONFIG_PATH: "config-b.json",
        VC_STATE_FILE: "vc-state-b.json"
      },
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: "dottore-twitter",
      script: "twitter-bot.js",
      env: {
        CONFIG_PATH: "twitter-config.json"
      },
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: "pantalone-server",
      script: "bot.js",
      env: {
        CONFIG_PATH: "config-pantalone.json",
        BOT_MODE: "text",
        VC_STATE_FILE: "vc-state-pantalone.json",
        PROFILES_FILE: "user-profiles-pantalone.json",
        MEMORIES_FILE: "user-memories-pantalone.json",
        KB_FILE: "knowledge-base-pantalone.json",
        MESSAGES_FILE: "messages-pantalone.json",
        USER_HINTS_FILE: "user-hints-pantalone.json"
      },
      restart_delay: 5000,
      max_restarts: 10
    }
  ]
};
