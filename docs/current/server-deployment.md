# Running Duckle on a Server

This guide walks through the whole server flow end to end: standing a Duckle server up, connecting the desktop studio to it, publishing a pipeline, and running it there on a schedule.

It is written to be followed in order, on one machine, in about fifteen minutes. Everything here works the same way against a real cloud server; only the address changes.

---

## What you are building

```text
  Desktop studio                          Your server
  ┌──────────────────┐                    ┌──────────────────────────┐
  │  Draw a pipeline │                    │  duckle-runner serve     │
  │        │         │   Deploy (admin)   │   ├─ pipelines           │
  │        └─────────┼───────────────────►│   ├─ schedules (OFF)     │
  │                  │                    │   ├─ run history         │
  │  Claim / connect │◄──────────────────►│   └─ web console         │
  └──────────────────┘    one API key     └──────────────────────────┘
```

The studio is where pipelines are written. The server is where they run, on a clock, without the studio open. A pipeline is one JSON file, so the same file runs in both places.

---

## Part 1: Start a server

### Step 1. Make an empty folder for it

```bat
mkdir C:\duckle-server
```

It must be a **new, empty folder**. A workspace that already has accounts in it counts as already set up, and cannot be claimed.

### Step 2. Get the runner

You do not have to download anything. The studio carries the server binary inside it:

1. Open Duckle.
2. **Settings** (gear icon) → **First run** → **Run setup again**.
3. Choose **My team, on a server**, then **Custom**.
4. Press **Save the runner**.

It writes `duckle-runner.exe` into `%APPDATA%\io.duckle.app\server\` and shows you the exact command to start it. Leave the wizard open on this screen.

> Deploying to AWS, Azure or Google Cloud instead? Pick that provider in the same step and it gives you a container command for it. The rest of this guide is unchanged.

### Step 3. Start it

Paste the command the wizard gave you into a terminal. It looks like this:

```bat
cd "C:\Users\<you>\AppData\Roaming\io.duckle.app\server"
.\duckle-runner.exe serve --workspace C:\duckle-server --host 0.0.0.0 --port 8095
```

Wait for this line:

```text
duckle-runner: NOT SET UP. This console is reachable on 0.0.0.0 and has no
accounts, so for the next 15 minutes anyone who can reach it can claim it
and become its administrator.
```

That line is how you know it worked.

> **The one thing that catches people out.** It must be `--host 0.0.0.0`, not `127.0.0.1`. A server that only answers on loopback is treated as already yours, replies `410` to setup, and can never be claimed from the studio. You still *connect* to `127.0.0.1` in the next step; only the bind address matters.

> **You have fifteen minutes.** During that window anyone who can reach the port can claim it, which is the price of setting up from a wizard instead of a shell. If you run over, stop the server and start it again to reopen the window.

---

## Part 2: Connect the studio to it

### Step 4. Finish the wizard

Back in Duckle, on the screen you left open:

1. Press **It is running**.
2. Address: `http://127.0.0.1:8095`
3. Call it: `prod`
4. **Continue**

The studio asks the server what it is. You should see **"Nobody administers this server yet"**.

### Step 5. Claim it

Type your name and press **Claim it**.

* The studio ends on **"Connected to prod"**.
* The terminal logs `claimed by '<you>'; setup is closed`.

The server now has an administrator, and setup is closed for good. The key it issued is stored on this machine, encrypted with your workspace key, and is never shown again.

### Step 6. Check it locked down

Open `http://127.0.0.1:8095` in a browser. It now asks you to sign in. A moment ago it was wide open.

---

## Part 3: Publish a pipeline

### Step 7. Open a pipeline

In the left sidebar, switch to the **PROJECT** tab and click any pipeline.

### Step 8. Deploy it

Either route works:

* **Toolbar** → the `⋯` menu → **Deploy to a server…**
* **Right-click the pipeline** in the project tree → **Deploy to a server…**

Then choose the server `prod`, check the name, and press **Deploy**.

You should see **"Installed &lt;name&gt; on prod."** Deploying the same pipeline again says *Replaced* instead.

If that pipeline has a schedule, the dialog offers to send it too, and tells you it arrived switched off.

---

## Part 4: Confirm what landed

### Step 9. Look at the server's folder

```bat
dir C:\duckle-server
```

Your pipeline is there as a `.json` file.

### Step 10. Check what did not travel

```bat
findstr /C:"sampleRows" C:\duckle-server\*.json
```

No matches is the correct answer. Preview rows are real rows read from your real sources, and they are stripped out before anything is sent.

If a schedule went with it:

```bat
type C:\duckle-server\schedules.json
```

It will say `"enabled": false`. **A deployed schedule always arrives switched off.** A cadence someone set while testing must not start firing the moment it reaches a server; turning it on is a separate, deliberate act.

---

## Part 5: Run it on the server

### Step 11. Make yourself a console login

Claiming gave the *studio* a key. To sign in to the console with a *browser* you need your own token. In a second terminal, leaving the server running:

```bat
cd "C:\Users\<you>\AppData\Roaming\io.duckle.app\server"
.\duckle-runner.exe console add-user sourav --role admin --workspace C:\duckle-server
```

It prints a token **once**. It is stored only as a hash and cannot be recovered, so keep it somewhere safe or generate another later.

### Step 12. Sign in and run it

Open `http://127.0.0.1:8095` and sign in with that token.

| Tab | What to try |
| --- | --- |
| **Overview** | Your deployed pipeline, with a **Run** button |
| **Runs** | What ran, how long it took, what failed |
| **Schedules** | Switch the deployed schedule on |
| **Plans** | Run several pipelines in a fixed order |
| **People** | Add colleagues, or mint an API key for a machine |
| **Audit** | Who signed in, what they changed, who was refused |

---

## When you are finished

* Stop the server with `Ctrl+C`. Binding to `0.0.0.0` really does expose the port on your network, and restarting reopens the fifteen-minute claim window.
* Delete `C:\duckle-server` if it was only a rehearsal.

---

## Who can do what

| Role | Can |
| --- | --- |
| `viewer` | Read the dashboard, run history, logs, schedules and catalog |
| `operator` | All of the above, plus run pipelines and change schedules |
| `admin` | All of the above, plus deploy pipelines and manage people |

The split follows what an action can destroy rather than which screen it lives on. It is why **deploying needs `admin` while switching a schedule on needs `operator`**: shipping code to a host and deciding when trusted code runs are different sizes of decision.

---

## If something goes wrong

| What you see | What it means |
| --- | --- |
| Setup says the server is **already set up** | It was started on `127.0.0.1`, or its workspace already has accounts. Use an empty folder and `--host 0.0.0.0`. |
| **Could not reach** the address | The server stopped, or the port is wrong. Check the terminal is still running. |
| **did not accept this key** | The key was revoked or expired. Mint another with `console key-add`. |
| **this key may not deploy** | The key is not an `admin`. Deploying needs one. |
| The claim window closed | Stop the server and start it again; the window reopens. |

---

## Next steps

* [Scheduler & Automation](scheduler.md) — cron, intervals and file watches in depth
* [Desktop Shell & Workspace Git Flow](architecture.md) — putting pipelines in version control
* Full cloud recipes for AWS, Azure and Google Cloud: <https://duckle.org/deploy.html>
