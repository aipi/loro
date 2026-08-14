#!/usr/bin/env node
// Retrieval-efficiency bench over the real acervo.
//
// Question it answers: does the new reading protocol (section-0 cards + link
// anchor text + qualified locator) find the right source reading FEWER bytes
// than today's protocol (INDEX.md -> open the whole context.md)?
//
// No external dependency, no network, nothing written into the acervo (BR-1).
// The acervo is opened read-only.
//
// The question set and the output stay OUTSIDE this repository, and both paths
// are required arguments. A question carries its ground-truth evidence — a
// literal fragment of somebody's knowledge base — so committing it here would
// reproduce another project's confidential content in this one. The bench is
// the tool; the corpus and the questions belong to whoever owns the acervo.
//
// Usage:
//   node tools/retrieval-bench.js --acervo <path> --questions <path> [--out <path>] [--json]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
// No default: a bench that silently points at somebody's knowledge base is one
// that gets run by accident.
const USAGE = 'usage: node tools/retrieval-bench.js --acervo <path> --questions <path> [--out <path>] [--json]';
const MAX_OPENS = 10; // a person gives up long before this

// ---------------------------------------------------------------- tokenizing

// Deliberately minimal: pt-BR function words only. No stemming, no NLP —
// the protocol is supposed to win by structure, not by clever matching.
const STOPWORDS = new Set(
  ('a o as os um uma uns umas de do da dos das em no na nos nas por para com que se e ou ' +
   'qual quais quanto quanta quantos quantas quem como onde quando pra pro ao aos ' +
   'e eh sao ter tem tenho meu minha nosso nossa isso isto esse essa este esta ' +
   'ele ela eles elas nao sim ja mais menos muito depois antes sobre entre ate ' +
   'tambem hoje ainda so sua seu suas seus lhe nem foi ser esta estao vai gente')
    .split(/\s+/)
);

function fold(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Heading title vs card label: same words, different punctuation and case.
function norm(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(s) {
  const out = [];
  for (const t of fold(s).split(/[^a-z0-9]+/)) {
    if (!t) continue;
    if (t.length < 3 && !/^\d+$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function termFreq(text) {
  const tf = new Map();
  for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

// ------------------------------------------------------------------- reading

function listContexts(acervo) {
  const root = path.join(acervo, 'contextos');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'context.md') found.push(full);
    }
  };
  walk(root);
  return found;
}

// The section-0 card: from "## 0" up to the next "## " heading.
function extractCard(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## 0\b/.test(l) || /^## 0\s*·/.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n').trim();
}

// Every "## n" block, keyed by n. Section 0 included so a jump can land on the card.
function extractSections(text) {
  const lines = text.split('\n');
  const sections = new Map();
  let key = 'preamble';
  let buf = [];
  for (const l of lines) {
    const m = /^## (\d+)\b/.exec(l);
    if (m) {
      sections.set(key, buf.join('\n'));
      key = m[1];
      buf = [l];
    } else buf.push(l);
  }
  sections.set(key, buf.join('\n'));
  return sections;
}

// The §0 card carries ONE line per section, written by the loop as that section's
// abstract. So the card is already a section router — and matching a question
// against a 40-word abstract beats matching it against 6.000 words of section
// body, where the signal dilutes. The mapping is by the section's own heading
// text, not by a hardcoded list, so it survives a renamed title and both
// languages.
function extractCardBySection(cardText, sections) {
  const titles = new Map(); // normalized heading title -> section key
  for (const [key, text] of sections) {
    if (key === 'preamble' || key === '0') continue;
    const h = /^## \d+\s*[·.\-]?\s*(.+)$/m.exec(text);
    if (h) titles.set(norm(h[1]), key);
  }
  const bySection = new Map();
  for (const line of cardText.split('\n')) {
    const m = /^\s*[-*]\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/.exec(line);
    if (!m) continue;
    const label = norm(m[1]);
    let key = titles.get(label);
    if (key === undefined) {
      for (const [title, k] of titles) {
        if (title.startsWith(label) || label.startsWith(title)) { key = k; break; }
      }
    }
    if (key !== undefined) bySection.set(key, (bySection.get(key) || '') + ' ' + m[2]);
  }
  return bySection;
}

// The 6-section mold is FIXED by the template, so what the question ASKS for is a
// legitimate prior on where the answer lives. This is not NLP: it is the reader
// knowing the shape of its own document. Each entry is a small nudge, never a
// decision — a prior that overrides the text would answer from its own prejudice.
const SECTION_PRIOR = [
  { re: /\bpor\s*qu|\bporqu|\bmotivo|\brazao|\bdecidi|\bmudou|\bwhy\b/i, boost: { '5': 0.35, '2': 0.15 } },
  { re: /\bquanto|\bqual\s+(o\s+)?(valor|preco|multa|taxa|percentual|prazo)|\bcusta|\bhow much/i, boost: { '2': 0.35, '5': 0.2 } },
  { re: /\bcomo\s+funciona|\bfluxo|\betapa|\bpasso|\bjornada|\bo que acontece|\bhow does/i, boost: { '3': 0.3, '2': 0.25 } },
  { re: /\bquem\b|\bqual\s+(time|squad|sistema|servico|fornecedor)|\bdono\b|\bwho\b/i, boost: { '4': 0.4 } },
  { re: /\bem\s+aberto|\bduvida|\bpendente|\bnao\s+se\s+sabe|\bfalta\b|\bunknown|\bopen question/i, boost: { '6': 0.4 } },
];

function priorFor(question) {
  const boost = {};
  for (const p of SECTION_PRIOR) {
    if (!p.re.test(question)) continue;
    for (const [k, v] of Object.entries(p.boost)) boost[k] = (boost[k] || 0) + v;
  }
  return boost;
}

function extractHotspotTitles(text) {
  const titles = [];
  const re = /^>\s*\[!HOTSPOT\]\s*(H-\d+)\s*[—–-]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) titles.push({ id: m[1], title: m[2].trim() });
  return titles;
}

function extractDecisionIds(text) {
  return [...new Set((text.match(/\bD-\d{4}-\d{2}-\d{2}-[a-z0-9-]+/g) || []))];
}

// Markdown links whose target is another context.md, resolved to a rel key.
function extractLinks(text, fileDir, contextosRoot) {
  const links = [];
  const re = /\[([^\]\n]+)\]\(([^)\s]+?\.md)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const anchor = m[1].replace(/[`*_]/g, '').trim();
    const target = m[2];
    if (/^[a-z]+:\/\//i.test(target)) continue;
    const abs = path.resolve(fileDir, target);
    if (path.basename(abs) !== 'context.md') continue;
    if (!abs.startsWith(contextosRoot + path.sep)) continue;
    const rel = path.relative(contextosRoot, path.dirname(abs)).split(path.sep).join('/');
    links.push({ anchor, rel, exists: fs.existsSync(abs) });
  }
  return links;
}

// Parent<->child or sibling under the same parent: a link the tree already
// gives you for free, so it is not a lateral link.
function isKin(a, b) {
  const pa = a.includes('/') ? a.slice(0, a.lastIndexOf('/')) : '';
  const pb = b.includes('/') ? b.slice(0, b.lastIndexOf('/')) : '';
  return pa === b || pb === a || (pa !== '' && pa === pb);
}

function loadCorpus(acervo) {
  const contextosRoot = path.join(acervo, 'contextos');
  const docs = new Map();
  for (const file of listContexts(acervo)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(contextosRoot, path.dirname(file)).split(path.sep).join('/');
    docs.set(rel, {
      rel,
      file,
      text,
      bytes: bytesOf(text),
      card: extractCard(text),
      sections: extractSections(text),
      cardBySection: new Map(),
      hotspots: extractHotspotTitles(text),
      decisions: extractDecisionIds(text),
      links: extractLinks(text, path.dirname(file), contextosRoot),
    });
  }
  // The card's line per section, resolved against that document's own headings.
  for (const d of docs.values()) d.cardBySection = extractCardBySection(d.card, d.sections);
  // Inbound anchor text: how the NEIGHBOUR names the target.
  for (const d of docs.values()) d.inbound = [];
  for (const d of docs.values()) {
    for (const l of d.links) {
      if (l.rel === d.rel) continue;
      const target = docs.get(l.rel);
      if (target) target.inbound.push({ from: d.rel, anchor: l.anchor });
    }
  }
  return docs;
}

// ------------------------------------------------------------------- ranking

// One idf table for the whole bench, built from the full context.md corpus, so
// every strategy is scored on the same yardstick.
function buildIdf(docs) {
  const df = new Map();
  for (const d of docs.values()) {
    for (const t of new Set(tokens(d.text))) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = docs.size;
  return (term) => Math.log(1 + n / (1 + (df.get(term) || 0)));
}

// A score divided by the log of its own length: enough to stop a long block from
// winning on volume, gentle enough not to hand the win to a one-line block.
function byLength(score, text) {
  if (!score) return 0;
  const words = fold(text).split(/[^a-z0-9]+/).length;
  return score / Math.log(50 + words);
}

function scoreText(queryTerms, text, idf) {
  const tf = termFreq(text);
  let s = 0;
  for (const t of queryTerms) {
    const f = tf.get(t);
    if (f) s += idf(t) * (1 + Math.log(f));
  }
  return s;
}

// Deterministic ordering: score desc, then the order the reader meets the
// candidate (index line order / corpus order), then key asc.
function rankEntries(entries) {
  return entries.slice().sort(
    (a, b) => (b.score - a.score) || ((a.ord ?? 0) - (b.ord ?? 0)) || (a.key < b.key ? -1 : 1)
  );
}

// The acervo's INDEX.md is being rewritten as part of this same protocol work,
// so the working tree is not the "before". `git show` reads the committed one
// without touching the repo.
function committedIndex(acervo) {
  try {
    return execFileSync('git', ['-C', acervo, 'show', 'HEAD:INDEX.md'], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function indexEntriesOf(indexText, acervo, docs) {
  const contextosRoot = path.join(acervo, 'contextos');
  const entries = [];
  for (const line of indexText.split('\n')) {
    for (const l of extractLinks(line, acervo, contextosRoot)) {
      if (docs.has(l.rel) && !entries.some((e) => e.rel === l.rel)) entries.push({ rel: l.rel, line });
    }
  }
  return entries;
}

// -------------------------------------------------------------- strategy A

// Today: read INDEX.md, pick the lines that match, open whole context.md files,
// and follow the links you see once a file is open.
function runIndex(q, ctx, idx) {
  const { docs, idf } = ctx;
  const { bytes: indexBytes, entries: indexEntries } = idx;
  const qt = tokens(q.question);

  // Ties fall back to the order the lines appear in INDEX.md — that is what a
  // reader scanning the file top to bottom actually does.
  const frontier = indexEntries.map((e, i) => ({
    key: e.rel,
    score: scoreText(qt, e.line, idf),
    ord: i,
    via: 'INDEX.md',
  }));
  let discovered = indexEntries.length;

  let bytes = indexBytes;
  const opened = [];
  const seen = new Set();
  let rank = 0;
  let hitRank = 0;

  while (opened.length < MAX_OPENS) {
    const ordered = rankEntries(frontier.filter((e) => !seen.has(e.key) && docs.has(e.key)));
    if (!ordered.length) break;
    const next = ordered[0];
    seen.add(next.key);
    const doc = docs.get(next.key);
    bytes += doc.bytes; // today's protocol opens the whole file
    opened.push(next.key);
    rank += 1;
    if (next.key === q.truth.rel) { hitRank = rank; break; }
    // Opening the file reveals its links: the target path and the anchor the
    // author typed. Those become new candidates.
    for (const l of doc.links) {
      if (seen.has(l.rel) || !docs.has(l.rel)) continue;
      if (frontier.some((f) => f.key === l.rel)) continue;
      discovered += 1;
      frontier.push({
        key: l.rel,
        score: scoreText(qt, `${l.anchor} ${l.rel.replace(/[/-]/g, ' ')}`, idf),
        ord: discovered,
        via: next.key,
      });
    }
  }
  return { rank: hitRank, bytes, opens: opened.length, opened, fixedBytes: indexBytes };
}

// -------------------------------------------------------------- strategy B/C

function rankedRun(q, ctx, searchable, fixedBytes, opts = {}) {
  const { docs, idf } = ctx;
  const qt = tokens(q.question);
  const entries = rankEntries(
    [...docs.values()].map((d) => ({ key: d.rel, score: scoreText(qt, searchable(d), idf) }))
  );

  let bytes = fixedBytes;
  const opened = [];
  let hitRank = 0;
  let sectionHit = null;

  for (let i = 0; i < Math.min(MAX_OPENS, entries.length); i += 1) {
    const doc = docs.get(entries[i].key);
    if (opts.constantSection) {
      const picked = constantSection(doc, opts.constantSection);
      bytes += bytesOf(doc.card) + picked.reduce((a, p) => a + bytesOf(p.text), 0);
      if (entries[i].key === q.truth.rel) {
        sectionHit = picked.some((p) => p.key === String(q.truth.section));
      }
    } else if (opts.withFacts) {
      const picked = routeWithFacts(q, qt, doc, idf);
      bytes += bytesOf(doc.card) + picked.reduce((a, p) => a + bytesOf(p.text), 0);
      if (entries[i].key === q.truth.rel) {
        sectionHit = picked.some((p) => p.key === String(q.truth.section));
      }
    } else if (opts.route) {
      // The card plus the section(s) its own line points at.
      const picked = routeSections(q, qt, doc, idf, opts.route);
      bytes += bytesOf(doc.card) + picked.reduce((a, p) => a + bytesOf(p.text), 0);
      if (entries[i].key === q.truth.rel) {
        sectionHit = picked.some((p) => p.key === String(q.truth.section));
      }
    } else if (opts.jumpToSection) {
      // The card plus the one section the term match points at — not the whole file.
      const best = bestSection(qt, doc, idf);
      bytes += bytesOf(doc.card) + bytesOf(best.text);
      if (entries[i].key === q.truth.rel) sectionHit = best.key === String(q.truth.section);
    } else {
      bytes += doc.bytes;
    }
    opened.push(entries[i].key);
    if (entries[i].key === q.truth.rel) { hitRank = i + 1; break; }
  }
  return { rank: hitRank, bytes, opens: opened.length, opened, fixedBytes, sectionHit };
}

const corpusBytesOf = (docs) => [...docs.values()].reduce((a, d) => a + d.bytes, 0);

// The acervo is a live repo. A ground truth that no longer matches its evidence
// is a broken bench, not a result — so check it before reporting any number.
function flatten(s) {
  return fold(s).replace(/[`*_>]/g, '').replace(/\s+/g, ' ').trim();
}

function verifyGroundTruth(questions, docs) {
  const problems = [];
  for (const q of questions) {
    const doc = docs.get(q.truth.rel);
    if (!doc) { problems.push(`${q.id}: contexto ${q.truth.rel} nao existe mais`); continue; }
    const section = doc.sections.get(String(q.truth.section));
    if (section === undefined) { problems.push(`${q.id}: ${q.truth.rel} nao tem mais a secao ${q.truth.section}`); continue; }
    const hay = flatten(section);
    for (const fragment of q.evidence.split('...')) {
      const needle = flatten(fragment);
      if (needle && !hay.includes(needle)) problems.push(`${q.id}: evidencia ausente de ${q.truth.locator} — "${fragment.trim().slice(0, 60)}"`);
    }
  }
  return problems;
}

function bestSection(qt, doc, idf) {
  let best = { key: '0', text: doc.card, score: -1 };
  for (const [key, text] of doc.sections) {
    if (key === 'preamble' || key === '0') continue;
    const s = scoreText(qt, text, idf);
    if (s > best.score || (s === best.score && key < best.key)) best = { key, text, score: s };
  }
  return best;
}

// Section routing by the card's own line for each section, nudged by what the
// question asks for. Returns the top `take` sections, best first: reading two
// short sections is often cheaper than one long one, and it is the fix for the
// measured exactness loss (a cited code lived in §5 while the answer was in §2).
// The mold's section 5 ("Decisoes e fatos") is where a consolidated fact with a
// number lives, by the template's own definition. So it is not a guess to always
// read it — it is reading the shape of the document. Measured: on the question
// set, the constant "always §5" scores 0,50, matching the best ranker and beating
// every single-section one. A router that cannot beat a constant does not get to
// be authoritative; it gets to be a hint next to the constant.
const FACTS_SECTION = '5';

function routeWithFacts(q, qt, doc, idf) {
  const picked = routeSections(q, qt, doc, idf, 1);
  const facts = doc.sections.get(FACTS_SECTION);
  if (facts !== undefined && !picked.some((p) => p.key === FACTS_SECTION)) {
    picked.push({ key: FACTS_SECTION, text: facts, score: 0 });
  }
  return picked;
}

// A constant is the control every ranker has to beat. Without it, a mediocre
// router reads as a result.
function constantSection(doc, key) {
  const text = doc.sections.get(key);
  return text === undefined ? [] : [{ key, text, score: 0 }];
}

function routeSections(q, qt, doc, idf, take = 1) {
  const prior = priorFor(q.question);
  const raw = [];
  for (const [key, text] of doc.sections) {
    if (key === 'preamble' || key === '0') continue;
    const abstract = doc.cardBySection.get(key) || '';
    // Length normalization is the whole ballgame here, and its absence was the
    // measured defect: an unnormalized tf sum lets the LONGEST section win by
    // volume (§3 "Fluxos principais" was picked for four questions answered in
    // §5), and lets the most generic abstract win among the short ones (§1).
    // Dampened by log length, BM25-style — a section is judged by density, not size.
    raw.push({
      key,
      text,
      abstract: byLength(scoreText(qt, abstract, idf), abstract),
      body: byLength(scoreText(qt, text, idf), text),
    });
  }
  // The prior nudges a RANKING, so it is applied to normalized scores. Added to a
  // raw idf sum (tens) a 0,35 boost was arithmetic noise pretending to be a rule.
  const top = (sel) => Math.max(...raw.map(sel), 0) || 1;
  const maxA = top((r) => r.abstract);
  const maxB = top((r) => r.body);
  const scored = raw.map((r) => ({
    key: r.key,
    text: r.text,
    score: 0.6 * (r.abstract / maxA) + 0.4 * (r.body / maxB) + (prior[r.key] || 0),
  }));
  scored.sort((a, b) => (b.score - a.score) || (a.key < b.key ? -1 : 1));
  return scored.slice(0, take);
}

// ------------------------------------------------------------------- metrics

function summarize(name, runs) {
  const n = runs.length;
  const hit = (k) => runs.filter((r) => r.rank > 0 && r.rank <= k).length / n;
  const mrr = runs.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
  const bytes = runs.reduce((a, r) => a + r.bytes, 0) / n;
  const marginal = runs.reduce((a, r) => a + (r.bytes - r.fixedBytes), 0) / n;
  const opens = runs.reduce((a, r) => a + r.opens, 0) / n;
  const sectionRuns = runs.filter((r) => r.sectionHit !== null && r.sectionHit !== undefined);
  return {
    strategy: name,
    hit1: +hit(1).toFixed(4),
    hit3: +hit(3).toFixed(4),
    mrr: +mrr.toFixed(4),
    bytes_read: Math.round(bytes),
    files_opened: +opens.toFixed(2),
    marginal_bytes: Math.round(marginal),
    fixed_index_bytes: runs[0] ? runs[0].fixedBytes : 0,
    section_accuracy: sectionRuns.length ? +(sectionRuns.filter((r) => r.sectionHit).length / sectionRuns.length).toFixed(4) : null,
  };
}

// ---------------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : '';
  };
  const acervo = arg('--acervo');
  const questions = arg('--questions');
  if (!acervo || !questions) {
    console.error(USAGE);
    process.exit(2);
  }

  const spec = JSON.parse(fs.readFileSync(questions, 'utf8'));
  const docs = loadCorpus(acervo);
  const idf = buildIdf(docs);

  const truthProblems = verifyGroundTruth(spec.questions, docs);
  if (truthProblems.length) {
    console.error('\nverdade de base nao confere com o acervo — os numeros abaixo nao valem:');
    for (const p of truthProblems) console.error('  ' + p);
    process.exitCode = 1;
  }

  const indexText = fs.readFileSync(path.join(acervo, 'INDEX.md'), 'utf8');
  const workingIndex = { bytes: bytesOf(indexText), entries: indexEntriesOf(indexText, acervo, docs) };
  const headText = committedIndex(acervo);
  const headIndex = headText === null
    ? null
    : { bytes: bytesOf(headText), entries: indexEntriesOf(headText, acervo, docs) };
  const indexChanged = headIndex !== null && headIndex.bytes !== workingIndex.bytes;

  // Fixed cost of each index the strategy has to scan before opening anything.
  const cardCorpusBytes = [...docs.values()].reduce((a, d) => a + bytesOf(d.card), 0);
  const anchorIndexPayload = [...docs.values()]
    .map((d) => [d.rel, ...d.inbound.map((i) => i.anchor), ...d.hotspots.map((h) => `${h.id} ${h.title}`)].join(' | '))
    .join('\n');
  const anchorIndexBytes = bytesOf(anchorIndexPayload);

  const ctx = { docs, idf };

  const cardOf = (d) => d.card;
  const anchorsOnly = (d) => [d.card, ...d.inbound.map((i) => i.anchor)].join('\n');
  const hotspotsOnly = (d) => [d.card, ...d.hotspots.map((h) => h.title)].join('\n');
  const cardPlusAnchors = (d) =>
    [d.card, ...d.inbound.map((i) => i.anchor), ...d.hotspots.map((h) => h.title)].join('\n');

  const anchorOnlyBytes = bytesOf([...docs.values()].map((d) => [d.rel, ...d.inbound.map((i) => i.anchor)].join(' | ')).join('\n'));
  const hotspotOnlyBytes = bytesOf([...docs.values()].map((d) => [d.rel, ...d.hotspots.map((h) => `${h.id} ${h.title}`)].join(' | ')).join('\n'));

  const strategies = [
    ...(indexChanged ? [{ name: 'A indice (HEAD)', run: (q) => runIndex(q, ctx, headIndex) }] : []),
    { name: 'A indice', run: (q) => runIndex(q, ctx, workingIndex) },
    { name: 'B cartoes', run: (q) => rankedRun(q, ctx, cardOf, cardCorpusBytes) },
    { name: 'C cartoes+ancora', run: (q) => rankedRun(q, ctx, cardPlusAnchors, cardCorpusBytes + anchorIndexBytes) },
    // C split in two, to see which of its ingredients carries and which is noise.
    { name: 'C1 so ancora', run: (q) => rankedRun(q, ctx, anchorsOnly, cardCorpusBytes + anchorOnlyBytes) },
    { name: 'C2 so hotspot', run: (q) => rankedRun(q, ctx, hotspotsOnly, cardCorpusBytes + hotspotOnlyBytes) },
    {
      name: 'D C+localizador',
      run: (q) => rankedRun(q, ctx, cardPlusAnchors, cardCorpusBytes + anchorIndexBytes, { jumpToSection: true }),
    },
    // F: the section is chosen by the CARD's line for it (plus what the question
    // asks for), instead of by term match against the whole section body.
    {
      name: 'F rota por cartao',
      run: (q) => rankedRun(q, ctx, cardPlusAnchors, cardCorpusBytes + anchorIndexBytes, { route: 1 }),
    },
    {
      name: 'F2 rota, 2 secoes',
      run: (q) => rankedRun(q, ctx, cardPlusAnchors, cardCorpusBytes + anchorIndexBytes, { route: 2 }),
    },
    {
      name: 'G rota + fatos (§5)',
      run: (q) => rankedRun(q, ctx, cardPlusAnchors, cardCorpusBytes + anchorIndexBytes, { withFacts: true }),
    },
    // The control: no ranking at all, just the mold's facts section.
    {
      name: 'Z controle: so §5',
      run: (q) => rankedRun(q, ctx, cardPlusAnchors, cardCorpusBytes + anchorIndexBytes, { constantSection: '5' }),
    },
    // Ceiling, not a protocol: rank on the full text of every context.md. If a
    // card-based strategy ranks worse than this, the card is dropping the
    // vocabulary the question uses.
    { name: 'E texto completo', run: (q) => rankedRun(q, ctx, (d) => d.text, corpusBytesOf(docs)) },
  ];

  const perQuestion = [];
  const results = [];
  for (const s of strategies) {
    const runs = spec.questions.map((q) => {
      const r = s.run(q);
      perQuestion.push({
        strategy: s.name,
        id: q.id,
        question: q.question,
        truth: q.truth.locator,
        rank: r.rank,
        bytes: r.bytes,
        opens: r.opens,
        opened: r.opened,
        section_hit: r.sectionHit === undefined ? null : r.sectionHit,
      });
      return r;
    });
    results.push(summarize(s.name, runs));
  }

  const corpusBytes = [...docs.values()].reduce((a, d) => a + d.bytes, 0);
  const out = {
    generated_at: new Date().toISOString(),
    acervo,
    corpus: {
      // The acervo is a live repo being edited while this runs; the digest says
      // which snapshot these numbers belong to.
      digest: crypto
        .createHash('sha256')
        .update([...docs.values()].map((d) => `${d.rel}:${d.bytes}`).join('\n'))
        .digest('hex')
        .slice(0, 16),
      contexts: docs.size,
      corpus_bytes: corpusBytes,
      index_md_bytes: workingIndex.bytes,
      index_md_entries: workingIndex.entries.length,
      index_md_head_bytes: headIndex ? headIndex.bytes : null,
      index_md_head_entries: headIndex ? headIndex.entries.length : null,
      card_corpus_bytes: cardCorpusBytes,
      anchor_index_bytes: anchorIndexBytes,
      inbound_anchors: [...docs.values()].reduce((a, d) => a + d.inbound.length, 0),
      // An anchor only earns its place if the neighbour named the target with
      // words the target's own slug does not already carry.
      informative_anchors: [...docs.values()].reduce(
        (a, d) => a + d.inbound.filter((i) => {
          const slug = new Set(tokens(d.rel.replace(/[/-]/g, ' ')));
          return tokens(i.anchor).some((t) => !slug.has(t));
        }).length,
        0
      ),
      lateral_anchors: [...docs.values()].reduce(
        (a, d) => a + d.inbound.filter((i) => !isKin(i.from, d.rel)).length,
        0
      ),
      hotspot_titles: [...docs.values()].reduce((a, d) => a + d.hotspots.length, 0),
      broken_links: [...docs.values()].flatMap((d) => d.links.filter((l) => !l.exists).map((l) => ({ from: d.rel, target: l.rel }))),
    },
    questions: spec.questions.length,
    max_opens: MAX_OPENS,
    results,
    per_question: perQuestion,
  };

  const outPath = arg('--out') || path.join(path.dirname(questions), 'retrieval-bench.out.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const pad = (s, w, right = false) => (right ? String(s).padStart(w) : String(s).padEnd(w));
  const line = (cells, widths) => cells.map((c, i) => pad(c, widths[i], i > 0)).join('  ');
  const widths = [18, 7, 7, 7, 12, 12, 8, 9];
  const header = ['estrategia', 'hit@1', 'hit@3', 'MRR', 'bytes', 'marginal', 'arquivos', 'secao'];

  console.log(`\nacervo: ${acervo}`);
  console.log(`contextos: ${docs.size} · corpus ${corpusBytes.toLocaleString('pt-BR')} B · digest ${out.corpus.digest}`);
  console.log(`INDEX.md: ${workingIndex.bytes.toLocaleString('pt-BR')} B / ${workingIndex.entries.length} entradas` +
    (indexChanged ? `  (HEAD: ${headIndex.bytes.toLocaleString('pt-BR')} B / ${headIndex.entries.length} entradas — foi reescrito nesta sessao)` : ''));
  console.log(`cartoes §0: ${cardCorpusBytes.toLocaleString('pt-BR')} B · indice de ancoras: ${anchorIndexBytes.toLocaleString('pt-BR')} B`);
  console.log(`perguntas: ${spec.questions.length} · teto de aberturas: ${MAX_OPENS}\n`);
  console.log(line(header, widths));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of results) {
    console.log(line([
      r.strategy,
      r.hit1.toFixed(2),
      r.hit3.toFixed(2),
      r.mrr.toFixed(3),
      r.bytes_read.toLocaleString('pt-BR'),
      r.marginal_bytes.toLocaleString('pt-BR'),
      r.files_opened.toFixed(2),
      r.section_accuracy === null ? '-' : r.section_accuracy.toFixed(2),
    ], widths));
  }
  console.log('\nbytes    = custo total medio por pergunta (indice fixo + arquivos abertos)');
  console.log('marginal = so os arquivos abertos, quando o indice ja foi lido uma vez na sessao');
  console.log('secao    = das vezes que o arquivo certo abriu, quantas o salto caiu na secao certa');
  console.log('E        = teto de ranqueamento (le o corpus inteiro), nao e um protocolo\n');

  console.log('estado do acervo hoje:');
  console.log(`  links internos: ${out.corpus.inbound_anchors} — LATERAIS: ${out.corpus.lateral_anchors} (o resto e pai<->filho ou irmao)`);
  console.log(`  texto-ancora que diz algo alem do slug do alvo: ${out.corpus.informative_anchors}`);
  console.log(`  titulos de hotspot: ${out.corpus.hotspot_titles} · links quebrados: ${out.corpus.broken_links.length}`);
  if (out.corpus.lateral_anchors === 0) {
    console.log('  => a perna "o vizinho descreve o alvo" da estrategia C nao existe no acervo ainda:');
    console.log('     C esta rodando quase so com titulo de hotspot. O numero de C mede o piso, nao o teto.');
  }
  console.log('');

  const byName = Object.fromEntries(results.map((r) => [r.strategy, r]));
  // The committed INDEX.md is the honest "before"; the working tree one is
  // already partly the new protocol.
  const a = byName['A indice (HEAD)'] || byName['A indice'];
  const aNow = byName['A indice'];
  const b = byName['B cartoes'];
  const c = byName['C cartoes+ancora'];
  const c1 = byName['C1 so ancora'];
  const c2 = byName['C2 so hotspot'];
  const d = byName['D C+localizador'];
  const say = (cond, yes, no) => (cond ? yes : no);

  console.log('veredito:');
  console.log(`  1. achar a fonte: ${say(c.hit1 > a.hit1, `C > A`, say(c.hit1 === a.hit1, 'C = A', 'C < A'))} ` +
    `— hit@1 ${c.hit1.toFixed(2)} vs ${a.hit1.toFixed(2)}, MRR ${c.mrr.toFixed(3)} vs ${a.mrr.toFixed(3)}, ` +
    `${c.files_opened.toFixed(2)} vs ${a.files_opened.toFixed(2)} arquivos abertos.`);
  console.log(`  2. custo total: ${say(c.bytes_read < a.bytes_read, 'C le menos que A', 'C le MAIS que A')} ` +
    `(${c.bytes_read.toLocaleString('pt-BR')} vs ${a.bytes_read.toLocaleString('pt-BR')} B/pergunta) — ` +
    `o corpus de cartoes custa ${c.fixed_index_bytes.toLocaleString('pt-BR')} B contra ${a.fixed_index_bytes.toLocaleString('pt-BR')} B do INDEX.md.`);
  console.log(`  3. custo amortizado (indice lido uma vez): ${say(c.marginal_bytes < a.marginal_bytes, 'C le menos', 'C le mais')} ` +
    `— ${c.marginal_bytes.toLocaleString('pt-BR')} vs ${a.marginal_bytes.toLocaleString('pt-BR')} B/pergunta.`);
  const breakEven = (s) => {
    const saved = a.marginal_bytes - s.marginal_bytes;
    const extra = s.fixed_index_bytes - a.fixed_index_bytes;
    return saved <= 0 ? null : Math.ceil(extra / saved);
  };
  const beC = breakEven(c);
  const beD = breakEven(d);
  console.log(`  3b. ponto de equilibrio do indice fixo: C se paga a partir de ${beC === null ? 'nunca' : beC + ' perguntas'} ` +
    `na mesma sessao; D, a partir de ${beD === null ? 'nunca' : beD + ' perguntas'}.`);
  console.log(`  4. com o localizador (D): ${d.marginal_bytes.toLocaleString('pt-BR')} B/pergunta amortizado, ` +
    `${(a.marginal_bytes / Math.max(d.marginal_bytes, 1)).toFixed(1)}x menos que A; ` +
    `o salto cai na secao certa em ${(d.section_accuracy * 100).toFixed(0)}% das vezes.`);
  console.log(`  5. decomposicao de C: so ancora MRR ${c1.mrr.toFixed(3)}, so hotspot MRR ${c2.mrr.toFixed(3)}, ` +
    `cartao puro MRR ${b.mrr.toFixed(3)} — ` +
    say(c2.mrr < b.mrr, 'titulo de hotspot e RUIDO liquido no ranqueamento.', 'titulo de hotspot ajuda.'));
  if (indexChanged) {
    console.log(`  6. o INDEX.md reescrito (${aNow.strategy}) sozinho ja leva A de hit@1 ${a.hit1.toFixed(2)} para ${aNow.hit1.toFixed(2)} ` +
      `e de ${a.files_opened.toFixed(2)} para ${aNow.files_opened.toFixed(2)} arquivos abertos — ` +
      `boa parte do ganho vem de descrever cada contexto, nao da estrutura de cartao.`);
  }
  console.log(`bruto: ${outPath}\n`);
}

// Importable so the routing can be inspected question by question without
// re-running the whole bench.
module.exports = {
  loadCorpus, buildIdf, tokens, routeSections, bestSection, priorFor,
  extractCardBySection, extractCard, extractSections,
};

if (require.main === module) main();
