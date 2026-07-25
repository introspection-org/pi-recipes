# Vercel Sandbox

Recipes need a writable POSIX workspace and a real shell for the `bash`
tool, which rules out edge/isolate runtimes — so on Vercel the served
recipe runs in **Vercel Sandbox** (Firecracker microVMs), not plain
functions. (The same constraint applies to Cloudflare: containers, not
Workers.)

```bash
npm install @vercel/sandbox
node vercel_sandbox.mjs
```

See [`vercel_sandbox.mjs`](vercel_sandbox.mjs). The sandbox domain it
prints fronts port 8888 — that is the Tasks API base URL.
