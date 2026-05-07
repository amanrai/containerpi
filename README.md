# container-pi


```
        _
  _ __ (_)  container-pi
 | '_ \| |
 | |_) | |
 | .__/|_|
 |_|
```

Built with [Pi](https://pi.dev), but in no way associated with the builders of the very excellent [Pi Coding Agent](https://github.com/badlogic/pi-mono) itself.


Run `pi` inside a per-project Linux container, with the current folder mounted read-write and the live Pi UI running inside tmux.

## Why TypeScript/tsx?

Yes: a TypeScript wrapper is nicer than shell for Linux/macOS portability. It avoids `sed`/`readlink`/`sha1sum` differences, gives cleaner argument handling, and is easier to extend.

There is still a tiny Node entrypoint inside the container because the container must create a user matching your host UID/GID, start tmux, and keep the container alive.

## What gets mounted

For convenience/auth reuse, this mounts the whole agent config folders:

- `~/.pi` -> `/home/pi/.pi`
- `~/.agents` -> `/home/pi/.agents`
- `~/.codex` -> `/home/pi/.codex`
- `~/.claude` -> `/home/pi/.claude`
- current project -> `/workspace`

This means Pi skills, prompts, extensions, packages, sessions, settings, auth, and related Claude/Codex config are available without re-login.

Security note: those folders may contain credentials/tokens. This is convenient but only use images you trust.

## Install/use from this folder

```bash
cd container-pi
npm install
npm run container-pi -- status
```

Run in another repo/folder by invoking the script path:

```bash
cd /path/to/project
npx tsx /home/amanrai/Code/container-pi/src/container-pi.ts
```

Optional shell alias:

```bash
alias container-pi='npx tsx /home/amanrai/Code/container-pi/src/container-pi.ts'
```

Then:

```bash
cd /path/to/project
container-pi
```

With no arguments, `container-pi` opens a small terminal UI. Choose **Sessions** to see existing sessions plus **New session**. New session opens a directory browser so you can choose the workspace. Selecting an existing session opens a second menu with **Attach** and **Stop/remove**.

## Commands

```bash
container-pi                  # open the TUI
container-pi tui              # open the TUI explicitly
container-pi run              # start default project container, run pi in tmux, attach
container-pi attach           # attach to existing tmux session
container-pi shell            # open shell in same container
container-pi stop             # remove default project container
container-pi status           # show image/container/project info
container-pi logs             # follow container logs
container-pi list             # list running container-pi containers
container-pi build            # build image
container-pi rebuild          # rebuild image with --no-cache
```

Pi args pass through via `run`:

```bash
container-pi run --model sonnet:high
container-pi run -p "summarize this repo"
container-pi run --offline
```

If you prefer the old no-TUI behavior:

```bash
CONTAINER_PI_NO_TUI=1 container-pi
```

Detach from tmux with `Ctrl-b d`.

Directory browser keys:

- `Enter` on a directory descends into it
- `Enter` on `✓ Use this directory` starts a new session there
- `Backspace` goes up one directory
- `~` jumps to your home directory
- `/` jumps to filesystem root
- `Esc` returns to the sessions list

## Environment

```bash
CONTAINER_PI_ENGINE=docker        # or podman
CONTAINER_PI_IMAGE=container-pi:latest
CONTAINER_PI_NAME=my-custom-name
CONTAINER_PI_NO_TUI=1              # make no-arg invocation run pi directly
```

The wrapper also forwards common provider keys like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, AWS env vars, etc.
