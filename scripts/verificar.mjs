// Verificação do Something Gamer: sem framework, só node.
//
// Existe porque a v40 foi publicada com um "}" faltando no chat.js. Como é
// módulo ES, o arquivo inteiro não carregava e a página de chat ficava morta,
// sem erro visível em lugar nenhum. Um parse teria pego em um segundo.
//
//   node scripts/verificar.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignorar = new Set(["node_modules", ".git", "build", "dist", ".firebase", ".wrangler", "scripts"]);

const falhas = [];
const avisos = [];
let conferidos = 0;

function varrer(dir, extensoes) {
    const achados = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ignorar.has(item.name)) continue;
        const completo = path.join(dir, item.name);
        if (item.isDirectory()) achados.push(...varrer(completo, extensoes));
        else if (extensoes.some(ext => item.name.endsWith(ext))) achados.push(completo);
    }
    return achados;
}

const relativo = arquivo => path.relative(raiz, arquivo).replace(/\\/g, "/");

// ---------- 1. todo JavaScript precisa ao menos compilar ----------
for (const arquivo of varrer(raiz, [".js", ".mjs"])) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    const nome = relativo(arquivo);
    // functions/ e desktop-app/ são CommonJS; o resto é módulo ES.
    const commonjs = nome.startsWith("functions/") || nome.startsWith("desktop-app/");
    conferidos++;
    try {
        const args = commonjs ? ["--check", arquivo] : ["--input-type=module", "--check"];
        execFileSync(process.execPath, args, { input: commonjs ? undefined : codigo, stdio: ["pipe", "pipe", "pipe"] });
    } catch (erro) {
        const saida = String(erro.stderr || erro.message).split("\n").find(linha => /Error/.test(linha)) || String(erro.message);
        falhas.push(`${nome}: ${saida.trim()}`);
    }
}

// ---------- 2. todo JSON precisa ser JSON ----------
for (const arquivo of varrer(raiz, [".json", ".webmanifest"])) {
    const nome = relativo(arquivo);
    if (nome.endsWith("package-lock.json")) continue;
    conferidos++;
    try {
        JSON.parse(fs.readFileSync(arquivo, "utf8").replace(/^﻿/, ""));
    } catch (erro) {
        falhas.push(`${nome}: ${erro.message}`);
    }
}

// ---------- 3. módulo ES carregado sem type="module" não roda ----------
const modulos = new Set();
for (const arquivo of varrer(raiz, [".js"])) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    if (/^\s*(import|export)\s/m.test(codigo)) modulos.add(path.basename(arquivo));
}
for (const arquivo of varrer(raiz, [".html"])) {
    const html = fs.readFileSync(arquivo, "utf8");
    const nome = relativo(arquivo);
    conferidos++;
    for (const tag of html.match(/<script\b[^>]*>/g) || []) {
        const src = (tag.match(/src="([^"]+)"/) || [])[1];
        if (!src) {
            avisos.push(`${nome}: script inline (a CSP em firebase.json bloqueia)`);
            continue;
        }
        const base = path.basename(src.split("?")[0]);
        if (modulos.has(base) && !/type="module"/.test(tag)) {
            falhas.push(`${nome}: ${base} é módulo ES mas está sem type="module", então não vai carregar`);
        }
    }
}

// ---------- 4. notificação sem read:false é recusada pelas regras ----------
for (const arquivo of varrer(raiz, [".js"])) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    const nome = relativo(arquivo);
    const re = /(setDoc\(doc\(collection\(db,\s*["']notifications["']\)\)|addDoc\(collection\(db,\s*["']notifications["']\))\s*,\s*\{/g;
    let achado;
    while ((achado = re.exec(codigo))) {
        let i = re.lastIndex - 1, prof = 0, fim = i;
        for (let k = i; k < codigo.length; k++) {
            if (codigo[k] === "{") prof++;
            else if (codigo[k] === "}" && --prof === 0) { fim = k; break; }
        }
        if (!codigo.slice(i, fim + 1).includes("read:false")) {
            falhas.push(`${nome}: notificação criada sem read:false, e as regras do Firestore recusam`);
        }
    }
}

// ---------- 5. consultas com limit() precisam de orderBy ----------
// Sem orderBy o Firestore ordena por ID do documento, que é aleatório: a v40
// parava de entregar notificação depois das 30 primeiras.
for (const arquivo of varrer(raiz, [".js"])) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    const nome = relativo(arquivo);
    for (const trecho of codigo.match(/query\((?:[^()]|\([^()]*\))*\)/g) || []) {
        if (trecho.includes("limit(") && !trecho.includes("orderBy(") && !trecho.includes("sem-orderby")) {
            falhas.push(`${nome}: query com limit() e sem orderBy(), então ordena por ID aleatório: ${trecho.slice(0, 90)}`);
        }
    }
}

// ---------- 5b. identificador usado sem import ----------
// Um import apagado por engano não é erro de sintaxe: o arquivo compila e só
// quebra em produção, na hora que a função é chamada.
{
    const daBiblioteca = [
        "auth", "db", "storage", "googleProvider", "signInWithPopup", "APP_CONFIG",
        "collection", "doc", "getDoc", "getDocs", "query", "where", "limit", "orderBy",
        "setDoc", "addDoc", "updateDoc", "deleteDoc", "onSnapshot", "runTransaction",
        "serverTimestamp", "arrayUnion", "arrayRemove", "Timestamp",
        "ref", "uploadBytes", "getDownloadURL", "signOut",
        "assertPublicText", "inspectPublicText", "openSafetyReport",
        "escaparHtml", "urlSegura", "urlDeMidia", "hrefSeguro", "srcSeguro"
    ];
    for (const arquivo of varrer(raiz, [".js"])) {
        const nome = relativo(arquivo);
        if (nome.startsWith("functions/") || nome.startsWith("desktop-app/") || nome.startsWith("something-gamer-api/")) continue;
        const codigo = fs.readFileSync(arquivo, "utf8");
        // vários arquivos têm dois imports na MESMA linha, então nada de âncora de linha
        const blocosImport = (codigo.match(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["']/g) || []).join("\n");
        // o próprio arquivo pode declarar ou exportar o nome
        const declarados = new Set([
            ...[...codigo.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
            ...[...codigo.matchAll(/export\s+(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
            ...[...codigo.matchAll(/export\s*\{([^}]*)\}/g)].flatMap(m => m[1].split(",").map(x => x.trim()))
        ]);
        conferidos++;
        for (const ident of daBiblioteca) {
            if (declarados.has(ident)) continue;
            const corpo = codigo.split(blocosImport).join("");
            const usado = new RegExp(`(^|[^.\\w"'\`])${ident}\\s*\\(`).test(corpo);
            if (usado && !new RegExp(`\\b${ident}\\b`).test(blocosImport)) {
                falhas.push(`${nome}: usa "${ident}()" mas não importa, e quebra só em produção`);
            }
        }
    }
}

// ---------- 6. regras de segurança: estrutura ----------
// Não dá para rodar o emulador sem Java, então aqui vai o que dá para conferir
// sem ele. Um erro nas regras derruba TODA escrita do app de uma vez.
for (const arquivo of ["firestore.rules", "storage.rules"]) {
    const bruto = fs.readFileSync(path.join(raiz, arquivo), "utf8");
    // Uma varredura só, da esquerda para a direita. Com dois replace separados
    // dava errado dos dois jeitos: apagar comentário antes comia o resto da
    // linha em matches('https://.*'), e apagar string antes fazia um apóstrofo
    // solto dentro de um comentário engolir o arquivo até a próxima aspa.
    const limpo = (() => {
        let saida = "", modo = "codigo";
        for (let i = 0; i < bruto.length; i++) {
            const ch = bruto[i];
            if (modo === "codigo") {
                if (ch === "/" && bruto[i + 1] === "/") { modo = "comentario"; continue; }
                if (ch === "'") { modo = "texto"; saida += "''"; continue; }
                saida += ch;
            } else if (modo === "comentario") {
                if (ch === "\n") { modo = "codigo"; saida += ch; }
            } else {
                if (ch === "\\") { i++; continue; }
                if (ch === "'") modo = "codigo";
                else if (ch === "\n") saida += ch; // string não fechada: não engole o arquivo
            }
        }
        return saida;
    })();
    conferidos++;

    // delimitadores equilibrados
    const pilha = [];
    const pares = { "}": "{", ")": "(", "]": "[" };
    let linha = 1;
    for (const ch of limpo) {
        if (ch === "\n") linha++;
        else if ("{([".includes(ch)) pilha.push({ ch, linha });
        else if (ch in pares) {
            const topo = pilha.pop();
            if (!topo || topo.ch !== pares[ch]) falhas.push(`${arquivo}:${linha} fecha "${ch}" sem abrir`);
        }
    }
    if (pilha.length) falhas.push(`${arquivo}: ${pilha.length} delimitador(es) sem fechar (primeiro na linha ${pilha[0].linha})`);

    // toda função chamada precisa existir
    const definidas = new Set([...limpo.matchAll(/function\s+([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)].map(m => m[1]));
    const embutidas = new Set(["get", "exists", "getAfter", "existsAfter", "debug", "float", "int", "string", "duration", "hashing", "latlng", "math", "timestamp", "path", "value", "firestore"]);
    const palavras = new Set(["if", "return", "in", "is", "allow", "match", "service", "rules_version"]);
    for (const m of limpo.matchAll(/(?:^|[^.\w])([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)) {
        const nome = m[1];
        if (!definidas.has(nome) && !embutidas.has(nome) && !palavras.has(nome)) {
            falhas.push(`${arquivo}: chama "${nome}()" que não é função definida nem embutida`);
        }
    }

    // indexar mapa com variável não é construção garantida da linguagem de regras
    for (const m of limpo.matchAll(/data\[\s*([a-zA-Z][a-zA-Z0-9]*)\s*\]/g)) {
        falhas.push(`${arquivo}: indexa mapa com a variável "${m[1]}" : use .get('campo', padrão)`);
    }

    // as expressões regulares precisam compilar
    for (const m of bruto.matchAll(/\.matches\('([^']*)'\)/g)) {
        try { new RegExp(m[1].replace(/^\(\?s\)/, ""), "s"); }
        catch (erro) { falhas.push(`${arquivo}: regex inválida em matches(): ${erro.message}`); }
    }
}

// o filtro de termos graves casa a string inteira: sem .* nas pontas não pega nada
{
  const regras = fs.readFileSync(path.join(raiz, "firestore.rules"), "utf8");
  const filtro = (regras.match(/function semTermoGrave[\s\S]*?matches\('([^']*)'\)/) || [])[1];
  if (!filtro) falhas.push("firestore.rules: semTermoGrave() sumiu, e a validação de conteúdo no servidor depende dela");
  else if (!/\.\*\)?$/.test(filtro) || !filtro.includes(".*(")) {
      falhas.push(`firestore.rules: semTermoGrave() precisa de .* nas duas pontas, porque o Firestore casa a string inteira`);
  }
}

// ---------- 7. a lista de administradores vive em quatro arquivos ----------
{
    const emails = texto => (texto.match(/[a-z0-9._%-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase()).sort().join(",");
    const ler = arquivo => fs.readFileSync(path.join(raiz, arquivo), "utf8");
    const fontes = {
        "firestore.rules": ler("firestore.rules").match(/function adminEmails\(\)[^}]*}/)?.[0],
        "storage.rules": ler("storage.rules").match(/function isAdmin\(\)[^}]*}/)?.[0],
        "functions/index.js": ler("functions/index.js").match(/const ADMIN_EMAILS = \[[^\]]*\]/)?.[0],
        "wrangler.jsonc": ler("something-gamer-api/wrangler.jsonc").match(/"ADMIN_EMAILS":\s*"[^"]*"/)?.[0]
    };
    conferidos++;
    const referencia = emails(fontes["firestore.rules"] || "");
    for (const [onde, trecho] of Object.entries(fontes)) {
        if (!trecho) { falhas.push(`${onde}: não achei a lista de administradores`); continue; }
        if (emails(trecho) !== referencia) falhas.push(`${onde}: lista de admin fora de sincronia (${emails(trecho)} != ${referencia})`);
    }
}

// ---------- 8. getElementById de id que não existe na página ----------
// O painel admin ficou morto por isso: renderCountryOptions() roda no topo
// do admin.js e faz $("countryOptions").innerHTML. O elemento não existe no
// admin.html, então dá TypeError, o módulo para ali e NADA depois é
// registrado: nem o login, nem as abas, nem a tabela. Mesmo estrago do "}"
// que faltava no chat.js, por outro caminho.
{
    const paginas = varrer(raiz, [".html"]);
    const modulos = varrer(raiz, [".js"]);

    // o que cada módulo importa, para seguir a cadeia a partir da página
    const importa = new Map();
    for (const arquivo of modulos) {
        const codigo = fs.readFileSync(arquivo, "utf8");
        const pasta = path.posix.dirname(relativo(arquivo));
        importa.set(relativo(arquivo), [...codigo.matchAll(/from\s+"(\.[^"]+\.js)"/g)]
            .map(m => path.posix.normalize(path.posix.join(pasta, m[1]))));
    }

    function cadeia(inicio, vistos = new Set()) {
        if (vistos.has(inicio)) return vistos;
        vistos.add(inicio);
        for (const dep of importa.get(inicio) || []) cadeia(dep, vistos);
        return vistos;
    }

    // um id pode nascer em tempo de execução (innerHTML), e aí não está no HTML
    const criadosEmJs = new Set();
    for (const arquivo of modulos) {
        for (const m of fs.readFileSync(arquivo, "utf8").matchAll(/id=\\?"([A-Za-z][\w-]*)/g)) {
            criadosEmJs.add(m[1]);
        }
    }

    // um script compartilhado (script.js) pode usar um id que só existe em
    // uma das páginas, dentro de um if. Só reclamamos se o id não existe em
    // NENHUMA página que carrega aquele script.
    const idsPorPagina = new Map();
    const scriptsPorPagina = new Map();
    for (const pagina of paginas) {
        const html = fs.readFileSync(pagina, "utf8");
        const pasta = path.posix.dirname(relativo(pagina));
        idsPorPagina.set(relativo(pagina), new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])));
        const scripts = new Set();
        for (const m of html.matchAll(/<script[^>]*src="([^"]+\.js)"/g)) {
            if (/^https?:/.test(m[1])) continue;
            for (const dep of cadeia(path.posix.normalize(path.posix.join(pasta, m[1])))) scripts.add(dep);
        }
        scriptsPorPagina.set(relativo(pagina), scripts);
    }

    for (const pagina of paginas) {
        const nome = relativo(pagina);
        const meusIds = idsPorPagina.get(nome);
        for (const js of scriptsPorPagina.get(nome)) {
            const caminho = path.join(raiz, js);
            if (!fs.existsSync(caminho)) continue;
            const codigo = fs.readFileSync(caminho, "utf8");
            const protegidos = new Set([...codigo.matchAll(/if\s*\(\s*!?\s*\$\("([A-Za-z][\w-]*)"\)/g)].map(m => m[1]));
            for (const m of codigo.matchAll(/(?:\$|document\.getElementById)\(\s*"([A-Za-z][\w-]*)"\s*\)\s*\./g)) {
                const id = m[1];
                if (meusIds.has(id) || criadosEmJs.has(id) || protegidos.has(id)) continue;
                // existe em outra página que carrega o mesmo script?
                let existeEmOutra = false;
                for (const [outra, scripts] of scriptsPorPagina) {
                    if (outra !== nome && scripts.has(js) && idsPorPagina.get(outra).has(id)) { existeEmOutra = true; break; }
                }
                if (existeEmOutra) continue;
                falhas.push(`${js}: usa #${id}, que não existe em ${nome} (nem é criado em tempo de execução)`);
            }
        }
    }
}

// ---------- resultado ----------
console.log(`${conferidos} arquivos conferidos.`);
for (const aviso of avisos) console.log(`  aviso: ${aviso}`);
if (falhas.length) {
    console.error(`\n${falhas.length} problema(s):`);
    for (const falha of falhas) console.error(`  - ${falha}`);
    process.exit(1);
}
console.log("Tudo certo.");
