# C Practice site

Question on the left, code editor on the right. Compiling, running and judging all happen on the machine
that runs `server.js`. Mentees only see the visible test cases. Hidden tests stay in the topic JSON files on
your laptop; the browser only receives Accepted / Wrong Answer / etc. for them.

## Important: run it in Docker if you can

Mentees' code runs on your laptop. In Docker it is walled off from your files. Without Docker it runs as
your own user and could read or delete your files. Use Option A unless you only share this with people you
trust on your own Wi-Fi.

## Option A (recommended): Docker Desktop

1. Install Docker Desktop (Windows / macOS) or Docker Engine (Linux) and start it.
2. In a terminal, inside this folder:

       docker build -t c-practice .

3. Start it (pick your own access code):

       docker run -d --name c-practice --restart unless-stopped -p 3000:3000 ^
         -e ACCESS_CODE=pick-a-code ^
         --memory 1g --cpus 2 --pids-limit 256 ^
         --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID ^
         --security-opt no-new-privileges c-practice

   On macOS/Linux use `\` instead of `^` at the line ends (or put it all on one line).
4. Open http://localhost:3000 to check it works.

Edit the topic JSON files later (`logical.json`, `array.json`, `2d array.json`, `strings.json`,
`functions.json`, or `sorting.json`), then `docker build -t c-practice .`, `docker rm -f c-practice` and
run step 3 again.

## Option B: run directly on the laptop (no Docker)

1. Install Node.js 18+ and a C compiler:
   - Windows: install MSYS2 (https://www.msys2.org), run `pacman -S mingw-w64-ucrt-x86_64-gcc`, and add
     `C:\msys64\ucrt64\bin` to PATH. Check `gcc --version` in a new terminal.
   - macOS: `xcode-select --install` (provides `gcc`, which is clang; fine for these questions).
   - Linux: `sudo apt install build-essential nodejs npm`.
2. In this folder:

       npm install
       ACCESS_CODE=pick-a-code node server.js          (macOS/Linux)
       set ACCESS_CODE=pick-a-code && node server.js    (Windows cmd)
       $env:ACCESS_CODE="pick-a-code"; node server.js   (Windows PowerShell)

3. Open http://localhost:3000.

Only a wall-clock timeout (2 s per test) protects you here; memory and file limits need Linux + Docker.

## Letting mentees reach your laptop

**Same Wi-Fi / college network (simplest):** find your laptop's IP (`ipconfig` on Windows, `ifconfig` or
`ip a` on macOS/Linux) and give mentees `http://YOUR-IP:3000`. If it does not load, allow port 3000 in your
firewall. Some campus networks block device-to-device traffic; then use a tunnel.

**From anywhere (tunnel):** no router settings needed. For example, with Cloudflare's free quick tunnel:

    cloudflared tunnel --url http://localhost:3000

It prints an `https://something.trycloudflare.com` link to share. Always set an `ACCESS_CODE` when you do
this, because anyone with the link could otherwise run code on your laptop. (Tailscale or ngrok work too.)

The site is only available while your laptop is on, awake, online and the server is running.

## Changing questions or tests

Edit a topic JSON file; each test has `"visible": true/false`. Restart the server (or rebuild the Docker image).

- `compare` (optional, per question): `"contains"` accepts any output containing the expected text
  (used for Q1). Default compares whitespace-separated tokens with a tiny tolerance for decimals.
- `timeLimitMs` (optional, per question): default 2000 ms (env `TIME_LIMIT_MS`).

## Libraries

The whole C standard library is available, and `-lm` and `-lpthread` are linked automatically. For other
libraries, install them and add the `-l...` flag in the compile line in `server.js` (in Docker, also add the
`-dev` package to the `Dockerfile`).

## Deploy on Render

This repository includes `render.yaml` and a Dockerfile. Create a Render Web Service from this GitHub
repository, choose the Free plan, and set the `ACCESS_CODE` environment variable. Render will build the
Docker image with GCC and deploy the app on a public `onrender.com` URL.
