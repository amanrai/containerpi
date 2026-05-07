#!/usr/bin/env -S tsx
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

function attach() {
  if (!containerRunning()) {
    console.error(`No running container for ${resolve(cwd)} (${containerName})`);
    process.exit(1);
  }
  run(engine, [
    "exec", "-it", containerName,
    "bash", "-lc",
    `u=$(getent passwd \"$HOST_UID\" | cut -d: -f1); exec gosu \"$u\" tmux -S ${tmuxSocket} attach -t ${tmuxSession}`
  ]);
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

function status() {
  console.log(`engine:    ${engine}`);
  console.log(`image:     ${image}`);
  console.log(`container: ${containerName}`);
  console.log(`project:   ${resolve(cwd)}`);
  console.log(`exists:    ${containerExists()}`);
  console.log(`running:   ${containerRunning()}`);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "build": buildImage(false); break;
  case "rebuild": buildImage(true); break;
  case "attach": attach(); break;
  case "shell": shell(); break;
  case "stop": if (containerExists()) run(engine, ["rm", "-f", containerName]); break;
  case "logs": run(engine, ["logs", "-f", containerName]); break;
  case "status": status(); break;
  case "help":
  case "--help":
  case "-h":
    console.log(`container-pi

Usage:
  container-pi [pi args...]       Start or attach pi in this project container
  container-pi attach             Attach to existing tmux session
  container-pi shell              Open a shell in the same container
  container-pi stop               Stop/remove this project container
  container-pi status             Show project container status
  container-pi logs               Follow container logs
  container-pi build|rebuild      Build image

Environment:
  CONTAINER_PI_ENGINE=docker|podman
  CONTAINER_PI_IMAGE=container-pi:latest
  CONTAINER_PI_NAME=custom-name
`);
    break;
  default:
    start(process.argv.slice(2));
}
