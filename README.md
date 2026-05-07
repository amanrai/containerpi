# container-pi

Run [`pi`](https://github.com/badlogic/pi-mono) inside a per-project Linux container, with the selected workspace mounted at `/workspace` and the live Pi UI running inside `tmux`.

Built with [Pi](https://pi.dev), but not associated with the Pi Coding Agent project or its builders.

## What it does

- Starts Pi inside Docker or Podman.
- Mounts one selected project/worktree into the container at `/workspace`.
- Reuses your local agent auth/config from `~/.pi`, `~/.agents`, `~/.codex`, and `~/.claude`.
- Keeps Pi running in `tmux`, so you can detach and reattach.
- Includes `starship` in the container for Starship-powered Pi footers/prompts.
- Can create Git worktrees for isolated agent sessions.
- Provides lifecycle hooks for project/global automation.

## Prerequisites

Install Docker or Podman, then install and log into Pi locally once:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
# inside pi: /login
```

`container-pi` mounts your local config/auth folders into the container. If you have not logged into Pi locally first, the container will not have your subscription/provider auth state.

## Install

From this repo:

```bash
cd container-pi
npm install
npm run container-pi -- status
```

Run from another project by pointing `tsx` at this repo:

```bash
cd /path/to/project
npx tsx /path/to/container-pi/src/container-pi.ts
```

### Optional shell alias

From inside the cloned `container-pi` repo:

```bash
printf "alias container-pi='npx tsx %s/src/container-pi.ts'\n" "$(pwd)" >> ~/.zshrc
source ~/.zshrc
```

For bash, use `~/.bashrc` instead of `~/.zshrc`.

## Usage

```bash
container-pi                  # open the TUI
container-pi tui              # open the TUI explicitly
container-pi run              # start/attach the default project container
container-pi attach           # attach to this project's container
container-pi shell            # shell into this project's running container
container-pi stop             # remove this project's container
container-pi status           # show project container status
container-pi logs             # follow project container logs
container-pi list             # list container-pi containers
container-pi build            # build image
container-pi rebuild          # rebuild image with --no-cache
```

Pass Pi args through `run`:

```bash
container-pi run --model sonnet:high
container-pi run -p "summarize this repo"
container-pi run --offline
```

Prefer no-TUI behavior?

```bash
CONTAINER_PI_NO_TUI=1 container-pi
```

Detach from tmux with:

```text
Ctrl-b d
```

## TUI flow

### Sessions

Open **Sessions** to see:

```text
+ New session
existing sessions...
```

Choosing **New session**:

1. Opens a directory browser.
2. Choose a workspace folder.
3. Choose one of:
   ```text
   Let's do it in a worktree      # default
   Life's too short, Yolo It
   ```
4. Worktree mode asks for a worktree/branch name.
5. The worktree is created and mounted into the container at `/workspace`.

Worktrees are created under:

```text
~/.container-pi/worktrees/<chosen-folder-name>/<worktree-name>
```

For example:

```text
~/.container-pi/worktrees/my-app/pi-session-on-2026-05-07-11-42-09
```

### Existing session actions

Normal sessions show:

```text
Attach
Stop/remove
```

Sessions running from linked Git worktrees also show:

```text
Generate PR
Publish branch
Remove worktree + session
```

Stale sessions whose workspace path is missing are marked as stale and show:

```text
Remove stale session
```

### Cleanup

Use **Prune missing worktrees** from the main menu to run:

```bash
git worktree prune
```

for the current repository.

### Navigation

```text
↑/↓ or j/k   select
Enter        run/select
←            focus the higher-level menu
Esc          back/cancel
q            quit
```

Directory browser shortcuts:

```text
Enter on a directory            descend
Enter on ✓ Use this directory   choose folder
Backspace                       go up
~                               jump home
/                               jump root
```

## Mounts

The selected workspace is mounted read-write:

```text
<selected workspace> -> /workspace
```

For auth/config reuse, these host folders are also mounted:

```text
~/.pi      -> /home/pi/.pi
~/.agents  -> /home/pi/.agents
~/.codex   -> /home/pi/.codex
~/.claude  -> /home/pi/.claude
```

Optional mounts, when present:

```text
~/.ssh        -> /home/pi/.ssh         read-only
~/.gitconfig  -> /home/pi/.gitconfig   read-only
~/.npm        -> /home/pi/.npm         read-write
```

Security note: these folders may contain credentials/tokens. Only use images you trust.

## Worktrees

By default, worktrees live in a durable host path:

```text
~/.container-pi/worktrees
```

Override with:

```bash
CONTAINER_PI_WORKTREE_ROOT=/some/path container-pi
```

Worktree sessions mount only the worktree into the container. The original/base checkout is not mounted unless it is inside the selected worktree path.

## Hooks

`container-pi` runs optional bash hooks from both project and global locations, in this order:

```text
<project>/.container-pi/hooks/<hook>
<project>/.container-pi/hooks/<hook>.sh
~/.config/container-pi/hooks/<hook>
~/.config/container-pi/hooks/<hook>.sh
```

Supported hooks:

```text
pre-load          before loading/starting a session; non-zero exit aborts startup
session-attach    immediately before attaching to tmux
session-detach    after returning from tmux attach/detach
shutdown          before removing a container-pi container
```

Hook environment:

```bash
CONTAINER_PI_HOOK       # hook name
CONTAINER_PI_CONTAINER  # Docker/Podman container name
CONTAINER_PI_PROJECT    # project/workspace path on the host
CONTAINER_PI_IMAGE      # image name
CONTAINER_PI_ENGINE     # docker or podman
```

Example:

```bash
mkdir -p .container-pi/hooks
cat > .container-pi/hooks/session-detach <<'EOF'
#!/usr/bin/env bash
echo "detached from $CONTAINER_PI_CONTAINER in $CONTAINER_PI_PROJECT"
EOF
chmod +x .container-pi/hooks/session-detach
```

## Environment

```bash
CONTAINER_PI_ENGINE=docker        # or podman
CONTAINER_PI_IMAGE=container-pi:latest
CONTAINER_PI_NAME=my-custom-name
CONTAINER_PI_NO_TUI=1              # make no-arg invocation run pi directly
CONTAINER_PI_WORKTREE_ROOT=~/.container-pi/worktrees
```

The wrapper also forwards common provider keys like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, AWS env vars, etc.

## Why TypeScript/tsx?

A TypeScript wrapper is nicer than shell for Linux/macOS portability. It avoids `sed`/`readlink`/`sha1sum` differences, gives cleaner argument handling, and is easier to extend.

There is still a small Node entrypoint inside the image because the container needs to create a Linux user matching your host UID/GID, start `tmux`, and keep the container alive.
