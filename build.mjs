import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { marked } from "marked";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = path.join(ROOT, "notes");
const ATTACHMENTS_DIR = path.join(NOTES_DIR, "attachments");
const WRITING_DIR = path.join(ROOT, "writing");
const ASSETS_NOTES_DIR = path.join(ROOT, "assets", "images", "notes");
const TEMPLATE_PATH = path.join(ROOT, "templates", "article.html");
const INDEX_PATH = path.join(ROOT, "index.html");

const ARTICLES_START = "<!-- ARTICLES:START -->";
const ARTICLES_END = "<!-- ARTICLES:END -->";

const CATEGORIES = {
  essay: { label: "随笔" },
  observation: { label: "观察" },
  practice: { label: "实践" }
};

const CATEGORY_ALIASES = {
  essay: "essay",
  "随笔": "essay",
  observation: "observation",
  "观察": "observation",
  practice: "practice",
  "实践": "practice"
};

marked.setOptions({ gfm: true, breaks: false });

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) =>
    Object.hasOwn(values, key) ? values[key] : ""
  );
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }

  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== iso) {
    return null;
  }
  return iso;
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function plainText(html) {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z#0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(html) {
  const text = plainText(html);
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

async function walk(dir, { skipDirs = new Set() } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) || entry.name.startsWith("_")) continue;
      files.push(...(await walk(fullPath, { skipDirs })));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function splitOutsideCode(markdown, transform) {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((chunk, index) => (index % 2 === 1 ? chunk : transform(chunk)))
    .join("");
}

function createAttachmentStore() {
  const byPath = new Map();
  const byName = new Map();
  const copiedBySource = new Map();
  const copiedByDest = new Map();

  async function load() {
    const files = await walk(ATTACHMENTS_DIR);
    for (const file of files) {
      const relative = path.relative(ATTACHMENTS_DIR, file).split(path.sep).join("/");
      byPath.set(relative, file);
      const base = path.basename(file);
      if (!byName.has(base)) {
        byName.set(base, file);
      } else if (byName.get(base) !== file) {
        byName.set(base, null);
      }
    }
  }

  async function resolve(ref, noteDir) {
    const cleaned = String(ref ?? "")
      .trim()
      .replace(/^<|>$/g, "")
      .replace(/^\.\//, "");

    let decoded = cleaned;
    try {
      decoded = decodeURIComponent(cleaned);
    } catch {
      // Keep the original when a reference is not valid percent-encoding.
    }

    const relative = decoded.replace(/^attachments\//, "");
    if (byPath.has(relative)) return byPath.get(relative);

    const base = path.basename(relative);
    if (byName.has(base)) {
      const match = byName.get(base);
      if (!match) {
        throw new Error(`附件重名，请改名后再试：${base}`);
      }
      return match;
    }

    const local = path.resolve(noteDir, decoded);
    try {
      const stat = await fs.stat(local);
      if (stat.isFile()) return local;
    } catch {
      // Not a file next to the note.
    }

    return null;
  }

  async function copy(file) {
    if (copiedBySource.has(file)) return copiedBySource.get(file);

    const base = path.basename(file);
    if (copiedByDest.has(base) && copiedByDest.get(base) !== file) {
      throw new Error(`不同目录下有同名图片，请改名后再试：${base}`);
    }

    await fs.mkdir(ASSETS_NOTES_DIR, { recursive: true });
    await fs.copyFile(file, path.join(ASSETS_NOTES_DIR, base));
    copiedBySource.set(file, base);
    copiedByDest.set(base, file);
    return base;
  }

  return { load, resolve, copy };
}

async function rewriteImages(markdown, noteDir, attachments, warnings, label) {
  const wikis = [];
  let result = splitOutsideCode(markdown, (chunk) =>
    chunk.replace(/!\[\[([^\]]+)\]\]/g, (_, inner) => {
      const [rawRef, ...rawOptions] = inner.split("|");
      const token = `\u0000WIKI_${wikis.length}\u0000`;
      wikis.push({
        token,
        ref: rawRef.trim(),
        option: rawOptions.join("|").trim()
      });
      return token;
    })
  );

  for (const wiki of wikis) {
    const file = await attachments.resolve(wiki.ref, noteDir);
    let replacement;

    if (!file) {
      warnings.push(`${label}：找不到图片 ${wiki.ref}`);
      replacement = `![[${wiki.ref}]]`;
    } else {
      const base = await attachments.copy(file);
      const width = /^\d+$/.test(wiki.option) ? ` width="${wiki.option}"` : "";
      const alt = wiki.option && !width
        ? wiki.option
        : path.basename(base, path.extname(base));
      replacement = `<img src="../assets/images/notes/${encodeURIComponent(base)}" alt="${escapeHtml(alt)}"${width} loading="lazy" />`;
    }

    result = result.replace(wiki.token, () => replacement);
  }

  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const imageMatches = [...result.matchAll(imagePattern)];
  for (const match of imageMatches) {
    const [original, alt, rawSrc] = match;
    if (/^(https?:|data:|\/|#)/i.test(rawSrc)) continue;
    if (/^(\.\.\/)?assets\//.test(rawSrc)) continue;

    const file = await attachments.resolve(rawSrc, noteDir);
    if (!file) {
      warnings.push(`${label}：找不到图片 ${rawSrc}`);
      continue;
    }

    const base = await attachments.copy(file);
    const replacement = `![${alt}](../assets/images/notes/${encodeURIComponent(base)})`;
    result = result.replace(original, () => replacement);
  }

  return result;
}

async function resolveCover(value, noteDir, attachments, warnings, label) {
  if (!value) return null;

  const cover = String(value).trim();
  if (!cover) return null;
  if (/^(https?:)?\/\//i.test(cover) || cover.startsWith("data:")) return cover;
  if (cover.startsWith("assets/")) return cover;
  if (cover.startsWith("/assets/")) return cover.slice(1);
  if (cover.startsWith("../assets/")) return cover.replace(/^\.\.\//, "");

  const file = await attachments.resolve(cover, noteDir);
  if (!file) {
    warnings.push(`${label}：找不到封面图 ${cover}`);
    return null;
  }

  const base = await attachments.copy(file);
  return `assets/images/notes/${encodeURIComponent(base)}`;
}

function renderPager(index, articles) {
  const newer = index > 0 ? articles[index - 1] : null;
  const older = index < articles.length - 1 ? articles[index + 1] : null;

  const left = newer
    ? `        <a class="pager-link pager-prev" href="${encodeURIComponent(newer.slug)}.html">
          <span class="pager-label">← 上一篇</span>
          <span class="pager-title">${escapeHtml(newer.title)}</span>
        </a>`
    : `        <span class="pager-placeholder">
          <span class="pager-label">首篇</span>
          <span class="pager-title">已是最新一篇</span>
        </span>`;

  const right = older
    ? `        <a class="pager-link pager-next" href="${encodeURIComponent(older.slug)}.html">
          <span class="pager-label">下一篇 →</span>
          <span class="pager-title">${escapeHtml(older.title)}</span>
        </a>`
    : `        <span class="pager-placeholder">
          <span class="pager-label">末篇</span>
          <span class="pager-title">已是最早一篇</span>
        </span>`;

  return `${left}\n${right}`;
}

function renderCard(article) {
  const cover = article.cover
    ? `\n            <span class="shelf-cover"><img src="${escapeHtml(article.cover)}" alt="${escapeHtml(article.coverAlt)}" loading="lazy" /></span>`
    : "";
  const itemClass = article.cover ? "shelf-item" : "shelf-item no-cover";

  return `        <li data-cat="${article.category}">
          <a class="${itemClass}" href="writing/${encodeURIComponent(article.slug)}.html">${cover}
            <div class="shelf-text">
              <h3 class="shelf-item-title">${escapeHtml(article.title)}</h3>
              <p class="shelf-summary">${escapeHtml(article.summary)}</p>
              <p class="shelf-meta">
                <span class="shelf-cat">${article.categoryLabel}</span>
                <span class="sep">·</span>
                <span>${article.dateDisplay}</span>
                <span class="sep">·</span>
                <span>约 ${article.reading} 分钟</span>
                <span class="sep">·</span>
                <span>${article.words} 字</span>
              </p>
            </div>
            <span class="shelf-arrow" aria-hidden="true">↗</span>
          </a>
        </li>`;
}

async function main() {
  const attachments = createAttachmentStore();
  await attachments.load();
  await fs.mkdir(WRITING_DIR, { recursive: true });
  await fs.rm(ASSETS_NOTES_DIR, { recursive: true, force: true });
  await fs.mkdir(ASSETS_NOTES_DIR, { recursive: true });

  const template = await fs.readFile(TEMPLATE_PATH, "utf8");
  const noteFiles = (await walk(NOTES_DIR, { skipDirs: new Set(["attachments"]) }))
    .filter((file) => file.endsWith(".md"))
    .sort();

  if (!noteFiles.length) {
    throw new Error("notes 目录里还没有 Markdown 文章。");
  }

  const articles = [];
  const warnings = [];
  const slugs = new Set();

  for (const file of noteFiles) {
    const label = path.relative(ROOT, file);
    let parsed;
    try {
      parsed = matter(await fs.readFile(file, "utf8"));
    } catch (error) {
      throw new Error(`${label} 的 frontmatter 解析失败：${error.message}`);
    }

    const { data, content } = parsed;
    if (data.draft === true) continue;

    const stem = path.basename(file, ".md");
    const slug = slugify(data.slug || stem);
    if (!slug) {
      throw new Error(`${label}：slug 为空，请设置一个英文或中文短名。`);
    }
    if (slugs.has(slug)) {
      throw new Error(`${label}：slug 与另一篇文章重复（${slug}）。`);
    }
    slugs.add(slug);

    const date = normalizeDate(data.date);
    if (!date) {
      throw new Error(`${label}：date 必须是 YYYY-MM-DD，例如 2026-10-23。`);
    }

    const category = CATEGORY_ALIASES[String(data.category || "essay")];
    if (!category) {
      throw new Error(`${label}：category 只能是 essay / observation / practice，或随笔 / 观察 / 实践。`);
    }

    const title = String(data.title || stem).trim();
    const noteDir = path.dirname(file);
    const withImages = await rewriteImages(content, noteDir, attachments, warnings, label);
    const bodyHtml = marked.parse(withImages).trim();
    const lead = data.lead ? String(data.lead).trim() : "";
    const leadHtml = lead ? `        <p class="article-lead">${marked.parseInline(lead)}</p>\n` : "";
    const bodyForCount = `${leadHtml}${bodyHtml}`;
    const words = countWords(bodyForCount);
    const reading = Math.max(1, Math.round(words / 400));
    const summary = String(
      data.summary || plainText(bodyHtml).slice(0, 60)
    ).trim();
    const description = String(data.description || summary).replace(/\s+/g, " ").trim();
    const cover = await resolveCover(data.cover, noteDir, attachments, warnings, label);
    const coverAlt = String(data.cover_alt || title).trim();

    let contentHtml = bodyHtml;
    if (!lead && contentHtml.startsWith("<p>")) {
      contentHtml = contentHtml.replace("<p>", '<p class="article-lead">');
    }
    if (data.signature !== false && !/——\s*Ethan\s*<\/p>\s*$/.test(contentHtml)) {
      contentHtml += '\n        <p class="signature">—— Ethan</p>';
    }

    articles.push({
      slug,
      title,
      date,
      dateDisplay: date.replaceAll("-", "."),
      category,
      categoryLabel: CATEGORIES[category].label,
      summary,
      description,
      words,
      reading,
      cover,
      coverAlt,
      leadHtml,
      contentHtml
    });
  }

  articles.sort(
    (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)
  );

  for (let index = 0; index < articles.length; index += 1) {
    const article = articles[index];
    const html = fill(template, {
      TITLE: escapeHtml(article.title),
      DESCRIPTION: escapeHtml(article.description),
      CATEGORY: article.category,
      CATEGORY_LABEL: article.categoryLabel,
      DATE: article.dateDisplay,
      READING: String(article.reading),
      WORDS: String(article.words),
      BODY: `${article.leadHtml}${article.contentHtml}`,
      PAGER: renderPager(index, articles)
    });

    await fs.writeFile(
      path.join(WRITING_DIR, `${article.slug}.html`),
      html,
      "utf8"
    );
  }

  const keep = new Set(articles.map((article) => `${article.slug}.html`));
  for (const entry of await fs.readdir(WRITING_DIR)) {
    if (entry.endsWith(".html") && !keep.has(entry)) {
      await fs.rm(path.join(WRITING_DIR, entry));
    }
  }

  const indexHtml = await fs.readFile(INDEX_PATH, "utf8");
  const articleBlock = new RegExp(
    `([ \\t]*)${ARTICLES_START}[\\s\\S]*?${ARTICLES_END}`
  );
  const blockMatch = indexHtml.match(articleBlock);
  if (!blockMatch) {
    throw new Error("index.html 缺少 <!-- ARTICLES:START --> 或 <!-- ARTICLES:END --> 标记。");
  }

  const indent = blockMatch[1] || "        ";
  const cards = articles.map(renderCard).join("\n");
  const replacement = `${indent}${ARTICLES_START}\n${cards}\n${indent}${ARTICLES_END}`;
  const updatedIndex = indexHtml.replace(articleBlock, () => replacement);
  await fs.writeFile(INDEX_PATH, updatedIndex, "utf8");

  for (const warning of warnings) {
    console.warn(`警告：${warning}`);
  }

  console.log(`已生成 ${articles.length} 篇文章：`);
  for (const article of articles) {
    console.log(`  ${article.dateDisplay}  ${article.title}  →  writing/${article.slug}.html`);
  }
}

main().catch((error) => {
  console.error(`构建失败：${error.message}`);
  process.exit(1);
});
