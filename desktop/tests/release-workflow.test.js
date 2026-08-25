// Release pipeline guard — .github/workflows/release.yml (ADR-0015 · ADR-0006 §unsigned).
//
// A release is cut once per version: the workflow is the only place where a
// mistake is invisible until the tag exists. Two jobs now write to the SAME
// GitHub Release (macOS .dmg, Windows .msi/.exe), and the two ways that breaks
// are the two things this suite fixes:
//
//   · a race — both jobs calling `gh release create` for the same tag, the
//     second failing because the tag is already there. Exactly one creates;
//     the other only uploads, and it says so with `needs`.
//   · a macOS step running on the Windows runner — `make syscap` compiles
//     Swift, the cask bump shells out to `shasum`, and the version gate reads
//     tauri.conf.json with `python3`. None of the three exist on
//     windows-latest, so the Windows job takes the tag from the macOS job's
//     output instead of resolving it again.
//
// It also holds the honest bits: the bundle is unsigned on Windows (no
// certificate — same posture ADR-0006 records for macOS without a Developer
// ID), so SmartScreen warns on first run and the release notes have to say it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
// Read as LF regardless of the checkout's line endings (Windows clones CRLF).
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const YML = read(path.join(ROOT, ".github", "workflows", "release.yml"));
const README = read(path.join(ROOT, "README.md"));

// The jobs of a workflow, split by the two-space indentation that names them.
// A regex over the whole file cannot tell "runs on Windows" from "mentions
// Windows"; a per-job body can.
function jobs(yml) {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  assert.ok(start >= 0, "release.yml deve ter um bloco `jobs:`");
  const out = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    const header = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (header) {
      name = header[1];
      out[name] = [];
    } else if (name) {
      out[name].push(line);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n")]));
}

const JOBS = jobs(YML);
const macJob = () => {
  const [name] = Object.entries(JOBS).find(([, body]) => /runs-on:\s*macos-/.test(body)) || [];
  assert.ok(name, "algum job deve rodar em macos-*");
  return name;
};
const winJob = () => {
  const [name] = Object.entries(JOBS).find(([, body]) => /runs-on:\s*windows-/.test(body)) || [];
  assert.ok(name, "algum job deve rodar em windows-* (senão não sai instalador de Windows)");
  return name;
};

test("a tag v* publica instalador de Windows na mesma Release do dmg", () => {
  const win = JOBS[winJob()];
  assert.match(win, /bundle\/msi\/\*\.msi/, "o job de Windows deve anexar o .msi");
  assert.match(win, /bundle\/nsis\/\*-setup\.exe/, "o job de Windows deve anexar o setup do NSIS");
  assert.match(win, /npm run tauri build/, "o job de Windows deve buildar o bundle");
});

test("sem corrida pela Release: um job cria, o outro só sobe", () => {
  const mac = JOBS[macJob()];
  const win = JOBS[winJob()];
  assert.match(mac, /gh release create/, "o job de macOS é quem cria a Release");
  assert.doesNotMatch(
    win,
    /gh release create/,
    "dois `gh release create` para a mesma tag: o segundo falha porque a tag já existe",
  );
  assert.match(win, /gh release upload/, "o job de Windows sobe os artefatos na Release existente");
  assert.match(
    win,
    new RegExp(`needs:\\s*${macJob()}\\b`),
    "a ordem tem de ser explícita no yml: o job de Windows depende de quem cria",
  );
});

test("o job de Windows não resolve a versão de novo — herda a tag do job que criou", () => {
  const mac = JOBS[macJob()];
  const win = JOBS[winJob()];
  assert.match(mac, /outputs:\s*\n\s*tag:/, "o job de macOS deve exportar a tag como output");
  assert.match(win, /needs\.[\w-]+\.outputs\.tag/, "o job de Windows deve ler a tag do output");
});

test("nenhum passo de macOS executa no runner Windows", () => {
  const win = JOBS[winJob()];
  for (const [what, re] of [
    ["make syscap (compila Swift)", /make syscap/],
    ["shasum", /shasum/],
    ["python3", /python3/],
    ["bump do cask", /homebrew|TAP_TOKEN|loro\.rb/i],
    ["artefato .dmg", /\.dmg/],
  ]) {
    assert.doesNotMatch(win, re, `${what} não existe em windows-latest`);
  }
});

test("as notas da Release explicam o aviso do SmartScreen e como instalar no Windows", () => {
  const notes = YML.match(/--notes "([\s\S]*?)"\n/);
  assert.ok(notes, "o `gh release create` deve passar --notes");
  const text = notes[1];
  assert.match(text, /SmartScreen/, "o app é sem assinatura: as notas dizem o que a tela avisa");
  assert.match(text, /Mais informações|More info/, "as notas dizem por onde passar o aviso");
  assert.match(text, /\.msi/, "as notas dizem qual arquivo baixar no Windows");
});

test("README: no Windows o instalador é o caminho principal, compilar é alternativa", () => {
  const section = README.slice(README.indexOf("### Windows"), README.indexOf("### From source"));
  assert.ok(section.length > 0, "o README deve ter a seção Windows antes de From source");
  assert.match(section, /releases\/latest/, "a seção deve apontar para o instalador da Release");
  assert.doesNotMatch(
    section,
    /There is no prebuilt installer/,
    "passou a existir instalador — o README não pode continuar dizendo que não",
  );
  const installerAt = section.search(/\.msi|releases\/latest/);
  const sourceAt = section.search(/build from source|from source|npm run tauri build/i);
  assert.ok(
    installerAt >= 0 && (sourceAt === -1 || installerAt < sourceAt),
    "o instalador vem antes de compilar da fonte",
  );
});
