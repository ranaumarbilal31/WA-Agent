# Deploy WA-Agent for free on Oracle Cloud

## Is it really free? (double-checked Oct 2026)

Yes — Oracle Cloud's **Always Free** tier (not a trial, permanent):

- **VM:** Ampere ARM, 2 OCPU / 12 GB RAM, 200 GB disk, 10 TB/month bandwidth
- **Price:** $0 forever, as long as you only create resources labeled **"Always Free eligible"**

Three gotchas to know:

1. **Card at signup.** Oracle asks for a credit/debit card to verify identity. It is *not* charged if you stick to Always Free resources.
2. **First 30 days = trial.** You also get a $300 trial credit for 30 days. Don't touch it — only create "Always Free eligible" things and you'll never be billed.
3. **"Out of capacity".** Free ARM machines are popular; some regions run out. If creation fails with capacity error, try another region (e.g. `ap-mumbai-1` is close to Pakistan) or retry later.

## What you need

- An Oracle Cloud account → [oracle.com/cloud/free](https://www.oracle.com/cloud/free/)
- An SSH key. On Windows, open PowerShell and run: `ssh-keygen` (press Enter 3x). Your public key is at `C:\Users\<you>\.ssh\id_rsa.pub`.

## Step 1 — Create the VM

1. Console → **Compute → Instances → Create instance**
2. Name: `wa-agent`
3. Image: **Ubuntu 22.04** (make sure the ARM/aarch64 variant is selected)
4. Shape: **VM.Standard.A1.Flex** → set **2 OCPU / 12 GB RAM**. Confirm it says "Always Free eligible".
5. Networking: create a new VCN (defaults are fine). In the subnet's **security list**, allow inbound **port 22** (SSH) from anywhere. **Do NOT open port 3000** — we'll reach the dashboard through a safe SSH tunnel instead.
6. Paste your **public** SSH key (`id_rsa.pub` contents).
7. Create. Note the instance's **public IP**.

## Step 2 — Connect

```powershell
ssh -i C:\Users\<you>\.ssh\id_rsa ubuntu@<PUBLIC-IP>
```

## Step 3 — Install everything

Run these on the VM, one block at a time:

```bash
# Node.js 20 + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Libraries headless Chrome needs
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2

# WA-Agent
git clone https://github.com/ranaumarbilal31/WA-Agent.git
cd WA-Agent
npm install
npx puppeteer browsers install chrome
```

## Step 4 — Run it forever

```bash
sudo npm install -g pm2
pm2 start src/index.js --name wa-agent
pm2 save
pm2 startup
# pm2 prints a command — copy-paste and run it, so the bot restarts if the VM reboots
```

Check it's alive: `pm2 logs wa-agent` — you should see `WA-Agent on http://localhost:3000`.

## Step 5 — Open the dashboard (safe, no open port)

On your **Windows** machine, open a terminal and run:

```powershell
ssh -i C:\Users\<you>\.ssh\id_rsa -L 3000:localhost:3000 ubuntu@<PUBLIC-IP>
```

Leave that window open, then browse to **http://localhost:3000** on your laptop.
Finish Setup: scan the WhatsApp QR (one time — the session is saved on the VM),
paste your AI key, upload a chat export. Done. When you close the SSH window,
the bot keeps running on the VM.

## Auto-deploy from GitHub?

Unlike Render, Oracle gives you a raw VM — **no built-in auto-deploy**.
Two options:

**Manual (simplest):** SSH in and run:

```bash
cd ~/WA-Agent && git pull && pm2 restart wa-agent
```

**Automatic:** a cron job that checks GitHub every 30 minutes and restarts
only when something new was pushed:

```bash
crontab -e
# paste this line:
*/30 * * * * cd ~/WA-Agent && git fetch -q && [ $(git rev-parse HEAD) != $(git rev-parse @{u}) ] && git pull -q && pm2 restart wa-agent
```

## Do I need a domain?

**No.** Oracle gives you a public IP, and with the SSH-tunnel approach above
you don't even need that — `http://localhost:3000` just works. Nothing to
purchase.

If you later want a pretty address, grab a free subdomain at
[duckdns.org](https://www.duckdns.org) (e.g. `wa-agent.duckdns.org`, free
forever) and point it at your VM's IP. You only need HTTPS/a domain if you
expose the dashboard to the internet — which you don't need for personal use.

## Security note

The WA-Agent dashboard has **no login screen**. That's why this guide keeps
port 3000 closed and uses the SSH tunnel. Don't open port 3000 to the world
unless you add authentication in front of it.
