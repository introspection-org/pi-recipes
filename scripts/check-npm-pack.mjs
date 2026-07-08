#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const packed = JSON.parse(input);
  const files = packed.flatMap((entry) =>
    Array.isArray(entry.files) ? entry.files.map((file) => file.path) : []
  );
  const forbidden = files.filter((path) =>
    path.startsWith("harbor/jobs/") ||
    path.includes("/__pycache__/") ||
    path.startsWith("harbor/__pycache__/") ||
    /\.py[cod]$/i.test(path)
  );
  if (forbidden.length > 0) {
    console.error("npm package includes generated Harbor output:");
    for (const path of forbidden) console.error(`- ${path}`);
    process.exitCode = 1;
  }
});
