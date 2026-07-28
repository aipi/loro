// Loro — reference & front-matter helpers (ADR-0009). Isolated, testable module:
// loaded in the browser via <script> (defines window.LoroRefs) and in Node via
// require(). PURE string logic — no DOM, no deps, and deliberately NO YAML
// library (no-bundler constraint). Everything here must be TOTAL: malformed
// front-matter degrades to plain text upstream (ADR-0009), so nothing throws.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroRefs = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Split a leading `---\n … \n---\n` front-matter block from the body.
  // A block is only recognized when it both starts with `---` and is terminated
  // by a later line that is exactly `---`; an unterminated block is NOT a block
  // (it degrades to plain body) so a stray `---` at the top never eats content.
  function splitFrontMatter(text) {
    const s = String(text == null ? "" : text);
    const lines = s.split(/\r?\n/);
    if (lines[0] !== "---") return { frontMatter: null, body: s };
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        return { frontMatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
      }
    }
    return { frontMatter: null, body: s };
  }

  function stripQuotes(v) {
    const t = v.trim();
    if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
      return t.slice(1, -1);
    }
    return t;
  }

  // `{id: r1, tipo: image, caminho: acervo://…}` — split on commas (our paths
  // carry no commas), then on the FIRST colon so `acervo://` values survive.
  function parseInlineObj(s) {
    const obj = {};
    const inner = s.trim().replace(/^\{/, "").replace(/\}$/, "");
    for (const pair of inner.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim();
      if (k) obj[k] = stripQuotes(pair.slice(idx + 1));
    }
    return obj;
  }

  // A block/inline list under `refs:` / `audio:`: items are either an inline
  // object (`- {…}`) or a block object whose keys continue on indented lines.
  function parseList(children) {
    const arr = [];
    let cur = null;
    for (const raw of children) {
      const dash = raw.match(/^\s*-\s*(.*)$/);
      if (dash) {
        const rest = dash[1].trim();
        cur = null;
        if (/^\{.*\}$/.test(rest)) {
          arr.push(parseInlineObj(rest));
        } else {
          const kv = rest.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (kv) {
            cur = {};
            cur[kv[1]] = stripQuotes(kv[2]);
            arr.push(cur);
          } else if (rest !== "") {
            arr.push(stripQuotes(rest));
          }
        }
      } else if (cur) {
        const kv = raw.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/);
        if (kv) cur[kv[1]] = stripQuotes(kv[2]);
      }
    }
    return arr;
  }

  // A nested scalar map (e.g. `promovido:` → para/branch/em).
  function parseMap(children) {
    const obj = {};
    for (const raw of children) {
      const kv = raw.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/);
      if (kv) obj[kv[1]] = stripQuotes(kv[2]);
    }
    return obj;
  }

  // Minimal, tolerant YAML-subset covering exactly our living-file shape
  // (loro,id,tema,criado_em,atualizado_em,refs[],audio[],promovido{}).
  // Unknown/junk lines are skipped; anything unparseable yields {} — never throws.
  function parseFrontMatter(fmText) {
    const out = {};
    try {
      if (fmText == null) return out;
      const lines = String(fmText).split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        // only top-level (unindented) `key:` lines open an entry
        const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!m) { i++; continue; }
        const key = m[1];
        const rest = m[2].trim();
        if (rest === "") {
          // gather the indented block that belongs to this key
          const children = [];
          let j = i + 1;
          while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === "")) {
            if (lines[j].trim() !== "") children.push(lines[j]);
            j++;
          }
          if (children.length && /^\s*-/.test(children[0])) out[key] = parseList(children);
          else if (children.length) out[key] = parseMap(children);
          else out[key] = "";
          i = j;
          continue;
        }
        if (/^\[.*\]$/.test(rest)) {
          const inner = rest.slice(1, -1).trim();
          out[key] = inner === "" ? [] : inner.split(",").map(stripQuotes);
        } else if (/^\{.*\}$/.test(rest)) {
          out[key] = parseInlineObj(rest);
        } else {
          out[key] = stripQuotes(rest);
        }
        i++;
      }
    } catch (_e) {
      return {};
    }
    return out;
  }

  // A ref is EITHER the canonical anchored `acervo://<rel-from-root>` or a path
  // relative to the source file's dir.
  function parseRef(str) {
    const s = String(str == null ? "" : str);
    const m = s.match(/^acervo:\/\/(.*)$/);
    return m ? { scheme: "acervo", path: m[1] } : { scheme: "relative", path: s };
  }

  // Resolve `relPath` against `sourceRel`'s directory into an acervo-root-relative
  // path (mirrors brain_resolve_ref's relative case so the UI can pre-compute).
  // ESCAPE POLICY: a `..` that would climb above the acervo root is DROPPED
  // (clamp-to-root) — the result never contains `..` and can never point above
  // the root. A leading slash is treated as acervo-root-relative.
  function resolveRelative(sourceRel, relPath) {
    const rel = String(relPath == null ? "" : relPath);
    const base = rel.startsWith("/") ? [] : String(sourceRel == null ? "" : sourceRel).split("/").slice(0, -1);
    const out = [];
    for (const p of base.concat(rel.split("/"))) {
      if (p === "" || p === ".") continue;
      if (p === "..") { if (out.length) out.pop(); continue; }
      out.push(p);
    }
    return out.join("/");
  }

  // Single source of truth for ref dispatch: doc opens a tab, image renders
  // inline via brain_read_asset, audio/other open externally (ADR-0009).
  function tipoFromExt(pathOrName) {
    const s = String(pathOrName == null ? "" : pathOrName);
    const dot = s.lastIndexOf(".");
    const ext = dot === -1 ? "" : s.slice(dot + 1).toLowerCase();
    if (ext === "md" || ext === "txt") return "doc";
    if (["svg", "png", "jpg", "jpeg", "gif", "webp"].indexOf(ext) !== -1) return "image";
    if (["wav", "webm", "mp3", "m4a"].indexOf(ext) !== -1) return "audio";
    return "other";
  }

  // Look up a ref by id across both the refs and audio lists.
  function findRef(frontMatterObj, id) {
    if (!frontMatterObj) return null;
    const want = String(id);
    for (const list of [frontMatterObj.refs, frontMatterObj.audio]) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (r && typeof r === "object" && String(r.id) === want) return r;
      }
    }
    return null;
  }

  return { splitFrontMatter, parseFrontMatter, parseRef, resolveRelative, tipoFromExt, findRef };
});
