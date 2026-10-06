// pm2 process file for the ECS VM. Secrets are NOT here: they live in /etc/bide/worker.env (chmod 600),
// parsed below at start (pm2 7 ignores `env_file`). Values are never logged.
const fs = require("node:fs");
const ENV_FILE = process.env.BIDE_ENV_FILE || "/etc/bide/worker.env";
const fileEnv = {};
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
module.exports = {
  apps: [
    {
      name: "bide-worker",
      cwd: __dirname,
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      interpreter: "none",
      // HOST may be set in the env file (e.g. the Docker bridge IP so only the reverse proxy can reach it).
      env: { ...fileEnv, NODE_ENV: "production", HOST: fileEnv.HOST || "127.0.0.1", PORT: fileEnv.PORT || "8787", LOG_LEVEL: "info" },
      autorestart: true,
      max_restarts: 1_000_000, // effectively never give up; exp backoff below spaces out a crash loop
      min_uptime: "20s",
      restart_delay: 3000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "1G",
      kill_timeout: 5000,
      time: true,
      out_file: "/var/log/bide/worker.out.log",
      error_file: "/var/log/bide/worker.err.log",
      merge_logs: true,
    },
  ],
};
