#!/usr/bin/env -S tsx
import blessed from "blessed";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
const terminalEnv = ["-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor", "-e", "FORCE_COLOR=1"];
const configDir = resolve(home, ".config", "container-pi");
const settingsFile = resolve(configDir, "settings.json");
const defaultWorktreeRoot = "/tmp/container-pi/worktrees";
type HookName = "pre-load" | "session-attach" | "session-detach" | "shutdown";
type Settings = { worktreeRoot?: string };

function findEngine(): string {
  for (const candidate of ["docker", "podman"]) {
    const r = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return candidate;
  }
  throw new Error("container-pi requires docker or podman");
}

function run(cmd: string, args: string[], opts: { capture?: boolean; check?: boolean; stdio?: any; cwd?: string } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
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

function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: Settings) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

function worktreeRoot() {
  return process.env.CONTAINER_PI_WORKTREE_ROOT || loadSettings().worktreeRoot || defaultWorktreeRoot;
}

function setWorktreeRoot(path: string) {
  saveSettings({ ...loadSettings(), worktreeRoot: resolve(path) });
}

function projectForContainer(name: string) {
  return output(engine, ["inspect", "-f", "{{ index .Config.Labels \"container-pi.project\" }}", name]);
}

function hookFiles(hook: HookName, projectDir = cwd) {
  const names = [hook, `${hook}.sh`];
  const dirs = [
    resolve(projectDir, ".container-pi", "hooks"),
    resolve(home, ".config", "container-pi", "hooks"),
  ];
  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const file = resolve(dir, name);
      if (existsSync(file) && statSync(file).isFile()) files.push(file);
    }
  }
  return files;
}

function runHooks(hook: HookName, context: { container?: string; projectDir?: string } = {}, opts: { check?: boolean } = {}) {
  const projectDir = resolve(context.projectDir || cwd);
  const files = hookFiles(hook, projectDir);
  for (const file of files) {
    const res = spawnSync("bash", [file], {
      stdio: "inherit",
      env: {
        ...process.env,
        CONTAINER_PI_HOOK: hook,
        CONTAINER_PI_CONTAINER: context.container || "",
        CONTAINER_PI_PROJECT: projectDir,
        CONTAINER_PI_IMAGE: image,
        CONTAINER_PI_ENGINE: engine,
      },
    });
    if (res.status !== 0) {
      const message = `container-pi hook failed (${hook}): ${file}`;
      if (opts.check) {
        console.error(message);
        process.exit(res.status ?? 1);
      }
      console.error(`${message}; continuing`);
    }
  }
}

function imageExists() {
  return run(engine, ["image", "inspect", image], { check: false, stdio: "ignore" }).status === 0;
}

function containerExistsName(name: string) {
  return run(engine, ["container", "inspect", name], { check: false, stdio: "ignore" }).status === 0;
}

function containerRunningName(name: string) {
  if (!containerExistsName(name)) return false;
  return output(engine, ["inspect", "-f", "{{.State.Running}}", name]) === "true";
}

function containerExists() {
  return containerExistsName(containerName);
}

function containerRunning() {
  return containerRunningName(containerName);
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

function mountArgs(projectDir = cwd): string[] {
  const args = [
    "-v", `${resolve(projectDir)}:/workspace:rw`,
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

function tmuxHasSession(name: string) {
  return run(engine, [
    "exec", name,
    "bash", "-lc",
    `u=$(getent passwd \"$HOST_UID\" | cut -d: -f1); gosu \"$u\" tmux -S ${tmuxSocket} has-session -t ${tmuxSession}`
  ], { check: false, stdio: "ignore" }).status === 0;
}

function waitForTmuxSession(name: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tmuxHasSession(name)) return true;
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)"]);
  }
  return false;
}

function attachContainer(name: string) {
  const exists = run(engine, ["container", "inspect", name], { check: false, stdio: "ignore" }).status === 0;
  if (!exists) {
    console.error(`No such container: ${name}`);
    process.exit(1);
  }
  const projectDir = projectForContainer(name) || cwd;
  const running = output(engine, ["inspect", "-f", "{{.State.Running}}", name]) === "true";
  if (!running) run(engine, ["start", name]);
  runHooks("session-attach", { container: name, projectDir });
  if (!waitForTmuxSession(name)) {
    console.error(`tmux session '${tmuxSession}' did not start in container ${name}. Recent logs:`);
    run(engine, ["logs", "--tail", "80", name], { check: false });
    process.exit(1);
  }
  run(engine, [
    "exec", "-it", name,
    "bash", "-lc",
    `u=$(getent passwd \"$HOST_UID\" | cut -d: -f1); export TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1; exec gosu \"$u\" tmux -2 -S ${tmuxSocket} attach -t ${tmuxSession}`
  ]);
  runHooks("session-detach", { container: name, projectDir });
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

function startNamed(name: string, piArgs: string[], projectDir = cwd) {
  const resolvedProjectDir = resolve(projectDir);
  runHooks("pre-load", { container: name, projectDir: resolvedProjectDir }, { check: true });
  ensureConfigDirs();
  if (!imageExists()) buildImage(false);

  if (containerRunningName(name)) return attachContainer(name);
  if (containerExistsName(name)) run(engine, ["rm", "-f", name]);

  run(engine, [
    "run", "-d",
    "--name", name,
    "--label", `container-pi.project=${resolvedProjectDir}`,
    "--label", `container-pi.created=${new Date().toISOString()}`,
    ...terminalEnv,
    "-e", `HOST_UID=${process.getuid?.() ?? 1000}`,
    "-e", `HOST_GID=${process.getgid?.() ?? 1000}`,
    "-e", "PI_CODING_AGENT_DIR=/home/pi/.pi/agent",
    "-e", `CONTAINER_PI_TMUX_SOCKET=${tmuxSocket}`,
    "-e", `CONTAINER_PI_TMUX_SESSION=${tmuxSession}`,
    ...envArgs(),
    ...mountArgs(resolvedProjectDir),
    "-w", "/workspace",
    image,
    "pi", ...piArgs,
  ]);

  attachContainer(name);
}

function newSessionName(projectDir = cwd) {
  const resolved = resolve(projectDir);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  const base = resolved.split(/[\\/]/).filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_.-]/g, "-") || "workspace";
  return `container-pi-${base}-${hash}-${Date.now().toString(36)}`;
}

function start(piArgs: string[]) {
  startNamed(containerName, piArgs);
}

function statusLines() {
  return [
    `engine:    ${engine}`,
    `image:     ${image}`,
    `container: ${containerName}`,
    `project:   ${resolve(cwd)}`,
    `exists:    ${containerExists()}`,
    `running:   ${containerRunning()}`,
    `worktrees: ${worktreeRoot()}`,
  ];
}

function status() {
  console.log(statusLines().join("\n"));
}

function stopContainerName(name: string) {
  if (containerExistsName(name)) {
    runHooks("shutdown", { container: name, projectDir: projectForContainer(name) || cwd });
    run(engine, ["rm", "-f", name]);
  }
}

function stopContainer() {
  stopContainerName(containerName);
}

function logs() {
  run(engine, ["logs", "-f", containerName]);
}

type SessionInfo = { name: string; image: string; status: string; project: string };

function listSessions(): SessionInfo[] {
  const format = "{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Label \"container-pi.project\"}}";
  const r = run(engine, ["ps", "-a", "--filter", "name=container-pi-", "--format", format], { capture: true, check: false });
  const text = r.status === 0 ? String(r.stdout).trim() : "";
  if (!text) return [];
  return text.split("\n").map(line => {
    const [name = "", image = "", status = "", project = ""] = line.split("\t");
    return { name, image, status, project };
  }).filter(s => s.name.startsWith("container-pi-"));
}

function listRunningText() {
  const sessions = listSessions();
  if (!sessions.length) return "No container-pi sessions.";
  return ["NAMES                                 IMAGE                 STATUS        PROJECT", ...sessions.map(s => `${s.name.padEnd(37)} ${s.image.padEnd(21)} ${s.status.padEnd(13)} ${s.project}`)].join("\n");
}

function listRunning() {
  console.log(listRunningText());
}

function gitOutput(projectDir: string, args: string[]) {
  return output("git", ["-C", projectDir, ...args]);
}

function gitRepoRoot(projectDir: string) {
  return gitOutput(projectDir, ["rev-parse", "--show-toplevel"]);
}

function gitBranch(projectDir: string) {
  return gitOutput(projectDir, ["branch", "--show-current"]);
}

function isLinkedWorktree(projectDir: string) {
  const root = gitRepoRoot(projectDir);
  if (!root) return false;
  const text = gitOutput(root, ["worktree", "list", "--porcelain"]);
  const worktrees = text.split("\n").filter(line => line.startsWith("worktree ")).map(line => resolve(line.slice("worktree ".length)));
  return worktrees.length > 1 && resolve(root) !== worktrees[0];
}

function safeWorktreeName(name: string) {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

function defaultWorktreeName() {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  return `pi-session-on-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function defaultWorktreePath(projectDir: string, name: string) {
  return resolve(worktreeRoot(), basename(resolve(projectDir)), safeWorktreeName(name));
}

function startWorktreeSession(repoRoot: string, branch: string, worktreePath: string, sessionName: string) {
  mkdirSync(dirname(resolve(worktreePath)), { recursive: true });
  run("git", ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath]);
  startNamed(sessionName, [], worktreePath);
}

function publishBranch(projectDir: string) {
  const branch = gitBranch(projectDir);
  if (!branch) {
    console.error(`Could not determine current branch for ${projectDir}`);
    process.exit(1);
  }
  run("git", ["-C", projectDir, "push", "-u", "origin", branch]);
}

function generatePr(projectDir: string) {
  const gh = spawnSync("gh", ["--version"], { stdio: "ignore" });
  if (gh.status !== 0) {
    console.error("Generate PR requires the GitHub CLI (`gh`) to be installed and authenticated.");
    process.exit(1);
  }
  run("gh", ["pr", "create", "--draft", "--fill"], { cwd: projectDir });
}

function tui(reopenSessionName?: string) {
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
    "Sessions",
    "Configure worktree path",
    "Configure hooks",
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

  const sessionActions = blessed.list({
    parent: box,
    top: 26,
    left: "55%",
    width: "42%",
    height: 5,
    keys: true,
    mouse: true,
    vi: true,
    hidden: true,
    border: "line",
    label: " session actions ",
    items: ["Attach", "Stop/remove"],
    style: {
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { fg: "white" },
    },
  });

  const browser = blessed.list({
    parent: box,
    top: 11,
    left: "55%",
    width: "42%",
    height: 18,
    keys: true,
    mouse: true,
    vi: true,
    hidden: true,
    border: "line",
    label: " choose workspace ",
    style: {
      border: { fg: "green" },
      selected: { bg: "green", fg: "black", bold: true },
      item: { fg: "white" },
    },
  });

  const sessionMode = blessed.list({
    parent: box,
    top: 11,
    left: "55%",
    width: "42%",
    height: 6,
    keys: true,
    mouse: true,
    vi: true,
    hidden: true,
    border: "line",
    label: " new session mode ",
    items: ["Let's do it in a worktree", "Life's too short, Yolo It"],
    style: {
      border: { fg: "yellow" },
      selected: { bg: "yellow", fg: "black", bold: true },
      item: { fg: "white" },
    },
  });

  const hookConfig = blessed.box({
    parent: box,
    top: 11,
    left: "55%",
    width: "42%",
    height: 14,
    keys: true,
    mouse: true,
    hidden: true,
    border: "line",
    label: " configure hooks ",
    content: [
      "Hook configuration will live here.",
      "",
      "Current hook names:",
      "  pre-load",
      "  session-attach",
      "  session-detach",
      "  shutdown",
      "",
      "Esc returns to the main menu.",
    ].join("\n"),
    style: {
      border: { fg: "magenta" },
      fg: "white",
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

  function leaveAnd(action: () => void, reopen = true, reopenSessionName?: string) {
    screen.destroy();
    action();
    if (reopen && process.stdin.isTTY && process.stdout.isTTY) tui(reopenSessionName);
  }

  function hideBrowser() {
    browser.hide();
    sessionMode.hide();
    sessionList.focus();
    screen.render();
  }

  function hideSessionMode() {
    sessionMode.hide();
    browser.show();
    browser.focus();
    screen.render();
  }

  function hideSessionActions() {
    sessionActions.hide();
    sessionList.focus();
    screen.render();
  }

  function hideSessions() {
    browser.hide();
    sessionMode.hide();
    sessionActions.hide();
    sessionList.hide();
    list.focus();
    screen.render();
  }

  function hideHookConfig() {
    hookConfig.hide();
    list.focus();
    screen.render();
  }

  function showHookConfig() {
    browser.hide();
    sessionMode.hide();
    sessionActions.hide();
    sessionList.hide();
    hookConfig.show();
    hookConfig.focus();
    screen.render();
  }

  function showMessage(title: string, message: string) {
    const msg = blessed.message({
      parent: box,
      top: "center",
      left: "center",
      width: "60%",
      height: "shrink",
      border: "line",
      label: ` ${title} `,
      style: { border: { fg: "yellow" }, fg: "white" },
    });
    msg.display(message, 0, () => msg.destroy());
    screen.render();
  }

  function ask(title: string, value: string, callback: (value: string) => void) {
    const form = blessed.form({
      parent: box,
      top: "center",
      left: "center",
      width: "75%",
      height: 9,
      keys: true,
      vi: true,
      border: "line",
      label: ` ${title} `,
      style: { border: { fg: "magenta" }, fg: "white" },
    });
    blessed.text({
      parent: form,
      top: 0,
      left: 2,
      content: "Edit value, then press Enter to accept. Esc cancels.",
      style: { fg: "gray" },
    });
    const input = blessed.textbox({
      parent: form,
      top: 2,
      left: 2,
      width: "95%",
      height: 3,
      inputOnFocus: true,
      keys: true,
      mouse: true,
      border: "line",
      value,
      style: { border: { fg: "cyan" }, fg: "white" },
    });
    function done() {
      const trimmed = String(input.getValue() || "").trim();
      form.destroy();
      if (trimmed) callback(trimmed);
      else list.focus();
      screen.render();
    }
    function cancel() {
      form.destroy();
      list.focus();
      screen.render();
    }
    input.key(["enter"], done);
    input.key(["escape", "C-c"], cancel);
    form.key(["escape", "C-c"], cancel);
    input.focus();
    screen.render();
  }

  function configureWorktreePath() {
    ask("configure worktree path", worktreeRoot(), path => {
      setWorktreeRoot(path);
      meta.setContent(statusLines().join("\n"));
      showMessage("worktree path saved", `Worktrees will be created under:\n${worktreeRoot()}`);
    });
  }

  function showSessionActions(session: SessionInfo) {
    const linkedWorktree = session.project ? isLinkedWorktree(session.project) : false;
    const actions = linkedWorktree
      ? ["Attach", "Generate PR", "Publish branch", "Stop/remove"]
      : ["Attach", "Stop/remove"];
    sessionActions.setItems(actions);
    sessionActions.height = actions.length + 2;
    sessionActions.show();
    sessionActions.focus();
    screen.render();

    sessionActions.removeAllListeners("select");
    sessionActions.on("select", (_item, index) => {
      const action = actions[index];
      switch (action) {
        case "Attach": leaveAnd(() => attachContainer(session.name), true, session.name); break;
        case "Generate PR": leaveAnd(() => generatePr(session.project), true, session.name); break;
        case "Publish branch": leaveAnd(() => publishBranch(session.project), true, session.name); break;
        case "Stop/remove":
          stopContainerName(session.name);
          hideSessionActions();
          showSessions();
          break;
      }
    });
  }

  function chooseSessionMode(projectDir: string) {
    browser.hide();
    sessionMode.select(0);
    sessionMode.show();
    sessionMode.focus();
    screen.render();

    sessionMode.removeAllListeners("select");
    sessionMode.on("select", (_item, index) => {
      if (index === 1) {
        const name = newSessionName(projectDir);
        return leaveAnd(() => startNamed(name, [], projectDir), true, name);
      }

      const root = gitRepoRoot(projectDir);
      if (!root) return showMessage("not a git repo", "Worktree mode requires the selected folder to be inside a Git repository. Choose Yolo It to start directly in this folder.");
      ask("worktree name", defaultWorktreeName(), worktreeName => {
        const worktreePath = defaultWorktreePath(projectDir, worktreeName);
        const name = newSessionName(worktreePath);
        leaveAnd(() => startWorktreeSession(root, worktreeName, worktreePath, name), true, name);
      });
    });
  }

  function showWorkspaceBrowser(dir = cwd) {
    sessionActions.hide();
    let current = resolve(dir);

    function renderBrowser() {
      const entries = readdirSync(current, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));
      browser.setLabel(` choose workspace: ${current} `);
      browser.setItems(["✓ Use this directory", "..", ...entries.map(name => `${name}/`)]);
      browser.show();
      browser.focus();
      screen.render();
    }

    browser.removeAllListeners("select");
    browser.on("select", (_item, index) => {
      if (index === 0) return chooseSessionMode(current);
      if (index === 1) {
        current = resolve(current, "..");
        return renderBrowser();
      }
      const selected = String(browser.getItem(index)?.content ?? "").replace(/\/$/, "");
      const next = resolve(current, selected);
      if (existsSync(next) && statSync(next).isDirectory()) {
        current = next;
        renderBrowser();
      }
    });

    browser.key(["backspace"], () => {
      current = resolve(current, "..");
      renderBrowser();
    });
    browser.key(["~"], () => {
      current = home;
      renderBrowser();
    });
    browser.key(["/"], () => {
      current = "/";
      renderBrowser();
    });

    renderBrowser();
  }

  function showSessions() {
    browser.hide();
    sessionMode.hide();
    sessionActions.hide();
    const sessions = listSessions();
    const labels = [
      "+ New session",
      ...sessions.map(s => `${s.name}  ${s.status}${s.project ? `  ${s.project}` : ""}`),
    ];
    sessionList.setItems(labels);
    sessionList.show();
    sessionList.focus();
    screen.render();

    sessionList.removeAllListeners("select");
    sessionList.on("select", (_item, index) => {
      if (index === 0) return showWorkspaceBrowser(cwd);
      const session = sessions[index - 1];
      if (session) showSessionActions(session);
    });
  }

  sessionList.key(["escape"], hideSessions);
  sessionActions.key(["escape"], hideSessionActions);
  browser.key(["escape"], hideBrowser);
  sessionMode.key(["escape"], hideSessionMode);
  hookConfig.key(["escape"], hideHookConfig);

  list.on("select", (_item, index) => {
    switch (index) {
      case 0: showSessions(); break;
      case 1: configureWorktreePath(); break;
      case 2: showHookConfig(); break;
      case 3: leaveAnd(() => buildImage(false)); break;
      case 4: leaveAnd(() => buildImage(true)); break;
      case 5: leaveAnd(logs); break;
      case 6: refresh(); break;
      case 7: screen.destroy(); process.exit(0);
    }
  });

  screen.key(["escape"], () => {
    if (!sessionMode.hidden) hideSessionMode();
    else if (!browser.hidden) hideBrowser();
    else if (!sessionActions.hidden) hideSessionActions();
    else if (!sessionList.hidden) hideSessions();
    else if (!hookConfig.hidden) hideHookConfig();
  });

  screen.key(["left"], () => {
    if (!sessionMode.hidden) browser.focus();
    else if (!browser.hidden) sessionList.focus();
    else if (!sessionActions.hidden) sessionList.focus();
    else if (!sessionList.hidden) list.focus();
    else if (!hookConfig.hidden) list.focus();
    screen.render();
  });

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.append(box);
  if (reopenSessionName) {
    showSessions();
    const sessions = listSessions();
    const index = sessions.findIndex(s => s.name === reopenSessionName);
    if (index >= 0) {
      sessionList.select(index + 1);
      showSessionActions(sessions[index]);
    }
  } else {
    list.focus();
  }
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
  CONTAINER_PI_WORKTREE_ROOT=/tmp/container-pi/worktrees
`);
    break;
  default:
    start(process.argv.slice(2));
}
