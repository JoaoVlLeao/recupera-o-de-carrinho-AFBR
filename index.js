// index.js - Bot AquaFit (APENAS CARRINHO: Payload Real + Segurança + QR Code Web com Refresh + Retry Gemini)
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import wwebjs from 'whatsapp-web.js';
import qrcode from "qrcode"; 

const { Client, LocalAuth, MessageMedia } = wwebjs;

// ======================= PREVENÇÃO DE CRASH (ANTI-STOPPING CONTAINER) =======================
process.on('uncaughtException', (err) => {
    console.error('🔥 CRÍTICO: Erro não tratado (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 CRÍTICO: Rejeição de promessa não tratada:', reason);
});

// ======================= CONFIGURAÇÃO DE ARQUIVOS =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, ".data"); 

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const PERSISTENCE_FILE = path.join(DATA_DIR, "bot_state.json");
const STORE_FILE = path.join(DATA_DIR, "wpp_store.json");

// ======================= GEMINI SETUP =======================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// MANTIDO O MODELO SOLICITADO
const MODEL_NAME = "gemini-2.5-pro"; 

// ======================= ELEVENLABS (GERAÇÃO DE ÁUDIO) =======================
async function gerarAudioCarolina(nomeCliente) {
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID; 
    const API_KEY = process.env.ELEVENLABS_API_KEY;
    
    // TRUQUE DE HUMANIZAÇÃO: Reticências e vírgulas forçam a IA a fazer pausas dramáticas/respirar.
    const texto = `Oie, ${nomeCliente}... tudo bem? Aqui é a Carolina, da AquaFit Brasil. Eu vi que você deixou alguns itens lá no carrinho... e decidi passar aqui rapidinho, pra te liberar um cupom de desconto super exclusivo!`;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Accept": "audio/mpeg",
                "xi-api-key": API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text: texto,
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    // Diminuímos a estabilidade para dar mais 'emoção' e menos tom de robô
                    stability: 0.35, 
                    // Aumentamos a similaridade para cravar o sotaque da voz original
                    similarity_boost: 0.85 
                }
            })
        });

        if (!response.ok) throw new Error(`Erro ElevenLabs: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    } catch (error) {
        console.error("⚠️ Erro na geração de áudio:", error.message);
        return null;
    }
}
// ======================= STORE LOCAL =======================
function makeLocalInMemoryStore() {
    const messages = {}; 
    return {
        messages,
        saveWppMessage(msg) {
            try {
                const remoteJid = msg.fromMe ? msg.to : msg.from;
                if (!remoteJid) return;
                
                const fakeMsg = {
                    key: { remoteJid, fromMe: msg.fromMe, id: msg.id.id },
                    message: { conversation: msg.body || "" },
                    pushName: msg._data?.notifyName || ""
                };

                if (!messages[remoteJid]) messages[remoteJid] = { array: [] };
                const exists = messages[remoteJid].array.some(m => m.key.id === fakeMsg.key.id);
                if (!exists) {
                    messages[remoteJid].array.push(fakeMsg);
                    if (messages[remoteJid].array.length > 50) messages[remoteJid].array.shift(); 
                }
                return fakeMsg;
            } catch (e) { return null; }
        },
        writeToFile(path) { try { fs.writeFileSync(path, JSON.stringify(messages)); } catch (e) {} },
        readFromFile(path) { 
            try { 
                if (fs.existsSync(path)) Object.assign(messages, JSON.parse(fs.readFileSync(path))); 
            } catch (e) {} 
        }
    };
}

const store = makeLocalInMemoryStore();
try { store.readFromFile(STORE_FILE); } catch(e) {}

setInterval(() => { store.writeToFile(STORE_FILE); }, 30000);

// ======================= HELPERS =======================
function appendHiddenTag(text, id) {
    if (!text || !id) return text;
    const idStr = id.toString();
    const encoded = idStr.split('').map(char => {
        const binary = char.charCodeAt(0).toString(2);
        return binary.replace(/0/g, '\u200B').replace(/1/g, '\u200C');
    }).join('\u2060'); 
    return `${text} \u200D${encoded}\u200D`;
}

function normalizeChatKey(jid) {
    if (!jid) return null;
    return jid.replace("@s.whatsapp.net", "").replace("@lid", "").replace("@c.us", "").replace(/\D/g, "");
}

function safeReadJSON(file, fallback) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback; } catch (e) { return fallback; }
}

function safeWriteJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ======================= VALIDAÇÃO DE NÚMERO ROBUSTA (FIX NO-LID) =======================
async function getWhatsappId(client, number) {
    // 1. Limpeza básica
    let cleanNumber = number.replace(/\D/g, "");
    
    // 2. Garante DDI 55 se não tiver e parecer BR
    if (!cleanNumber.startsWith("55") && (cleanNumber.length === 10 || cleanNumber.length === 11)) {
        cleanNumber = "55" + cleanNumber;
    }

    try {
        // Tentativa 1: Do jeito que veio
        const id1 = await client.getNumberId(cleanNumber);
        if (id1) return id1._serialized;

        // Lógica específica para Brasil (DDD + 9 dígitos vs 8 dígitos)
        if (cleanNumber.startsWith("55") && cleanNumber.length >= 12) {
            const ddd = cleanNumber.substring(2, 4);
            const resto = cleanNumber.substring(4);

            let tentativa2 = "";
            
            if (resto.length === 9 && resto.startsWith("9")) {
                // Tem 9 digitos, tenta tirar o 9
                tentativa2 = "55" + ddd + resto.substring(1);
            } else if (resto.length === 8) {
                // Tem 8 digitos, tenta por o 9
                tentativa2 = "55" + ddd + "9" + resto;
            }

            if (tentativa2) {
                const id2 = await client.getNumberId(tentativa2);
                if (id2) return id2._serialized;
            }
        }
    } catch (e) {
        console.error("Erro ao validar número:", e.message);
    }
    
    return null; // Retorna null se falhar, para não quebrar o send
}

// ======================= ESTADO =======================
const conversationsByKey = new Map(); 
const lidCache = new Map(); 
const allowedChats = new Set(); 
const messageBuffers = new Map();
let latestQrCode = null; 

function loadState() {
    const data = safeReadJSON(PERSISTENCE_FILE, { conversations: {}, lidCache: {}, allowed: [] });
    for (const [key, val] of Object.entries(data.conversations || {})) conversationsByKey.set(key, val);
    for (const [key, val] of Object.entries(data.lidCache || {})) lidCache.set(key, val);
    data.allowed?.forEach(k => allowedChats.add(k));
    console.log(`💾 Estado: ${conversationsByKey.size} vendas | ${lidCache.size} LIDs.`);
}

function persistState() {
    safeWriteJSON(PERSISTENCE_FILE, {
        conversations: Object.fromEntries(conversationsByKey),
        lidCache: Object.fromEntries(lidCache),
        allowed: [...allowedChats]
    });
}

function ensureConversation(key) {
    if (!conversationsByKey.has(key)) {
        conversationsByKey.set(key, { chatId: key, dadosCliente: {}, history: [] });
        persistState();
    }
    return conversationsByKey.get(key);
}

loadState();

// ======================= LID MATCHING =======================
async function resolveContactId(msg) {
    let rawId = msg.fromMe ? msg.to : msg.from;
    if (lidCache.has(rawId)) return lidCache.get(rawId);
    if (!rawId.includes("@lid")) return normalizeChatKey(rawId);

    try {
        const chat = await msg.getChat();
        const msgs = await chat.fetchMessages({ limit: 15 });
        const lastMsgByMe = msgs.reverse().find(m => m.fromMe);

        if (lastMsgByMe && lastMsgByMe.body) {
            const textSentInChat = lastMsgByMe.body.trim();
            for (const [phoneKey, convData] of conversationsByKey.entries()) {
                if (!allowedChats.has(phoneKey)) continue;
                const lastMemoryMsg = [...convData.history].reverse().find(m => m.role === 'model');
                if (lastMemoryMsg && lastMemoryMsg.parts && lastMemoryMsg.parts[0].text) {
                    const memoryText = lastMemoryMsg.parts[0].text.trim();
                    if (textSentInChat.includes(memoryText) || memoryText.includes(textSentInChat)) {
                        lidCache.set(rawId, phoneKey);
                        persistState();
                        return phoneKey;
                    }
                }
            }
        }
    } catch (e) { console.error("Erro LID:", e.message); }
    return null; 
}

// ======================= INTELIGÊNCIA ARTIFICIAL (GEMINI) =======================

const PROMPT_CARRINHO = `
Você é a Carolina, consultora de vendas da AquaFit Brasil.
OBJETIVO: Recuperar Carrinho Abandonado.
PERSONALIDADE: Amiga, breve, natural.

CONTEXTO IMPORTANTE: Você acabou de enviar um ÁUDIO para a cliente dizendo "Oie [Nome], tudo bem? Aqui é a Carolina da AquaFit Brasil. Vi que você deixou alguns itens no carrinho e decidi passar aqui rapidinho pra te liberar um cupom de desconto exclusivo!".

INSTRUÇÃO OBRIGATÓRIA PARA A PRIMEIRA MENSAGEM DE TEXTO:
- NÃO se apresente novamente e NÃO diga "oi" ou "tudo bem" de novo. O áudio já fez isso.
- Apenas envie o link para finalizar a compra: {LINK}
- Informe o cupom de desconto válido para hoje (Cupom: DSC20).
- Pergunte de forma natural se ela teve alguma dificuldade no site ou se ficou com alguma dúvida sobre os produtos.

REGRAS GERAIS:
1. Tente converter a venda oferecendo ajuda.
2. Responda todas as dúvidas dela para que ela finalize a compra. 
3. Nunca mencione envio internacional.
4. Nunca fale em dias úteis.
5. Diga que o prazo médio de entrega é de 7 a 14 dias.
6. O código de rastreamento é enviado em até 24h após a compra.
7. As entregas são feitas pelos Correios.
`;

async function gerarRespostaGemini(historico, dados) {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    
    let systemInstruction = PROMPT_CARRINHO;
    let promptUsuario = `
        Contexto Carrinho:
        Cliente: ${dados.nome}
        Produtos: ${dados.produtos}
        Link: ${dados.link}
        
        Se for a primeira mensagem, gere EXATAMENTE conforme a "INSTRUÇÃO OBRIGATÓRIA PARA A PRIMEIRA MENSAGEM", substituindo o {LINK} pelo link original.
        `;

    const chat = model.startChat({
        history: [
            { role: "user", parts: [{ text: `Instrução do Sistema: ${systemInstruction}` }] },
            ...historico
        ]
    });

    let msgEnvio = "Gere a próxima resposta.";
    if (historico.length === 0) {
        msgEnvio = promptUsuario;
    }

    // FIX: LIMITADOR DE TENTATIVAS PARA EVITAR LOOP INFINITO NO ERRO 503
    let tentativas = 0;
    const maxTentativas = 3; 

    while (tentativas < maxTentativas) {
        try {
            const result = await chat.sendMessage(msgEnvio);
            return result.response.text();
        } catch (error) {
            tentativas++;
            console.error(`⚠️ Erro Gemini (${tentativas}/${maxTentativas}): ${error.message}`);
            
            if (tentativas >= maxTentativas) {
                console.error("❌ Gemini indisponível após 3 tentativas. Abortando para evitar spam.");
                return "Desculpe, estou verificando uma informação no sistema. Poderia me chamar novamente em alguns instantes?";
            }
            // Aguarda 20 segundos antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 20000));
        }
    }
}

// ======================= CLIENTE WHATSAPP =======================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
    puppeteer: {
        headless: true,
        // FLAGS OTIMIZADAS PARA RAILWAY (Igual ao código do PIX)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    }
});

// GERA O QR CODE PARA EXIBIÇÃO NA WEB
client.on('qr', (qr) => {
    console.log('QR RECEIVED no Terminal');
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
            latestQrCode = url; 
        }
    });
});

client.on('ready', () => {
    console.log('✅ Bot Online (APENAS CARRINHO)!');
    latestQrCode = "CONNECTED"; 
});

client.on('disconnected', (reason) => {
    console.log('❌ Cliente desconectado! Tentando reconectar...', reason);
    latestQrCode = null;
    client.initialize();
});

client.on('message_create', async (msg) => {
    store.saveWppMessage(msg);
    if (msg.fromMe || msg.isStatus) return;

    const realKey = await resolveContactId(msg);
    if (!realKey || !allowedChats.has(realKey)) return;

    console.log(`💬 Msg de ${realKey} (Bufferizando): ${msg.body}`);

    let buffer = messageBuffers.get(realKey);
    if (!buffer) {
        buffer = { texts: [], timer: null };
        messageBuffers.set(realKey, buffer);
    }
    buffer.texts.push(msg.body);

    if (buffer.timer) clearTimeout(buffer.timer);

    buffer.timer = setTimeout(async () => {
        messageBuffers.delete(realKey);
        const textoCompleto = buffer.texts.join("\n");
        console.log(`⏱️ Buffer finalizado para ${realKey}.`);

        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
        } catch(e) {}

        await new Promise(r => setTimeout(r, 20000)); 

        const conv = ensureConversation(realKey);
        conv.history.push({ role: "user", parts: [{ text: textoCompleto }] });

        let resposta = await gerarRespostaGemini(conv.history, conv.dadosCliente);
        resposta = appendHiddenTag(resposta, realKey);

        const sentMsg = await client.sendMessage(msg.from, resposta);
        store.saveWppMessage(sentMsg);

        conv.history.push({ role: "model", parts: [{ text: resposta }] });
        persistState();

        try {
            const chat = await msg.getChat();
            await chat.clearState();
        } catch(e) {}

    }, 30000); 
});

client.initialize();

// ======================= WEBHOOK YAMPI & SERVER =======================
const app = express();
app.use(express.json());
app.use(cors());

// Função auxiliar para encontrar o valor dentro de objetos aninhados
const getSafe = (obj, path) => {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};

// ROTA COM AUTO-REFRESH PARA O QR CODE
app.get('/', (req, res) => {
    // Cabeçalho de refresh a cada 3 segundos
    const metaRefresh = '<meta http-equiv="refresh" content="3">';
    const style = '<style>body{font-family:sans-serif;text-align:center;padding-top:50px;}</style>';

    if (latestQrCode === "CONNECTED") {
        res.send(`
            <html><head>${style}</head>
            <body>
                <h1>✅ Bot Conectado com Sucesso!</h1>
                <p>Você pode fechar esta página.</p>
            </body></html>
        `);
    } else if (latestQrCode) {
        res.send(`
            <html><head>${metaRefresh}${style}</head>
            <body>
                <h1>Escaneie o QR Code abaixo:</h1>
                <p>A página atualiza sozinha a cada 3 segundos para garantir que o código seja válido.</p>
                <img src="${latestQrCode}" width="300"/>
            </body></html>
        `);
    } else {
        res.send(`
            <html><head>${metaRefresh}${style}</head>
            <body>
                <h1>Aguardando QR Code...</h1>
                <p>O sistema está iniciando. Aguarde...</p>
            </body></html>
        `);
    }
});

app.post('/webhook/yampi', async (req, res) => {
    try {
        const data = req.body;
        // LOG SIMPLIFICADO PARA EVITAR POLUIÇÃO NO CONSOLE
        console.log(`📥 Payload Yampi Recebido: Evento [${data.event}]`); 

        const resource = data.resource || {};
        
        // --- LÓGICA DE FILTRO: APENAS CARRINHO ---
        let tipoEvento = null;

        if (data.event === "checkout.abandoned" || data.event === "cart.reminder") {
            tipoEvento = "Carrinho Abandonado";
        } else {
            console.log(`🛑 Evento ignorado (${data.event}). Não é Carrinho Abandonado.`);
            return res.status(200).send("Ignored");
        }
        
        let telefone = 
            getSafe(resource, "customer.data.phone.full_number") || 
            getSafe(resource, "customer.phone.full_number") || 
            getSafe(resource, "customer.phone.mobile") ||
            getSafe(resource, "shipping_address.data.phone.full_number") ||
            getSafe(resource, "shipping_address.phone.full_number") ||
            getSafe(resource, "spreadsheet.data.customer_phone") ||
            getSafe(resource, "phone.full_number") || 
            "";

        telefone = telefone.replace(/\D/g, "");
        
        if (!telefone) {
            console.log("❌ Telefone não encontrado no payload.");
            return res.status(400).send("Sem telefone");
        }

        if (telefone.length <= 11) telefone = "55" + telefone;

        // FIX: Uso robusto de ID com fallback provisório para garantir o Webhook
        let chatIdFinal = `${telefone}@c.us`; 

        try {
            const validId = await getWhatsappId(client, telefone);
            if (validId) {
                chatIdFinal = validId;
            } else {
                console.log(`⚠️ Número não validado pela API. Usando ID provisório: ${chatIdFinal}`);
            }
        } catch (e) {
            console.error("Erro na validação do número:", e.message);
        }

        const systemKey = normalizeChatKey(chatIdFinal);

        const nomeCliente = 
            getSafe(resource, "customer.data.name") || 
            getSafe(resource, "customer.data.full_name") ||
            resource.customer_name || 
            "Cliente";

        const itemsList = getSafe(resource, "items.data") || resource.items || [];
        const produtosStr = Array.isArray(itemsList) ? itemsList.map(i => i.product_name || getSafe(i, "sku.data.title") || "Produto").join(", ") : "Produtos";

        // --- FORMATAÇÃO DO LINK (MANTIDO) ---
        let rawLink = resource.checkout_url || resource.simulate_url || resource.status_url || "";
        let finalLink = rawLink;

        if (rawLink) {
            try {
                const urlObj = new URL(rawLink);
                const cartToken = urlObj.searchParams.get("cart_token");
                // Reconstrói o link apenas com a base e o token essencial
                finalLink = `${urlObj.origin}${urlObj.pathname}${cartToken ? '?cart_token=' + cartToken : ''}`;
            } catch (err) {
                console.error("Erro ao formatar link:", err.message);
            }
        }

        const dados = {
            nome: nomeCliente,
            tipo: tipoEvento,
            produtos: produtosStr,
            link: finalLink,
            valor: resource.total_price || getSafe(resource, "totalizers.total") || "Valor total"
        };

        const conv = ensureConversation(systemKey);
        conv.dadosCliente = dados;
        conv.history = []; 
        allowedChats.add(systemKey);
        persistState();

        console.log(`🚀 Start: ${dados.nome} - ${tipoEvento} - Tel: ${telefone} - ID: ${chatIdFinal}`);

        // --- 1. GERA E ENVIA O ÁUDIO DA CAROLINA PRIMEIRO ---
        console.log("🎙️ Gerando áudio da Carolina...");
        
        // Pega só o primeiro nome da cliente para o áudio soar natural
        const primeiroNome = dados.nome ? dados.nome.split(" ")[0] : "amiga"; 
        const audioBase64 = await gerarAudioCarolina(primeiroNome); 
        
        if (audioBase64) {
            try {
                // Envia o áudio como se estivesse segurando o botão de gravar (PTT)
                const mediaAudio = new MessageMedia('audio/mpeg', audioBase64, 'carolina_audio.mp3');
                await client.sendMessage(chatIdFinal, mediaAudio, { sendAudioAsVoice: true });
                console.log("✅ Áudio enviado com sucesso!");
                
                // Pausa de 4 segundos para parecer humano "digitando" a próxima mensagem
                await new Promise(r => setTimeout(r, 4000)); 
            } catch (errAudio) {
                console.error("⚠️ Erro ao enviar o áudio no WhatsApp:", errAudio);
            }
        } else {
            console.log("⚠️ Áudio não gerado (verifique a API). Seguindo só com texto.");
        }

        // --- 2. GERA E ENVIA A IMAGEM COM O TEXTO (LINK/CUPOM) ---
        let msgInicial = await gerarRespostaGemini([], dados);
        msgInicial = appendHiddenTag(msgInicial, systemKey);

        try {
            const media = await MessageMedia.fromUrl('https://cdn.shopify.com/s/files/1/0830/2385/5932/files/Descontos_de_ate_70_16.png?v=1771091829');
            const sentMsg = await client.sendMessage(chatIdFinal, media, { caption: msgInicial });
            store.saveWppMessage(sentMsg);
        } catch (err) {
            console.error("Erro imagem:", err);
            const sentMsg = await client.sendMessage(chatIdFinal, msgInicial);
            store.saveWppMessage(sentMsg);
        }

        conv.history.push({ role: "model", parts: [{ text: msgInicial }] });
        persistState();

        res.status(200).send("OK");
    } catch (e) {
        console.error("Erro Webhook:", e);
        res.status(500).send("Erro Interno");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`👂 Webhook na porta ${PORT}`));