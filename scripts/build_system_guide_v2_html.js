const fs = require("node:fs");

const inputPath = "/Users/yanren/Documents/Playground/System_Guide_学生_TAAdmin_CourseAdmin_v2.md";
const outputPath = "/Users/yanren/Documents/Playground/System_Guide_学生_TAAdmin_CourseAdmin_v2.html";

const source = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
const parts = [];
let inList = false;

function closeList() {
  if (inList) {
    parts.push("</ul>");
    inList = false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineFormat(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

for (const rawLine of source) {
  const line = rawLine.trim();
  if (!line) {
    closeList();
    continue;
  }

  const imageMatch = line.match(/^!\[(.*)\]\((.*)\)$/);
  if (imageMatch) {
    closeList();
    const alt = escapeHtml(imageMatch[1]);
    const src = imageMatch[2];
    parts.push(`<p><img src="${src}" alt="${alt}" style="max-width: 920px; width: 100%; border: 1px solid #dfe3eb; border-radius: 12px;" /></p>`);
    continue;
  }

  if (line.startsWith("### ")) {
    closeList();
    parts.push(`<h3>${inlineFormat(line.slice(4))}</h3>`);
    continue;
  }

  if (line.startsWith("## ")) {
    closeList();
    parts.push(`<h2>${inlineFormat(line.slice(3))}</h2>`);
    continue;
  }

  if (line.startsWith("# ")) {
    closeList();
    parts.push(`<h1>${inlineFormat(line.slice(2))}</h1>`);
    continue;
  }

  if (line.startsWith("- ")) {
    if (!inList) {
      parts.push("<ul>");
      inList = true;
    }
    parts.push(`<li>${inlineFormat(line.slice(2))}</li>`);
    continue;
  }

  if (/^\d+\.\s/.test(line)) {
    closeList();
    parts.push(`<p>${inlineFormat(line)}</p>`);
    continue;
  }

  closeList();
  parts.push(`<p>${inlineFormat(line)}</p>`);
}

closeList();

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>TA选课系统使用手册</title>
  <style>
    body {
      font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #202124;
      line-height: 1.7;
      margin: 40px auto;
      max-width: 980px;
      padding: 0 24px 60px;
      background: #fffdfa;
    }
    h1 { font-size: 30px; margin: 0 0 24px; }
    h2 { font-size: 22px; margin: 30px 0 12px; }
    h3 { font-size: 18px; margin: 22px 0 10px; }
    p { margin: 0 0 10px; }
    ul { margin: 0 0 14px 20px; padding: 0; }
    li { margin: 0 0 6px; }
    code {
      background: #f3f6fb;
      padding: 2px 6px;
      border-radius: 6px;
      font-family: Menlo, Monaco, monospace;
      font-size: 0.95em;
    }
    img { margin: 8px 0 18px; box-shadow: 0 8px 28px rgba(0,0,0,0.06); }
  </style>
</head>
<body>
${parts.join("\n")}
</body>
</html>`;

fs.writeFileSync(outputPath, html, "utf8");
console.log(outputPath);
