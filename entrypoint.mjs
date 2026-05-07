#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, chmodSync, chownSync, rmSync, mkdirSync } from "node:fs";

const uid = process.env.HOST_UID || "1000";
const gid = process.env.HOST_GID || "1000";
const tmuxSocket = process.env.CONTAINER_PI_TMUX_SOCKET || "/tmp/container-pi.tmux";
const tmuxSession = process.env.CONTAINER_PI_TMUX_SESSION || "pi";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function output(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

if (!output("getent", ["group", gid])) run("groupadd", ["-g", gid, "pi"]);
if (!output("getent", ["passwd", uid])) run("useradd", ["-m", "-u", uid, "-g", gid, "-s", "/bin/bash", "pi"]);

const passwd = output("getent", ["passwd", uid]);
const [userName,,,,, userHome] = passwd.split(":");
process.env.HOME = userHome;

for (const dir of [".pi", ".agents", ".codex", ".claude"]) {
  mkdirSync(`${userHome}/${dir}`, { recursive: true });
}
spawnSync("chown", ["-R", `${uid}:${gid}`, userHome], { stdio: "ignore" });

process.chdir("/workspace");
const command = process.argv.slice(2).length ? process.argv.slice(2) : ["pi"];

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const commandFile = "/tmp/container-pi-command.sh";
writeFileSync(commandFile, `#!/usr/bin/env bash\nset -euo pipefail\ncd /workspace\nexec ${command.map(shellQuote).join(" ")}\n`);
chmodSync(commandFile, 0o755);
try { chownSync(commandFile, Number(uid), Number(gid)); } catch {}
try { rmSync(tmuxSocket, { force: true }); } catch {}

const tmuxCmd = `tmux -S ${shellQuote(tmuxSocket)} new-session -d -s ${shellQuote(tmuxSession)} ${shellQuote(commandFile)} && tail -f /dev/null`;
const child = spawn("gosu", [userName, "bash", "-lc", tmuxCmd], { stdio: "inherit", env: process.env });
child.on("exit", code => process.exit(code ?? 0));
