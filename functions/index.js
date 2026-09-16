const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const steamApiKey = defineSecret("STEAM_API_KEY");
const rawgApiKey = defineSecret("RAWG_API_KEY");
const mercadoPagoToken = defineSecret("MERCADO_PAGO_ACCESS_TOKEN");
const adminUid = defineSecret("ADMIN_UID");
const resendApiKey = defineSecret("RESEND_API_KEY");
const emailFrom = defineSecret("EMAIL_FROM");
const resetCodeSecret = defineSecret("RESET_CODE_SECRET");
const openXblApiKey = defineSecret("OPENXBL_API_KEY");
const mercadoPagoWebhookSecret = defineSecret("MERCADO_PAGO_WEBHOOK_SECRET");
const APP_URL = "https://something-gamer.web.app";
const FUNCTIONS_BASE = "https://us-central1-something-gamer.cloudfunctions.net";
// Mesma lista de firestore.rules e storage.rules. Mudou aqui? Mude nos três.
const ADMIN_EMAILS = ["gabobnu2@gmail.com", "nowdesenvolvimentotech@gmail.com"];
const allowedOrigins = new Set([APP_URL, "https://something-gamer.firebaseapp.com", "http://localhost:5000", "http://127.0.0.1:5000", "http://localhost:5500", "http://127.0.0.1:5500"]);

function cors(req, res) {
    const origin = req.get("origin");
    if (origin && allowedOrigins.has(origin)) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

async function requireFirebaseUser(req) {
    const header = req.get("authorization") || "";
    if (!header.startsWith("Bearer ")) throw new Error("UNAUTHENTICATED");
    return getAuth().verifyIdToken(header.slice(7));
}

function callbackUrl() {
    return `${FUNCTIONS_BASE}/steamCallback`;
}

// Limite simples por usuário para não queimar a cota das APIs externas.
async function limitarUso(uid, acao, janelaMs, maximo) {
    const ref = db.collection("rateLimits").doc(`${acao}_${uid}`);
    const agora = Date.now();
    await db.runTransaction(async transaction => {
        const atual = (await transaction.get(ref)).data();
        if (atual && agora - atual.inicio < janelaMs) {
            if (atual.total >= maximo) throw new Error("RATE_LIMITED");
            transaction.update(ref, { total: FieldValue.increment(1) });
        } else {
            transaction.set(ref, { inicio: agora, total: 1 });
        }
    });
}

exports.steamStart = onRequest({ region: "us-central1", cors: false }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    try {
        const user = await requireFirebaseUser(req);
        await limitarUso(user.uid, "steamStart", 60 * 60 * 1000, 10);
        const state = crypto.randomBytes(32).toString("hex");
        const requestOrigin = req.get("origin");
        await db.collection("steamAuthStates").doc(state).set({ uid: user.uid, returnOrigin: allowedOrigins.has(requestOrigin) ? requestOrigin : APP_URL, createdAt: FieldValue.serverTimestamp(), expiresAt: Date.now() + 10 * 60 * 1000 });
        const returnTo = `${callbackUrl()}?state=${state}`;
        const params = new URLSearchParams({
            "openid.ns": "http://specs.openid.net/auth/2.0",
            "openid.mode": "checkid_setup",
            "openid.return_to": returnTo,
            "openid.realm": FUNCTIONS_BASE,
            "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
            "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
        });
        return res.json({ url: `https://steamcommunity.com/openid/login?${params}` });
    } catch (error) {
        console.error("steamStart", error);
        if (error.message === "RATE_LIMITED") return res.status(429).json({ error: "Muitas tentativas seguidas. Tente de novo mais tarde." });
        return res.status(error.message === "UNAUTHENTICATED" ? 401 : 500).json({ error: "Não foi possível iniciar a conexão com a Steam." });
    }
});

async function verifySteamOpenId(query) {
    const verification = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith("openid.")) verification.set(key, String(value));
    }
    verification.set("openid.mode", "check_authentication");
    const response = await fetch("https://steamcommunity.com/openid/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: verification });
    const text = await response.text();
    return response.ok && /is_valid\s*:\s*true/i.test(text);
}

async function steamJson(path, params) {
    const url = new URL(`https://api.steampowered.com/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`STEAM_API_${response.status}`);
    return response.json();
}

async function steamJsonOptional(path, params) {
    try { return await steamJson(path, params); }
    catch (error) { console.warn("Steam optional data unavailable", path, error.message); return { response: {} }; }
}

async function steamAchievementSummary(key, steamid, game) {
    try {
        const data = await steamJson("ISteamUserStats/GetPlayerAchievements/v1/", { key, steamid, appid: String(game.appid), l: "brazilian" });
        const achievements = data.playerstats?.achievements || [];
        const unlocked = achievements.filter(item => item.achieved === 1).length;
        return { appid: game.appid, name: game.name, total: achievements.length, unlocked, percentage: achievements.length ? Math.round(unlocked / achievements.length * 100) : 0 };
    } catch (error) {
        console.warn("Steam achievements unavailable", game.appid, error.message);
        return null;
    }
}

exports.searchGames = onRequest({ region: "us-central1", secrets: [rawgApiKey] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    try {
        const buscador = await requireFirebaseUser(req);
        await limitarUso(buscador.uid, "searchGames", 60 * 1000, 20);
        const query = String(req.body?.query || "").trim().slice(0, 80);
        const url = new URL("https://api.rawg.io/api/games");
        url.searchParams.set("key", rawgApiKey.value());
        url.searchParams.set("page_size", "24");
        url.searchParams.set("ordering", query ? "-rating" : "-added");
        if (query) { url.searchParams.set("search", query); url.searchParams.set("search_precise", "true"); }
        const response = await fetch(url, { headers: { "User-Agent": "Something Gamer/1.0" } });
        if (!response.ok) throw new Error(`RAWG_${response.status}`);
        const data = await response.json();
        const games = (data.results || []).filter(item => item.name).map(item => ({
            id: String(item.id), name: item.name, source: "rawg", cover: item.background_image || "",
            rating: Number(item.rating || 0), released: item.released || "",
            genres: (item.genres || []).map(genre => genre.name).filter(Boolean).slice(0, 3),
            platforms: (item.parent_platforms || []).map(entry => entry.platform?.name).filter(Boolean)
        }));
        res.set("Cache-Control", "private, max-age=300");
        return res.json({ games });
    } catch (error) {
        console.error("searchGames", error);
        if (error.message === "RATE_LIMITED") return res.status(429).json({ error: "Muitas buscas seguidas. Aguarde um minuto." });
        return res.status(error.message === "UNAUTHENTICATED" ? 401 : 502).json({ error: "O catálogo de jogos está temporariamente indisponível." });
    }
});

exports.steamCallback = onRequest({ region: "us-central1", secrets: [steamApiKey] }, async (req, res) => {
    const state = String(req.query.state || "");
    const stateRef = db.collection("steamAuthStates").doc(state);
    try {
        if (!state) throw new Error("INVALID_STATE");
        const stateSnapshot = await stateRef.get();
        const authState = stateSnapshot.data();
        if (!stateSnapshot.exists || !authState || authState.expiresAt < Date.now()) throw new Error("EXPIRED_STATE");
        await stateRef.delete();
        if (!(await verifySteamOpenId(req.query))) throw new Error("INVALID_OPENID");
        const claimedId = String(req.query["openid.claimed_id"] || "");
        const match = claimedId.match(/\/openid\/id\/(\d{17})$/);
        if (!match) throw new Error("INVALID_STEAM_ID");
        const steamid = match[1];
        const key = steamApiKey.value();
        const [summaryData, gamesData, recentData] = await Promise.all([
            steamJson("ISteamUser/GetPlayerSummaries/v2/", { key, steamids: steamid }),
            steamJsonOptional("IPlayerService/GetOwnedGames/v1/", { key, steamid, include_appinfo: "true", include_played_free_games: "true", format: "json" }),
            steamJsonOptional("IPlayerService/GetRecentlyPlayedGames/v1/", { key, steamid, count: "10", format: "json" })
        ]);
        const player = summaryData.response?.players?.[0];
        if (!player) throw new Error("PROFILE_NOT_FOUND");
        const games = (gamesData.response?.games || []).map(game => ({ appid: game.appid, name: game.name, playtimeForever: game.playtime_forever || 0, playtimeTwoWeeks: game.playtime_2weeks || 0, iconUrl: game.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg` : "" })).sort((a, b) => b.playtimeForever - a.playtimeForever);
        const recentGames = (recentData.response?.games || []).map(game => ({ appid: game.appid, name: game.name, playtimeTwoWeeks: game.playtime_2weeks || 0, playtimeForever: game.playtime_forever || 0 }));
        const achievementResults = await Promise.all(games.slice(0, 12).map(game => steamAchievementSummary(key, steamid, game)));
        const achievements = achievementResults.filter(Boolean);
        await db.collection("users").doc(authState.uid).set({
            steamConnected: true,
            steamProfile: { steamid, personaname: player.personaname, profileurl: player.profileurl, avatar: player.avatarfull, personaState: player.personastate, countryCode: player.loccountrycode || "", lastLogoff: player.lastlogoff || null },
            steamGames: games,
            steamRecentGames: recentGames,
            steamAchievements: achievements,
            steamUpdatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.redirect(302, `${authState.returnOrigin || APP_URL}/steam-callback.html?status=success`);
    } catch (error) {
        console.error("steamCallback", error);
        if (state) await stateRef.delete().catch(() => {});
        return res.redirect(302, `${APP_URL}/steam-callback.html?status=error&reason=${encodeURIComponent(error.message)}`);
    }
});

async function mercadoPago(path, options = {}) {
    const response = await fetch(`https://api.mercadopago.com${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${mercadoPagoToken.value()}`, "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `MERCADO_PAGO_${response.status}`);
    return data;
}

function htmlEscape(value) {
    return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

async function sendEmail({ to, subject, heading, message, code = "" }) {
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey.value()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: emailFrom.value(), to: [to], subject,
            html: `<div style="margin:0;padding:36px 16px;background:#07070a;font-family:Arial,sans-serif;color:#fff"><div style="max-width:560px;margin:auto;padding:34px;border:1px solid #292a35;border-radius:20px;background:#111218"><div style="color:#8070ff;font-size:12px;font-weight:800;letter-spacing:2px">SOMETHING GAMER</div><h1 style="margin:14px 0;font-size:30px">${htmlEscape(heading)}</h1><p style="color:#b5b6c0;font-size:16px;line-height:1.65">${htmlEscape(message)}</p>${code ? `<div style="margin:28px 0;padding:20px;text-align:center;border-radius:14px;background:#1b1c27;font-size:36px;font-weight:900;letter-spacing:10px">${htmlEscape(code)}</div>` : ""}<p style="margin-top:28px;color:#6f707a;font-size:12px;line-height:1.5">Se você não realizou esta ação, ignore esta mensagem e proteja sua conta.</p></div></div>`
        })
    });
    if (!response.ok) throw new Error(`EMAIL_${response.status}`);
    return response.json();
}

function resetHash(email, code) {
    return crypto.createHmac("sha256", resetCodeSecret.value()).update(`${email}:${code}`).digest("hex");
}

exports.requestPasswordResetCode = onRequest({ region: "us-central1", secrets: [resendApiKey, emailFrom, resetCodeSecret] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 254);
    const generic = { ok: true, message: "Se o e-mail estiver cadastrado, o código será enviado." };
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.json(generic);
    const ref = db.collection("passwordResetCodes").doc(crypto.createHash("sha256").update(email).digest("hex"));
    try {
        const previous = await ref.get();
        if (previous.exists && Date.now() - Number(previous.data()?.sentAt || 0) < 60000) return res.json(generic);
        const account = await getAuth().getUserByEmail(email).catch(() => null);
        if (!account || !account.providerData?.some(provider => provider.providerId === "password")) return res.json(generic);
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        await ref.set({ uid: account.uid, email, hash: resetHash(email, code), attempts: 0, sentAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 });
        await sendEmail({ to: email, subject: "Código para redefinir sua senha", heading: "Redefinição de senha", message: "Digite este código no Something Gamer. Ele é válido por 10 minutos e pode ser usado uma única vez.", code });
        return res.json(generic);
    } catch (error) {
        console.error("requestPasswordResetCode", error);
        return res.status(500).json({ error: "Não foi possível enviar o código agora." });
    }
});

exports.confirmPasswordResetCode = onRequest({ region: "us-central1", secrets: [resetCodeSecret] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 254);
    const code = String(req.body?.code || "").replace(/\D/g, "").slice(0, 6);
    const password = String(req.body?.password || "");
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres, uma letra e um número." });
    const ref = db.collection("passwordResetCodes").doc(crypto.createHash("sha256").update(email).digest("hex"));
    try {
        const snapshot = await ref.get(); const data = snapshot.data();
        if (!snapshot.exists || !data || data.expiresAt < Date.now() || data.attempts >= 5 || code.length !== 6) return res.status(400).json({ error: "Código inválido ou expirado." });
        const received = Buffer.from(resetHash(email, code), "hex"), stored = Buffer.from(String(data.hash), "hex");
        if (received.length !== stored.length || !crypto.timingSafeEqual(received, stored)) { await ref.update({ attempts: FieldValue.increment(1) }); return res.status(400).json({ error: "Código inválido ou expirado." }); }
        await getAuth().updateUser(data.uid, { password });
        await getAuth().revokeRefreshTokens(data.uid);
        await ref.delete();
        return res.json({ ok: true });
    } catch (error) {
        console.error("confirmPasswordResetCode", error);
        return res.status(500).json({ error: "Não foi possível redefinir a senha agora." });
    }
});

exports.createVerificationSubscription = onRequest({ region: "us-central1", secrets: [mercadoPagoToken] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    try {
        const user = await requireFirebaseUser(req);
        if (!user.email) return res.status(400).json({ error: "Sua conta precisa ter um e-mail confirmado." });
        const userRef = db.collection("users").doc(user.uid);
        const userSnapshot = await userRef.get();
        const existing = userSnapshot.data()?.verification;
        if (existing?.subscriptionId && ["active", "pending", "payment_pending"].includes(existing.status)) {
            const current = await mercadoPago(`/preapproval/${encodeURIComponent(existing.subscriptionId)}`).catch(() => null);
            if (current?.status === "pending" && current?.init_point) return res.json({ checkoutUrl: current.init_point, reused: true });
            return res.status(409).json({ error: current?.status === "authorized" ? "Seu pagamento já foi confirmado e o perfil está em análise." : "Já existe uma assinatura ou análise em andamento." });
        }
        const billingCycle = req.body?.billingCycle === "annual" ? "annual" : "monthly";
        const subscription = await mercadoPago("/preapproval", { method: "POST", body: JSON.stringify({
            payer_email: user.email,
            external_reference: user.uid,
            reason: `Verificação Gamer ${billingCycle === "annual" ? "Anual" : "Mensal"} no Something Gamer`,
            auto_recurring: { frequency: billingCycle === "annual" ? 12 : 1, frequency_type: "months", transaction_amount: billingCycle === "annual" ? 149.90 : 14.90, currency_id: "BRL" },
            status: "pending",
            back_url: `${APP_URL}/verification.html?payment=returned`,
            notification_url: `${FUNCTIONS_BASE}/mercadoPagoWebhook`
        }) });
        await userRef.set({ verification: { status: "payment_pending", subscriptionId: subscription.id, provider: "mercado_pago", billingCycle, amount: billingCycle === "annual" ? 149.90 : 14.90, requestedAt: FieldValue.serverTimestamp() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return res.json({ checkoutUrl: subscription.init_point });
    } catch (error) {
        console.error("createVerificationSubscription", error);
        return res.status(error.message === "UNAUTHENTICATED" ? 401 : 500).json({ error: "Não foi possível iniciar a assinatura." });
    }
});

exports.getVerificationSubscription = onRequest({ region: "us-central1", secrets: [mercadoPagoToken] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    try {
        const user = await requireFirebaseUser(req);
        const snapshot = await db.collection("users").doc(user.uid).get();
        const verification = snapshot.data()?.verification;
        if (!verification?.subscriptionId) return res.json({ message: "Nenhuma assinatura encontrada." });
        const subscription = await mercadoPago(`/preapproval/${encodeURIComponent(verification.subscriptionId)}`);
        const paymentStatus = subscription.status || "unknown";
        const nextStatus = paymentStatus === "authorized" ? (verification.reviewed ? "active" : "pending") : (["cancelled", "paused"].includes(paymentStatus) ? "suspended" : "payment_pending");
        await db.collection("users").doc(user.uid).set({ verification: { status: nextStatus, paymentStatus, subscriptionId: verification.subscriptionId, provider: "mercado_pago", paymentUpdatedAt: FieldValue.serverTimestamp() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        const messages = { active: "Verificação ativa.", pending: "Pagamento confirmado. Seu perfil está em análise.", payment_pending: "Pagamento ainda não concluído.", suspended: "Assinatura pausada ou cancelada." };
        return res.json({ status: nextStatus, paymentStatus, message: messages[nextStatus], subscriptionUrl: subscription.init_point || "" });
    } catch (error) {
        console.error("getVerificationSubscription", error);
        return res.status(error.message === "UNAUTHENTICATED" ? 401 : 500).json({ error: "Não foi possível consultar a assinatura." });
    }
});

function assinaturaMercadoPagoValida(req, dataId) {
    const bruta = req.get("x-signature") || "";
    const requestId = req.get("x-request-id") || "";
    const partes = Object.fromEntries(bruta.split(",").map(item => item.split("=").map(valor => valor.trim())).filter(item => item.length === 2));
    if (!partes.ts || !partes.v1) return false;
    const manifesto = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${partes.ts};`;
    const esperado = crypto.createHmac("sha256", mercadoPagoWebhookSecret.value()).update(manifesto).digest();
    let recebido;
    try { recebido = Buffer.from(partes.v1, "hex"); } catch { return false; }
    return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

exports.mercadoPagoWebhook = onRequest({ region: "us-central1", secrets: [mercadoPagoToken, resendApiKey, emailFrom, mercadoPagoWebhookSecret] }, async (req, res) => {
    try {
        const subscriptionId = String(req.query["data.id"] || req.body?.data?.id || req.body?.id || "");
        if (!subscriptionId) return res.status(200).json({ received: true });
        if (!assinaturaMercadoPagoValida(req, subscriptionId)) {
            console.error("mercadoPagoWebhook: assinatura inválida", { requestId: req.get("x-request-id") || "" });
            return res.status(401).json({ error: "Assinatura inválida." });
        }
        const subscription = await mercadoPago(`/preapproval/${encodeURIComponent(subscriptionId)}`);
        const uid = String(subscription.external_reference || "");
        if (!uid) return res.status(200).json({ received: true });
        const paid = subscription.status === "authorized";
        const userRef = db.collection("users").doc(uid);
        const before = await userRef.get();
        await userRef.set({ verification: {
            status: paid ? "pending" : (["cancelled", "paused"].includes(subscription.status) ? "suspended" : "payment_pending"),
            paymentStatus: subscription.status || "unknown",
            subscriptionId,
            provider: "mercado_pago",
            reviewed: false,
            paymentUpdatedAt: FieldValue.serverTimestamp()
        }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        if (paid && !before.data()?.verification?.purchaseEmailSentAt) {
            const account = await getAuth().getUser(uid).catch(() => null);
            if (account?.email) {
                await sendEmail({ to: account.email, subject: "Pagamento confirmado da Verificação Gamer", heading: "Pagamento confirmado", message: "Sua assinatura da Verificação Gamer foi confirmada. Seu perfil agora seguirá para análise administrativa." });
                await userRef.set({ verification: { purchaseEmailSentAt: FieldValue.serverTimestamp() } }, { merge: true });
            }
        }
        return res.status(200).json({ received: true });
    } catch (error) {
        console.error("mercadoPagoWebhook", error);
        return res.status(500).json({ error: "Webhook não processado." });
    }
});

exports.syncVerificationSubscriptions = onSchedule({ region: "us-central1", schedule: "every 24 hours", secrets: [mercadoPagoToken] }, async () => {
    const snapshot = await db.collection("users").where("verification.provider", "==", "mercado_pago").limit(500).get();
    for (const item of snapshot.docs) {
        const verification = item.data().verification;
        if (!verification?.subscriptionId) continue;
        try {
            const subscription = await mercadoPago(`/preapproval/${encodeURIComponent(verification.subscriptionId)}`);
            const authorized = subscription.status === "authorized";
            const nextStatus = authorized ? (verification.reviewed ? "active" : "pending") : (["cancelled", "paused"].includes(subscription.status) ? "suspended" : verification.status);
            const validityDays = verification.billingCycle === "annual" ? 370 : 32;
            await item.ref.update({
                "verification.status": nextStatus,
                "verification.paymentStatus": subscription.status || "unknown",
                "verification.expiresAt": authorized && verification.reviewed ? Timestamp.fromMillis(Date.now() + validityDays * 24 * 60 * 60 * 1000) : verification.expiresAt || null,
                "verification.paymentUpdatedAt": FieldValue.serverTimestamp()
            });
        } catch (error) { console.error("syncVerificationSubscriptions", item.id, error); }
    }
});

async function requireAdmin(req) {
    const user = await requireFirebaseUser(req);
    const porEmail = user.email && user.email_verified === true && ADMIN_EMAILS.includes(String(user.email).toLowerCase());
    if (user.uid !== adminUid.value() && !porEmail) throw new Error("FORBIDDEN");
    return user;
}

// As notificações não tinham fim: nasciam, eram lidas e ficavam. Trinta dias e saem.
exports.limparNotificacoesAntigas = onSchedule({ region: "us-central1", schedule: "every 24 hours" }, async () => {
    const corte = Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let removidas = 0;
    for (let volta = 0; volta < 25; volta++) {
        const lote = await db.collection("notifications").where("createdAt", "<", corte).limit(400).get();
        if (lote.empty) break;
        const batch = db.batch();
        lote.docs.forEach(item => batch.delete(item.ref));
        await batch.commit();
        removidas += lote.size;
        if (lote.size < 400) break;
    }
    console.log(`notificações antigas removidas: ${removidas}`);
});

// Mesma coisa para os contadores de uso.
exports.limparRateLimits = onSchedule({ region: "us-central1", schedule: "every 24 hours" }, async () => {
    const lote = await db.collection("rateLimits").where("inicio", "<", Date.now() - 24 * 60 * 60 * 1000).limit(400).get();
    if (lote.empty) return;
    const batch = db.batch();
    lote.docs.forEach(item => batch.delete(item.ref));
    await batch.commit();
});

exports.syncAdminXbox = onRequest({ region: "us-central1", secrets: [adminUid, openXblApiKey] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    try {
        const user = await requireAdmin(req);
        const response = await fetch("https://api.xbl.io/v2/account", { headers: { "X-Authorization": openXblApiKey.value(), Accept: "application/json" } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`OPENXBL_${response.status}`);
        const profile = data.profileUsers?.[0] || data.people?.[0] || data;
        const settings = Object.fromEntries((profile.settings || []).map(item => [item.id, item.value]));
        const xboxProfile = {
            xuid: String(profile.id || profile.xuid || data.xuid || ""),
            gamertag: settings.GameDisplayName || settings.Gamertag || profile.gamertag || data.gamertag || "Xbox",
            gamerPicture: settings.GameDisplayPicRaw || settings.DisplayPicRaw || profile.displayPicRaw || "",
            gamerscore: Number(settings.Gamerscore || profile.gamerScore || 0),
            accountTier: settings.AccountTier || ""
        };
        await db.collection("users").doc(user.uid).set({ xboxConnected: true, xboxProfile, xboxUpdatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return res.json({ ok: true, profile: xboxProfile });
    } catch (error) {
        console.error("syncAdminXbox", error);
        const status = error.message === "FORBIDDEN" ? 403 : error.message === "UNAUTHENTICATED" ? 401 : 502;
        return res.status(status).json({ error: status === 403 ? "A integração OpenXBL está limitada à conta administrativa." : "Não foi possível consultar a OpenXBL. Verifique a chave e tente novamente." });
    }
});

exports.adminApi = onRequest({ region: "us-central1", secrets: [adminUid, resendApiKey, emailFrom] }, async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });
    try {
        await requireAdmin(req);
        const action = String(req.body?.action || "");
        if (action === "dashboard") {
            const [usersSnapshot, promotionsSnapshot] = await Promise.all([db.collection("users").limit(500).get() /* sem-orderby: users antigos podem não ter accountCreatedAt */, db.collection("promotions").orderBy("createdAt", "desc").limit(50).get()]);
            const users = usersSnapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
            const promotions = promotionsSnapshot.docs.map(item => ({ id: item.id, ...item.data(), createdAt: undefined, endsAt: undefined }));
            return res.json({ users, promotions, stats: { total: users.length, verified: users.filter(item => item.verification?.status === "active").length, pending: users.filter(item => ["pending", "payment_pending"].includes(item.verification?.status)).length } });
        }
        if (action === "setVerification") {
            const uid = String(req.body?.uid || "");
            const status = String(req.body?.status || "");
            if (!uid || !["active", "suspended", "none"].includes(status)) return res.status(400).json({ error: "Dados inválidos." });
            const targetRef = db.collection("users").doc(uid);
            const targetSnapshot = await targetRef.get();
            const validityDays = targetSnapshot.data()?.verification?.billingCycle === "annual" ? 370 : 32;
            const value = status === "none" ? FieldValue.delete() : { ...(targetSnapshot.data()?.verification || {}), status, reviewed: true, reviewedAt: FieldValue.serverTimestamp(), source: "admin", expiresAt: status === "active" ? Timestamp.fromMillis(Date.now() + validityDays * 24 * 60 * 60 * 1000) : null };
            await targetRef.update({ verification: value, updatedAt: FieldValue.serverTimestamp() });
            if (status === "active") {
                const account = await getAuth().getUser(uid).catch(() => null);
                if (account?.email) await sendEmail({ to: account.email, subject: "Seu selo Something Gamer foi aprovado", heading: "Você agora é Gamer Verificado", message: "Seu perfil foi aprovado. O selo de Verificação Gamer já está disponível no seu perfil e nas suas publicações." }).catch(error => console.error("verification approval email", error));
            }
            return res.json({ ok: true });
        }
        if (action === "setBadge") {
            const uid = String(req.body?.uid || "");
            const badge = String(req.body?.badge || "");
            if (!uid || !["nowFollowed", "sgFollowed"].includes(badge)) return res.status(400).json({ error: "Selo inválido." });
            await db.collection("users").doc(uid).set({ badges: { [badge]: Boolean(req.body?.enabled) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            return res.json({ ok: true });
        }
        if (action === "createPromotion") {
            const title = String(req.body?.title || "").trim();
            const description = String(req.body?.description || "").trim();
            const buttonUrl = String(req.body?.buttonUrl || "").trim();
            if (!title || !description || title.length > 70 || description.length > 180) return res.status(400).json({ error: "Revise o título e a descrição." });
            if (buttonUrl && !/^https?:\/\//i.test(buttonUrl)) return res.status(400).json({ error: "O link precisa começar com http:// ou https://." });
            await db.collection("promotions").add({ title, description, buttonLabel: String(req.body?.buttonLabel || "Aproveitar").trim().slice(0,30), buttonUrl, endsAt: req.body?.endsAt ? Timestamp.fromDate(new Date(req.body.endsAt)) : null, active: true, createdAt: FieldValue.serverTimestamp() });
            return res.json({ ok: true });
        }
        if (action === "togglePromotion") {
            await db.collection("promotions").doc(String(req.body?.id || "")).update({ active: Boolean(req.body?.active), updatedAt: FieldValue.serverTimestamp() });
            return res.json({ ok: true });
        }
        return res.status(400).json({ error: "Ação inválida." });
    } catch (error) {
        console.error("adminApi", error);
        return res.status(error.message === "FORBIDDEN" ? 403 : error.message === "UNAUTHENTICATED" ? 401 : 500).json({ error: error.message === "FORBIDDEN" ? "Acesso restrito ao administrador." : "Não foi possível concluir a operação." });
    }
});
