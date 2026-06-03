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
    }
  ]
};
