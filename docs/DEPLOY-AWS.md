# Deploying to the AWS dev server

Target: `ubuntu@65.1.106.31` (ap-south-1, woohoo-dev)

The Docker image has been built and smoke-tested locally — it starts healthy and serves turns.
These steps are the transfer and run, not a debugging exercise.

---

## Step 0 — The key

The key lives at `cloud_deployment/woohoo-dev.pem`. It is excluded by both `.gitignore` and
`.dockerignore`, so it will not be committed or copied into a container image — but it is still a
private key sitting in a working directory, so do not share the folder or force-add it.

**Windows refuses a key with loose permissions, and `chmod` does nothing here.** Already applied,
but if you ever re-copy the file:

```powershell
$KEY = "cloud_deployment\woohoo-dev.pem"
icacls $KEY /inheritance:r
icacls $KEY /grant:r "$($env:USERNAME):(R)"
```

Test the connection:

```powershell
ssh -i cloud_deployment\woohoo-dev.pem ubuntu@65.1.106.31
```

| What you see | Means |
|---|---|
| A shell prompt | Working — go to Step 2 |
| `Permissions ... too open` | Redo the `icacls` above |
| Hangs, then times out | Security group isn't allowing your IP on 22 — Step 1 |
| `Connection refused` | Instance is stopped, or SSH isn't running |
| `Permission denied (publickey)` | Wrong key, or the user isn't `ubuntu` (try `ec2-user`) |

### Confirm the server matches what we asked for

Once in, check it yourself rather than waiting for an answer:

```bash
# instance type, region, whether the IP is elastic
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-type; echo
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region; echo

nproc                    # expect 2
free -h                  # expect ~8 GB (t3.large) — 4 GB is t3.medium, workable
df -h /                  # expect ~100 GB
ulimit -n                # 1024 by default — Step 2 raises it
curl -s -o /dev/null -w '%{http_code}\n' https://generativelanguage.googleapis.com
                         # any HTTP code = outbound internet works (needed for Gemini)
```

---

## Step 1 — Ask your colleague to open the ports

Send this:

> Could you add these inbound rules to the woohoo-dev security group?
>
> | Port | Source | Purpose |
> |------|--------|---------|
> | 22 | my IP | SSH |
> | 8443 | my IP | app, initial testing |
> | 80 | 0.0.0.0/0 | Let's Encrypt validation (once we have a domain) |
> | 443 | 0.0.0.0/0 | app over TLS (once we have a domain) |
>
> Ports 80 and 443 can wait until the domain is ready. 22 and 8443 restricted to my IP is enough
> to start.

Get your public IP with `curl ifconfig.me`.

---

## Step 2 — Prepare the server

SSH in, then run this once:

```bash
# Docker + Compose plugin, from Docker's own repo (Ubuntu's packaged version is old)
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Run docker without sudo
sudo usermod -aG docker ubuntu

# Start on boot
sudo systemctl enable --now docker
```

**Log out and back in** for the group change to apply, then confirm:

```bash
docker --version && docker compose version
```

### Raise the file-descriptor limit

Default is 1024, which caps you at roughly 1,000 device connections. Do this now — it needs a
reboot and you don't want to discover it later.

```bash
echo -e "* soft nofile 65535\n* hard nofile 65535" | sudo tee -a /etc/security/limits.conf
echo -e "[Service]\nLimitNOFILE=65535" | sudo tee /etc/systemd/system/docker.service.d/override.conf
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo systemctl daemon-reload && sudo systemctl restart docker
```

Create the app directory:

```bash
sudo mkdir -p /opt/woohoo && sudo chown ubuntu:ubuntu /opt/woohoo
```

---

## Step 3 — Get the code onto the server

The repo isn't pushed yet, so ship a tarball. **Run this from your Windows machine**, in Git Bash
(not PowerShell — the `tar` flags differ):

```bash
cd /c/Users/adhit/Documents/GitHub/woohoo_v2

tar --exclude=node_modules \
    --exclude=.git \
    --exclude=docs \
    --exclude='*.pdf' \
    -czf /tmp/woohoo.tar.gz .

scp -i ~/.ssh/woohoo-dev.pem /tmp/woohoo.tar.gz ubuntu@65.1.106.31:/opt/woohoo/
```

Excluding `node_modules` matters: it is 69 MB of **Windows-built binaries** that would break inside
a Linux container. The image installs its own.

Then on the server:

```bash
cd /opt/woohoo && tar -xzf woohoo.tar.gz && rm woohoo.tar.gz && ls
```

> **Better, once you've pushed to a private repo:** `git clone` with a deploy key, and updates
> become `git pull && docker compose up -d --build`. Do that when you're ready — the tarball is
> for today.

---

## Step 4 — Configure

```bash
cd /opt/woohoo
cp .env.example .env
nano .env
```

Set one value:

```
GOOGLE_API_KEY=<your key from aistudio.google.com>
```

Leave everything else. **Without the key the service runs on the built-in mock** — which is
genuinely useful for the first deploy, because it proves the plumbing works before the AI is in
the picture. Deploy without it first if you prefer.

```bash
chmod 600 .env
```

---

## Step 5 — Build and run

The app currently keeps everything in memory — it doesn't use Postgres, Redis, NATS or MinIO yet.
Starting them would consume ~2 GB for nothing, so run just the gateway:

```bash
cd /opt/woohoo
docker compose up -d --build device-gateway
```

First build takes 2–4 minutes. Then:

```bash
docker compose ps          # expect: Up (healthy)
docker compose logs -f device-gateway
```

Expected log:

```
device-gateway listening on ws://localhost:8443  (llm=mock)
```

If it says `(llm=mock)` and you set a key, the `.env` isn't being read — check the file is at
`/opt/woohoo/.env`.

---

## Step 6 — Verify

**On the server:**

```bash
curl -s localhost:8443/health
# {"status":"ok","connections":0,"uptimeS":13}

curl -s -X POST localhost:8443/v1/turn \
  -H 'content-type: application/json' \
  -d '{"deviceId":"d_511a","transcript":"close the curtains and make it warmer"}'
```

Expected:

```json
{"speech":"Curtains closed. I've set it to 22.5 degrees.","lane":"agentic",
 "calls":[{"tool":"curtains.set","verdict":"ALLOW","ok":true},
          {"tool":"climate.set_temperature","verdict":"ALLOW","ok":true}]}
```

**From your machine** (confirms the security group):

```bash
curl -s http://65.1.106.31:8443/health
```

If the server responds locally but not remotely, it's the security group, not the app.

---

## Step 7 — Domain and TLS

Do this when the domain is ready. **Android requires `wss://`**, so the device cannot connect over
plain HTTP — this step is mandatory before any real device testing.

Point an A record at the server:

```
gateway.<yourdomain>   A   65.1.106.31
```

Then add Caddy, which obtains and renews a Let's Encrypt certificate automatically.

`/opt/woohoo/Caddyfile`:

```
gateway.<yourdomain> {
    reverse_proxy device-gateway:8443
}
```

`/opt/woohoo/docker-compose.override.yml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    restart: unless-stopped
    depends_on:
      - device-gateway

  device-gateway:
    ports: []          # no longer exposed directly; Caddy fronts it

volumes:
  caddy_data:
```

```bash
docker compose up -d
curl -s https://gateway.<yourdomain>/health
```

Then close 8443 in the security group — traffic goes through 443 from here on.

---

## Day-to-day

```bash
docker compose logs -f device-gateway     # follow logs
docker compose restart device-gateway     # restart
docker compose up -d --build              # deploy an update
docker stats --no-stream                  # memory and CPU
```

Update flow once the code is on the server:

```bash
cd /opt/woohoo
# re-upload the tarball, or: git pull
docker compose up -d --build device-gateway
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Permissions for '...pem' are too open` | Windows ACLs | Redo the `icacls` step |
| SSH hangs | Security group | Port 22 not open to your IP |
| `tsx: not found` in logs | Old image cached | `docker compose build --no-cache device-gateway` |
| `permission denied ... docker.sock` | Group not applied | Log out and back in |
| Health OK locally, fails remotely | Security group | Port 8443 not open |
| `(llm=mock)` unexpectedly | `.env` not loaded | Check `/opt/woohoo/.env` exists |
| Container restarts repeatedly | Crash on boot | `docker compose logs --tail=50 device-gateway` |

---

## Known limits of this deployment

Worth stating plainly so nobody plans around capabilities it doesn't have:

- **Single instance.** Session state, pending confirmations and the device-state cache are all
  in-process. Do not put this behind an auto-scaling group — two instances would disagree about
  live conversations, and a payment confirmation minted on one could not be redeemed on the other.
- **No database yet.** All state is in memory and is **lost on restart**. The Postgres schema
  exists; the repository implementations do not.
- **No speech.** The service accepts text. Wake word and speech recognition remain on the Android
  device for now.
- **Mock AI unless a key is set.** Deliberate — the stack is fully testable without one.
- **No redundancy.** One reboot takes everything offline. Fine for a dev server; the fix is the
  same in-memory-state work that unblocks scaling.
