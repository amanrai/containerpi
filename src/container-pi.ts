#!/usr/bin/env -S tsx
import blessed from "blessed";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfileDir = here;
const home = os.homedir();
const cwd = process.cwd();
const image = process.env.CONTAINER_PI_IMAGE || "container-pi:latest";
const engine = process.env.CONTAINER_PI_ENGINE || findEngine();
const projectHash = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
const containerName = process.env.CONTAINER_PI_NAME || `container-pi-${projectHash}`;
const tmuxSocket = "/tmp/container-pi.tmux";
const tmuxSession = "pi";

function findEngine(): string {
  for (const candidate of ["docker", "podman"]) {
    const r = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return candidate;
  }
  throw new Error("container-pi requires docker or podman");
}

function run(cmd: string, args: string[], opts: { capture?: boolean; check?: boolean; stdio?: any } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: opts.capture ? "utf8" : undefined,
    stdio: opts.stdio ?? (opts.capture ? "pipe" : "inherit"),
  });
  if ((opts.check ?? true) && res.status !== 0) process.exit(res.status ?? 1);
  return res;
}

function output(cmd: string, args: string[]): string {
  const r = run(cmd, args, { capture: true, check: false });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

function imageExists() {
  return run(engine, ["image", "inspect", image], { check: false, stdio: "ignore" }).status === 0;
}

function containerExists() {
  return run(engine, ["container", "inspect", containerName], { check: false, stdio: "ignore" }).status === 0;
}

function containerRunning() {
  if (!containerExists()) return false;
  return output(engine, ["inspect", "-f", "{{.State.Running}}", containerName]) === "true";
}

function buildImage(noCache = false) {
  const args = ["build", "-t", image];
  if (noCache) args.push("--no-cache");
  args.push(dockerfileDir);
  run(engine, args);
}

function ensureConfigDirs() {
  for (const dir of [".pi", ".agents", ".codex", ".claude"]) {
    mkdirSync(`${home}/${dir}`, { recursive: true });
  }
}

function envArgs(): string[] {
  const names = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
    "GROQ_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY",
    "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "HF_TOKEN", "HUGGINGFACE_API_KEY",
    "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_PROFILE", "PI_OFFLINE", "PI_TELEMETRY",
    "PI_SKIP_VERSION_CHECK", "PI_CACHE_RETENTION"
  ];
  const args: string[] = [];
  for (const name of names) {
    if (process.env[name]) args.push("-e", `${name}=${process.env[name]}`);
  }
  return args;
}

function mountArgs(): string[] {
  const args = [
    "-v", `${resolve(cwd)}:/workspace:rw`,
    "-v", `${home}/.pi:/home/pi/.pi:rw`,
    "-v", `${home}/.agents:/home/pi/.agents:rw`,
    "-v", `${home}/.codex:/home/pi/.codex:rw`,
    "-v", `${home}/.claude:/home/pi/.claude:rw`,
  ];
  if (existsSync(`${home}/.ssh`)) args.push("-v", `${home}/.ssh:/home/pi/.ssh:ro`);
  if (existsSync(`${home}/.gitconfig`)) args.push("-v", `${home}/.gitconfig:/home/pi/.gitconfig:ro`);
  if (existsSync(`${home}/.npm`)) args.push("-v", `${home}/.npm:/home/pi/.npm:rw`);
  return args;
}

function attachContainer(name: string) {
  const exists = run(engine, ["container", "inspect", name], { check: false, stdio: "ignore" }).status === 0;
  if (!exists) {
    console.error(`No such container: ${name}`);
    process.exit(1);
  }
  const running = output(engine, ["inspect", "-f", "{{.State.Running}}", name]) === "true";
  if (!running) run(engine, ["start", name]);
  run(engine, [
    "exec", "-it", name,
    "bash", "-lc",
    `u=$(getent passwd \"$HOST_UID\" | cut -d: -f1); exec gosu \"$u\" tmux -S ${tmuxSocket} attach -t ${tmuxSession}`
  ]);
}

function attach() {
  if (!containerExists()) {
    console.error(`No container for ${resolve(cwd)} (${containerName})`);
    process.exit(1);
  }
  attachContainer(containerName);
}

function shell() {
  if (!containerRunning()) {
    console.error(`No running container for ${resolve(cwd)} (${containerName})`);
    process.exit(1);
  }
  run(engine, [
    "exec", "-it", containerName,
    "bash", "-lc",
    `u=$(getent passwd \"$HOST_UID\" | cut -d: -f1); exec gosu \"$u\" bash -l`
  ]);
}

function start(piArgs: string[]) {
  ensureConfigDirs();
  if (!imageExists()) buildImage(false);

  if (containerRunning()) return attach();
  if (containerExists()) run(engine, ["rm", "-f", containerName]);

  run(engine, [
    "run", "-d",
    "--name", containerName,
    "-e", `HOST_UID=${process.getuid?.() ?? 1000}`,
    "-e", `HOST_GID=${process.getgid?.() ?? 1000}`,
    "-e", "PI_CODING_AGENT_DIR=/home/pi/.pi/agent",
    "-e", `CONTAINER_PI_TMUX_SOCKET=${tmuxSocket}`,
    "-e", `CONTAINER_PI_TMUX_SESSION=${tmuxSession}`,
    ...envArgs(),
    ...mountArgs(),
    "-w", "/workspace",
    image,
    "pi", ...piArgs,
  ]);

  attach();
}

function statusLines() {
  return [
    `engine:    ${engine}`,
    `image:     ${image}`,
    `container: ${containerName}`,
    `project:   ${resolve(cwd)}`,
    `exists:    ${containerExists()}`,
    `running:   ${containerRunning()}`,
  ];
}

function status() {
  console.log(statusLines().join("\n"));
}

function stopContainer() {
  if (containerExists()) run(engine, ["rm", "-f", containerName]);
}

function logs() {
  run(engine, ["logs", "-f", containerName]);
}

type SessionInfo = { name: string; image: string; status: string };

function listSessions(): SessionInfo[] {
  const format = "{{.Names}}\\t{{.Image}}\\t{{.Status}}";
  const r = run(engine, ["ps", "-a", "--filter", "name=container-pi-", "--format", format], { capture: true, check: false });
  const text = r.status === 0 ? String(r.stdout).trim() : "";
  if (!text) return [];
  return text.split("\n").map(line => {
    const [name = "", image = "", status = ""] = line.split("\t");
    return { name, image, status };
  }).filter(s => s.name.startsWith("container-pi-"));
}

function listRunningText() {
  const sessions = listSessions();
  if (!sessions.length) return "No container-pi sessions.";
  return ["NAMES                       IMAGE                 STATUS", ...sessions.map(s => `${s.name.padEnd(27)} ${s.image.padEnd(21)} ${s.status}`)].join("\n");
}

function listRunning() {
  console.log(listRunningText());
}

function tui() {
  const screen = blessed.screen({ smartCSR: true, title: "container-pi" });

  const box = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: "line",
    style: { border: { fg: "gray" } },
  });

  const title = blessed.text({
    parent: box,
    top: 1,
    left: 3,
    content: "container-pi",
    style: { fg: "cyan", bold: true },
  });

  const meta = blessed.text({
    parent: box,
    top: 3,
    left: 3,
    width: "95%",
    height: 7,
    content: statusLines().join("\n"),
    style: { fg: "white" },
  });

  const items = [
    "Start / attach session",
    "Open shell",
    "Stop/remove container",
    "Build image",
    "Rebuild image",
    "Follow logs",
    "Refresh status",
    "Quit",
  ];

  const list = blessed.list({
    parent: box,
    top: 11,
    left: 3,
    width: "50%",
    height: items.length + 2,
    keys: true,
    mouse: true,
    vi: true,
    items,
    border: "line",
    label: " actions ",
    style: {
      border: { fg: "gray" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { fg: "white" },
    },
  });

  const sessionList = blessed.list({
    parent: box,
    top: 11,
    left: "55%",
    width: "42%",
    height: 14,
    keys: true,
    mouse: true,
    vi: true,
    hidden: true,
    border: "line",
    label: " sessions ",
    style: {
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { fg: "white" },
    },
  });

  const help = blessed.text({
    parent: box,
    bottom: 1,
    left: 3,
    content: "↑/↓ or j/k select • enter run • esc back • q quit • tmux detach: Ctrl-b d",
    style: { fg: "gray" },
  });

  function refresh() {
    meta.setContent(statusLines().join("\n"));
    screen.render();
  }

  function leaveAnd(action: () => void, reopen = true) {
    screen.destroy();
    action();
    if (reopen && process.stdin.isTTY && process.stdout.isTTY) tui();
  }

  function hideSessions() {
    sessionList.hide();
    list.focus();
    screen.render();
  }

  function showSessions() {
    const sessions = listSessions();
    const labels = ["+ New session for this project", ...sessions.map(s => `${s.name}  ${s.status}`)];
    sessionList.setItems(labels);
    sessionList.show();
    sessionList.focus();
    screen.render();

    sessionList.removeAllListeners("select");
    sessionList.on("select", (_item, index) => {
      if (index === 0) return leaveAnd(() => start([]));
      const session = sessions[index - 1];
      if (session) leaveAnd(() => attachContainer(session.name));
    });
  }

  sessionList.key(["escape"], hideSessions);

  list.on("select", (_item, index) => {
    switch (index) {
      case 0: showSessions(); break;
      case 1: leaveAnd(shell); break;
      case 2: stopContainer(); refresh(); break;
      case 3: leaveAnd(() => buildImage(false)); break;
      case 4: leaveAnd(() => buildImage(true)); break;
      case 5: leaveAnd(logs); break;
      case 6: refresh(); break;
      case 7: screen.destroy(); process.exit(0);
    }
  });

  screen.key(["escape"], () => {
    if (!sessionList.hidden) hideSessions();
  });

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.append(box);
  list.focus();
  screen.render();
}

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case undefined:
    if (process.stdin.isTTY && process.stdout.isTTY && process.env.CONTAINER_PI_NO_TUI !== "1") tui();
    else start([]);
    break;
  case "run": start(process.argv.slice(3)); break;
  case "tui": tui(); break;
  case "build": buildImage(false); break;
  case "rebuild": buildImage(true); break;
  case "attach": attach(); break;
  case "shell": shell(); break;
  case "stop": stopContainer(); break;
  case "logs": logs(); break;
  case "list": listRunning(); break;
  case "status": status(); break;
  case "help":
  case "--help":
  case "-h":
    console.log(`container-pi

Usage:
  container-pi                 Open the TUI
  container-pi run [pi args...] Start or attach pi in this project container
  container-pi tui             Open the TUI explicitly
  container-pi attach          Attach to existing tmux session
  container-pi shell           Open a shell in the same container
  container-pi stop            Stop/remove this project container
  container-pi status          Show project container status
  container-pi logs            Follow container logs
  container-pi list            List running container-pi containers
  container-pi build|rebuild   Build image

Environment:
  CONTAINER_PI_ENGINE=docker|podman
  CONTAINER_PI_IMAGE=container-pi:latest
  CONTAINER_PI_NAME=custom-name
  CONTAINER_PI_NO_TUI=1
`);
    break;
  default:
    start(process.argv.slice(2));
}
