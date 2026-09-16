// Something Gamer API: apoio ao painel administrativo.
//
// O fluxo da Steam vivia aqui E em functions/index.js, duas implementações da
// mesma coisa. Ficou a das Cloud Functions, que grava no Firestore com o Admin
// SDK: os dados da Steam não passam mais pelo navegador, então não dá para
// forjar biblioteca nem conquistas. Este Worker cuida só do painel.

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

const origensLiberadas = env => [env.APP_URL, "https://something-gamer.web.app", "https://something-gamer.firebaseapp.com", "http://127.0.0.1:5500", "http://localhost:5500"];

function cors(env, request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": origensLiberadas(env).includes(origin) ? origin : env.APP_URL,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin"
  };
}

const hex = bytes => [...new Uint8Array(bytes)].map(valor => valor.toString(16).padStart(2, "0")).join("");
const desHex = texto => {
  if (!/^[0-9a-f]*$/i.test(texto) || texto.length % 2) return null;
  return new Uint8Array(texto.match(/../g)?.map(par => parseInt(par, 16)) || []);
};
function randomCode(bytes = 24) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Comparação em tempo constante: o Worker não tem crypto.timingSafeEqual.
function iguaisEmTempoConstante(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a[i] ^ b[i];
  return diferenca === 0;
}

// ---------- senhas do painel ----------
// Antes era SHA-256 puro, sem sal: uma tabela arco-íris resolvia. Agora é
// PBKDF2 com sal por senha. Hashes antigos continuam aceitos uma única vez e
// são regravados no formato novo assim que o administrador acerta a senha.
const PBKDF2_ITERACOES = 210000;

async function derivar(senha, sal, iteracoes = PBKDF2_ITERACOES) {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: sal, iterations: iteracoes, hash: "SHA-256" }, chave, 256);
  return new Uint8Array(bits);
}

async function gerarHash(senha) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const derivado = await derivar(senha, sal);
  return `pbkdf2$${PBKDF2_ITERACOES}$${hex(sal)}$${hex(derivado)}`;
}

async function sha256Legado(valor) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(valor))));
}

async function conferirSenha(senha, guardado) {
  if (!guardado) return { ok: false, legado: false };
  if (!guardado.startsWith("pbkdf2$")) {
    const antigo = await sha256Legado(senha);
    return { ok: iguaisEmTempoConstante(desHex(antigo), desHex(guardado)), legado: true };
  }
  const [, iteracoes, salHex, hashHex] = guardado.split("$");
  const sal = desHex(salHex);
  const esperado = desHex(hashHex);
  if (!sal || !esperado) return { ok: false, legado: false };
  const derivado = await derivar(senha, sal, Number(iteracoes) || PBKDF2_ITERACOES);
  return { ok: iguaisEmTempoConstante(derivado, esperado), legado: false };
}

// ---------- identidade ----------
async function firebaseUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: header.slice(7) })
  });
  const data = await response.json();
  const conta = data.users?.[0];
  if (!response.ok || !conta?.localId) throw new Error("UNAUTHENTICATED");
  return { uid: conta.localId, email: conta.email || "", emailVerificado: conta.emailVerified === true };
}

// Mesma lista de firestore.rules e storage.rules. Mudou aqui? Mude nos três.
const emailsAdmin = env => String(env.ADMIN_EMAILS || env.ADMIN_EMAIL || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);

async function requireAdmin(request, env) {
  const admin = await firebaseUser(request, env);
  // as regras do Firestore exigem e-mail confirmado; aqui também.
  if (!admin.emailVerificado || !emailsAdmin(env).includes(admin.email.toLowerCase())) throw new Error("FORBIDDEN");
  return admin;
}

// ---------- e-mails ----------
function safe(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

const emailTemplates = {
  verification: { subject: "Você agora é Gamer Verificado", title: "Verificação aprovada", message: "Seu perfil foi analisado e recebeu o selo Gamer Verificado no Something Gamer." },
  verificationRemoved: { subject: "Atualização da sua Verificação Gamer", title: "Verificação atualizada", message: "O selo Gamer Verificado foi removido do seu perfil. Fale com o suporte se precisar de ajuda." },
  nowBadge: { subject: "A Now Desenvolvimento Tech agora segue você", title: "Você recebeu um selo oficial", message: "A Now Desenvolvimento Tech passou a seguir seu perfil no Something Gamer." },
  sgBadge: { subject: "O Something Gamer agora segue você", title: "Você recebeu um selo oficial", message: "O perfil oficial do Something Gamer passou a seguir você." },
  payment: { subject: "Pagamento confirmado no Something Gamer", title: "Pagamento confirmado", message: "Recebemos seu pagamento. Sua solicitação de Verificação Gamer seguirá para análise." }
};

function moldura(env, titulo, corpo, botao = "") {
  return `<!doctype html><html><body style="margin:0;background:#07080c;color:#f7f7fa;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td align="center" style="padding:36px 16px"><table role="presentation" width="100%" style="max-width:560px;background:#111218;border:1px solid #292b35;border-radius:18px"><tr><td style="padding:34px"><div style="color:#7965ff;font-size:12px;font-weight:700;letter-spacing:2px">SOMETHING GAMER</div><h1 style="font-size:28px;margin:18px 0 12px">${titulo}</h1><p style="color:#b9bbc8;line-height:1.7">${corpo}</p>${botao}<p style="margin-top:28px;color:#777b8c;font-size:12px">Mensagem automática. Não responda a este e-mail.</p></td></tr></table></td></tr></table></body></html>`;
}

async function enviarEmail(env, { to, subject, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html })
  });
  const resultado = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("RESEND", response.status, resultado);
    throw new Error("EMAIL_SEND_FAILED");
  }
  return resultado;
}

async function adminNotify(request, env) {
  const admin = await requireAdmin(request, env);
  const body = await request.json();
  const template = emailTemplates[String(body.type || "")];
  const to = String(body.to || "").trim();
  if (!template || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("INVALID_EMAIL_REQUEST");
  const throttle = `mail:${admin.uid}:${body.type}:${to}`;
  if (await env.SG_AUTH.get(throttle)) throw new Error("RATE_LIMITED");
  await env.SG_AUTH.put(throttle, "1", { expirationTtl: 20 });
  const botao = `<a href="${safe(env.APP_URL)}/dashboard.html" style="display:inline-block;margin-top:14px;padding:13px 18px;border-radius:10px;background:#6248ff;color:#fff;text-decoration:none;font-weight:700">Abrir meu perfil</a>`;
  const corpo = `Olá${body.name ? `, ${safe(body.name)}` : ""}. ${safe(template.message)}`;
  const resultado = await enviarEmail(env, { to, subject: template.subject, html: moldura(env, safe(template.title), corpo, botao) });
  return { ok: true, id: resultado.id };
}

// ---------- senha por área do painel ----------
const areaValida = area => area === "verification" || area === "promotion";

async function adminAccess(request, env, action) {
  const body = await request.json();
  const area = String(body.area || "");
  if (!areaValida(area)) throw new Error("INVALID_ACCESS_AREA");

  // "reset" vem do link enviado por e-mail, então não exige sessão de admin:
  // quem prova a identidade é o token de uso único guardado no KV.
  if (action === "reset") {
    const token = String(body.token || "");
    if (!token) throw new Error("INVALID_RESET_TOKEN");
    const chave = `admin-reset:${token}`;
    const guardado = await env.SG_AUTH.get(chave);
    if (!guardado || guardado !== area) throw new Error("INVALID_RESET_TOKEN");
    if (String(body.password || "").length < 8) throw new Error("WEAK_PASSWORD");
    await env.SG_AUTH.put(`admin-password:${area}`, await gerarHash(body.password));
    await env.SG_AUTH.delete(chave);
    return { ok: true };
  }

  const admin = await requireAdmin(request, env);

  if (action === "verify") {
    const tentativasKey = `admin-attempts:${admin.uid}:${area}`;
    const tentativas = Number(await env.SG_AUTH.get(tentativasKey) || 0);
    if (tentativas >= 5) throw new Error("TOO_MANY_ATTEMPTS");

    const guardado = await env.SG_AUTH.get(`admin-password:${area}`);
    let confere;
    if (guardado) {
      confere = await conferirSenha(body.password || "", guardado);
    } else {
      // primeira vez: usa a senha de arranque das variáveis do Worker
      const inicial = area === "verification" ? env.ADMIN_VERIFY_PASSWORD : env.ADMIN_PROMO_PASSWORD;
      const a = new TextEncoder().encode(String(body.password || ""));
      const b = new TextEncoder().encode(String(inicial || ""));
      confere = { ok: Boolean(inicial) && iguaisEmTempoConstante(a, b), legado: true };
    }

    if (!confere.ok) {
      await env.SG_AUTH.put(tentativasKey, String(tentativas + 1), { expirationTtl: 900 });
      throw new Error("INVALID_ADMIN_PASSWORD");
    }
    // acertou com hash antigo (ou senha de arranque): regrava já no formato novo
    if (confere.legado) await env.SG_AUTH.put(`admin-password:${area}`, await gerarHash(body.password));

    await env.SG_AUTH.delete(tentativasKey);
    const accessToken = randomCode(32);
    await env.SG_AUTH.put(`admin-access:${accessToken}`, JSON.stringify({ uid: admin.uid, area }), { expirationTtl: 1800 });
    return { ok: true, accessToken, expiresIn: 1800 };
  }

  if (action === "check") {
    const bruto = await env.SG_AUTH.get(`admin-access:${String(body.accessToken || "")}`);
    const sessao = bruto ? JSON.parse(bruto) : null;
    if (!sessao || sessao.uid !== admin.uid || sessao.area !== area) throw new Error("ADMIN_SESSION_EXPIRED");
    return { ok: true };
  }

  if (action === "forgot") {
    const espera = `admin-recovery:${admin.uid}:${area}`;
    if (await env.SG_AUTH.get(espera)) throw new Error("RATE_LIMITED");
    await env.SG_AUTH.put(espera, "1", { expirationTtl: 60 });
    const token = randomCode(32);
    await env.SG_AUTH.put(`admin-reset:${token}`, area, { expirationTtl: 900 });
    const link = `${env.APP_URL}/admin-reset.html?area=${area}&token=${token}`;
    const rotulo = area === "verification" ? "verificações" : "promoções";
    const botao = `<a style="display:inline-block;margin-top:14px;padding:13px 18px;background:#654bff;color:#fff;border-radius:9px;text-decoration:none;font-weight:700" href="${safe(link)}">Criar nova senha</a>`;
    await enviarEmail(env, {
      to: env.ADMIN_RECOVERY_EMAIL,
      subject: `Redefinir senha de ${rotulo} no Something Gamer`,
      html: moldura(env, `Redefinir senha de ${rotulo}`, "Este link vale por 15 minutos e só pode ser usado uma vez.", botao)
    });
    return { ok: true };
  }

  throw new Error("INVALID_ACCESS_ACTION");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === "/health") return json({ ok: true, service: "Something Gamer API" }, 200, headers);
      if (url.pathname === "/adminNotify" && request.method === "POST") return json(await adminNotify(request, env), 200, headers);
      if (url.pathname.startsWith("/adminAccess/") && request.method === "POST") return json(await adminAccess(request, env, url.pathname.split("/").pop()), 200, headers);
      return json({ error: "Rota não encontrada." }, 404, headers);
    } catch (error) {
      console.error(error);
      const code = error.message;
      const status =
        code === "UNAUTHENTICATED" ? 401 :
        code === "FORBIDDEN" ? 403 :
        code === "INVALID_RESET_TOKEN" ? 410 :
        code === "RATE_LIMITED" || code === "TOO_MANY_ATTEMPTS" ? 429 :
        ["INVALID_EMAIL_REQUEST", "INVALID_ACCESS_AREA", "WEAK_PASSWORD", "INVALID_ADMIN_PASSWORD", "INVALID_ACCESS_ACTION"].includes(code) ? 400 :
        code === "ADMIN_SESSION_EXPIRED" ? 401 : 500;
      const mensagens = {
        INVALID_ADMIN_PASSWORD: "Senha incorreta.",
        WEAK_PASSWORD: "Use pelo menos 8 caracteres.",
        INVALID_RESET_TOKEN: "O link expirou ou já foi utilizado.",
        ADMIN_SESSION_EXPIRED: "A sessão desta área expirou. Digite a senha novamente.",
        TOO_MANY_ATTEMPTS: "Muitas tentativas. Aguarde 15 minutos.",
        400: "Dados inválidos.",
        401: "Faça login novamente.",
        403: "Acesso restrito ao administrador.",
        410: "O link expirou. Peça outro.",
        429: "Aguarde antes de tentar novamente."
      };
      return json({ error: mensagens[code] || mensagens[status] || "Não foi possível concluir a solicitação." }, status, headers);
    }
  }
};
