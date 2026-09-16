import { auth, db } from "./firebase.js";
import { APP_CONFIG } from "./config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const status = document.getElementById("verificationStatus");
const subscribe = document.getElementById("subscribeVerification");
const manage = document.getElementById("manageSubscription");
const toast = document.getElementById("appToast");
let user = null;
let billingCycle = "monthly";
let verification = null;

function notify(message, type = "error") {
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add("show");
    clearTimeout(notify.timeout);
    notify.timeout = setTimeout(() => toast.classList.remove("show"), 4200);
}

async function callFunction(name, body = {}) {
    const token = await user.getIdToken(true);
    const response = await fetch(`${APP_CONFIG.functionsBaseUrl}/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Serviço indisponível.");
    return payload;
}

function paintStatus(value = {}) {
    verification = { ...verification, ...value };
    const labels = {
        active: "Verificação ativa no seu perfil",
        pending: "Pagamento confirmado. Seu perfil está em análise",
        payment_pending: "Assinatura iniciada. Conclua o pagamento",
        suspended: "Verificação suspensa. Confira sua assinatura",
        expired: "Verificação expirada"
    };
    status.textContent = labels[verification.status] || "Sua conta ainda não possui a Verificação Gamer.";
    const locked = ["active", "pending"].includes(verification.status);
    subscribe.disabled = locked;
    if (verification.status === "active") subscribe.textContent = "Selo ativo";
    if (verification.status === "pending") subscribe.textContent = "Perfil em análise";
    manage.disabled = !verification.subscriptionId;
}

async function synchronizePayment(showMessage = false) {
    const result = await callFunction("getVerificationSubscription");
    paintStatus(result);
    if (showMessage) notify(result.message || "Situação atualizada.", result.status === "payment_pending" ? "error" : "success");
    return result;
}

auth.onAuthStateChanged(async current => {
    if (!current) return window.location.replace("login.html");
    user = current;
    const snapshot = await getDoc(doc(db, "users", current.uid));
    verification = snapshot.data()?.verification || {};
    paintStatus(verification);
    if (new URLSearchParams(location.search).get("payment") === "returned" && verification.subscriptionId) {
        status.textContent = "Confirmando seu pagamento com o Mercado Pago...";
        try {
            let result = await synchronizePayment(false);
            for (let attempt = 0; attempt < 3 && result.status === "payment_pending"; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 2500));
                result = await synchronizePayment(false);
            }
            notify(result.message || "Situação atualizada.", result.status === "payment_pending" ? "error" : "success");
            history.replaceState({}, "", "verification.html");
        } catch (error) {
            notify(error.message);
            paintStatus(verification);
        }
    }
});

document.querySelectorAll(".plan-option").forEach(button => button.addEventListener("click", () => {
    billingCycle = button.dataset.plan;
    document.querySelectorAll(".plan-option").forEach(item => item.classList.toggle("active", item === button));
    const annual = billingCycle === "annual";
    document.getElementById("verificationPrice").innerHTML = `<small>R$</small> ${annual ? "149,90" : "14,90"}`;
    document.getElementById("verificationPeriod").innerHTML = annual ? "por ano<br>economia de R$ 28,90" : "por mês<br>cancele quando quiser";
    if (!["active", "pending"].includes(verification?.status)) subscribe.textContent = "Ir para o pagamento";
}));

subscribe.addEventListener("click", async () => {
    try {
        subscribe.disabled = true;
        subscribe.textContent = "Abrindo Mercado Pago...";
        const result = await callFunction("createVerificationSubscription", { billingCycle });
        const checkout = new URL(result.checkoutUrl);
        if (checkout.protocol !== "https:" || !/(^|\.)mercadopago\.com(\.br)?$/.test(checkout.hostname)) throw new Error("Link de pagamento inválido.");
        window.location.assign(checkout.href);
    } catch (error) {
        notify(error.message);
        subscribe.disabled = false;
        subscribe.textContent = "Ir para o pagamento";
    }
});

manage.addEventListener("click", async () => {
    try {
        manage.disabled = true;
        const result = await synchronizePayment(true);
        if (result.status === "payment_pending" && result.subscriptionUrl) window.open(result.subscriptionUrl, "_blank", "noopener");
    } catch (error) {
        notify(error.message);
    } finally {
        manage.disabled = !verification?.subscriptionId;
    }
});
