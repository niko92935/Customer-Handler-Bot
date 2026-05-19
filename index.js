const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================
// Config file path
// ============================================================
const CONFIG_FILE = path.join(__dirname, 'shop_config.json');

// ============================================================
// Default config
// ============================================================
function getDefaultConfig() {
    return {
        shop: {
            name: 'আমার Shop',
            location: 'ঢাকা, বাংলাদেশ',
            phone: '01XXXXXXXXX',
            deliveryInside: '৬০',
            deliveryOutside: '১২০',
            payment: 'bKash, Nagad, Cash on Delivery',
        },
        bot: {
            geminiApiKey: '',
            ollamaModel: 'llama3.2',
            ollamaPort: 11434,
            salesPersonality: true,
            replyInBangla: true,
        },
        products: [],
        keywords: {
            'হ্যালো': 'আস্সালামুআলাইকুম! কীভাবে সাহায্য করতে পারি?',
            'hello': 'Hello! How can I help you?',
            'hi': 'Hi! How can I assist you?',
        }
    };
}

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
        catch { return getDefaultConfig(); }
    }
    return getDefaultConfig();
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============================================================
// Build prompts dynamically from config
// ============================================================
function buildSystemPrompt(config) {
    const { shop, products, bot } = config;
    const productList = products.length > 0
        ? products.map(p => `- ${p.name}: ৳${p.price}${p.description ? ' (' + p.description + ')' : ''}`).join('\n')
        : '(এখনো কোনো product যোগ করা হয়নি)';

    return `তুমি ${shop.name} এর একজন ${bot.salesPersonality ? 'expert sales assistant' : 'customer service assistant'}।

Shop এর তথ্য:
- নাম: ${shop.name}
- Location: ${shop.location}
- Phone: ${shop.phone}
- Delivery: ঢাকায় ৳${shop.deliveryInside}, ঢাকার বাইরে ৳${shop.deliveryOutside}
- Payment: ${shop.payment}

আমাদের Product List:
${productList}

তোমার আচরণ:
${bot.salesPersonality
    ? `- সবসময় বিক্রির দিকে focus করবে
- Customer কে product এর প্রতি আগ্রহী করবে
- সুযোগ পেলে অন্য product suggest করবে
- urgency তৈরি করবে ("stock কম আছে", "offer শেষ হয়ে যাচ্ছে")
- কখনো "না" বলবে না, alternative দেবে`
    : `- সবসময় সহায়ক ও বিনয়ী থাকবে
- সঠিক তথ্য দেবে`}

ভাষা:
- Customer যেভাবেই লিখুক — বাংলা, English, Banglish — সব বুঝবে
- ${bot.replyInBangla ? 'সবসময় বাংলায় উত্তর দেবে' : 'Customer এর ভাষায় উত্তর দেবে'}
- সহজ ও আন্তরিক ভাষা ব্যবহার করবে`;
}

function buildImagePrompt(config) {
    const { shop, products, bot } = config;
    const productList = products.length > 0
        ? products.map(p => `- ${p.name}: ৳${p.price}${p.description ? ' (' + p.description + ')' : ''}`).join('\n')
        : null;

    if (!productList) {
        return `তুমি ${shop.name} এর sales assistant। Customer একটা ছবি পাঠিয়েছে।
ছবিতে কী পণ্য আছে তা চিহ্নিত করো এবং আনুমানিক বাজার মূল্য বাংলায় বলো।
দাম নিশ্চিত করতে আমাদের সাথে যোগাযোগ করতে বলো।`;
    }

    return `তুমি ${shop.name} এর sales assistant।

আমাদের Product List:
${productList}

Customer একটা ছবি পাঠিয়েছে। তুমি:
1. ছবিতে কী আছে চিহ্নিত করবে
2. আমাদের product list এ match আছে কিনা দেখবে
3. Match থাকলে → আমাদের দাম বলবে এবং কিনতে উৎসাহিত করবে
4. Match না থাকলে → বলবে এই product নেই, similar কিছু থাকলে suggest করবে

${bot.salesPersonality ? 'Sales-friendly, উৎসাহী ভাষায়' : 'সহজ ও তথ্যমূলক ভাষায়'} বাংলায় উত্তর দাও।`;
}

// ============================================================
// Ollama text reply
// ============================================================
async function getOllamaReply(text, config) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            model: config.bot.ollamaModel || 'llama3.2',
            messages: [
                { role: 'system', content: buildSystemPrompt(config) },
                { role: 'user', content: text }
            ],
            stream: false
        });

        const req = http.request({
            hostname: 'localhost',
            port: config.bot.ollamaPort || 11434,
            path: '/api/chat',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data).message?.content || 'উত্তর পাওয়া যায়নি।');
                } catch {
                    resolve('উত্তর পাওয়া যায়নি।');
                }
            });
        });

        req.on('error', () => resolve(`⚠️ Ollama চালু নেই। Terminal এ চালাও: ollama run ${config.bot.ollamaModel || 'llama3.2'}`));
        req.write(body);
        req.end();
    });
}

// ============================================================
// Gemini image analysis
// ============================================================
async function analyzeImage(imageBuffer, mimeType, config) {
    if (!config.bot.geminiApiKey) {
        return '⚠️ Gemini API Key সেট করা নেই। Admin Panel (localhost:3000) এ গিয়ে Bot Settings এ API Key দিন।';
    }
    try {
        const genAI = new GoogleGenerativeAI(config.bot.geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent([
            buildImagePrompt(config),
            { inlineData: { data: imageBuffer.toString('base64'), mimeType: mimeType || 'image/jpeg' } }
        ]);
        return result.response.text();
    } catch {
        return '⚠️ ছবি বিশ্লেষণ করা সম্ভব হয়নি। Gemini API Key চেক করুন।';
    }
}

// ============================================================
// Gemini link price
// ============================================================
async function getPriceFromLink(url, config) {
    if (!config.bot.geminiApiKey) return '⚠️ Gemini API Key সেট করা নেই।';
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await response.text();
        const genAI = new GoogleGenerativeAI(config.bot.geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent(
            `এই HTML থেকে product এর নাম এবং দাম বের করো। বাংলায় সংক্ষেপে বলো। HTML: ${html.substring(0, 3000)}`
        );
        return result.response.text();
    } catch {
        return '⚠️ এই লিংক থেকে দাম বের করা সম্ভব হয়নি।';
    }
}

function extractURL(text) {
    const matches = text.match(/(https?:\/\/[^\s]+)/gi);
    return matches ? matches[0] : null;
}

function randomDelay() {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 2000) + 2000));
}

// ============================================================
// Admin Panel HTML
// ============================================================
function getAdminHTML() {
    return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShopBot Admin</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{--bg:#0d0f14;--surface:#161b27;--surface2:#1e2535;--border:#2a3347;--accent:#00d084;--accent2:#0099ff;--danger:#ff4757;--text:#e8edf5;--text2:#8b9ab5;--radius:12px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:var(--surface);border-right:1px solid var(--border);padding:20px 14px;display:flex;flex-direction:column;gap:4px;z-index:100}
.logo{font-size:17px;font-weight:700;color:var(--accent);padding:8px 10px 20px;display:flex;align-items:center;gap:8px}
.logo span{font-family:'JetBrains Mono',monospace}
.nav-item{padding:10px 12px;border-radius:8px;cursor:pointer;color:var(--text2);font-size:14px;font-weight:500;transition:all .2s;display:flex;align-items:center;gap:10px}
.nav-item:hover{background:var(--surface2);color:var(--text)}
.nav-item.active{background:rgba(0,208,132,.12);color:var(--accent)}
.main{margin-left:220px;padding:28px 32px;max-width:860px}
.page{display:none}.page.active{display:block}
h2{font-size:21px;font-weight:700;margin-bottom:6px}
.subtitle{color:var(--text2);font-size:13px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px;margin-bottom:14px}
.card h3{font-size:11px;font-weight:600;margin-bottom:16px;color:var(--text2);text-transform:uppercase;letter-spacing:.6px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.form-group{display:flex;flex-direction:column;gap:5px}
.form-group.full{grid-column:1/-1}
label{font-size:12px;color:var(--text2);font-weight:500}
input,textarea,select{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:'Hind Siliguri',sans-serif;font-size:14px;outline:none;transition:border-color .2s;width:100%}
input:focus,textarea:focus{border-color:var(--accent)}
.btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-family:'Hind Siliguri',sans-serif;font-size:13px;font-weight:600;transition:all .2s}
.btn-primary{background:var(--accent);color:#000}.btn-primary:hover{background:#00b870;transform:translateY(-1px)}
.btn-danger{background:rgba(255,71,87,.12);color:var(--danger);border:1px solid rgba(255,71,87,.25)}.btn-danger:hover{background:rgba(255,71,87,.22)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-info{display:flex;flex-direction:column;gap:2px}
.toggle-label{font-size:14px;font-weight:500}
.toggle-desc{font-size:12px;color:var(--text2)}
.toggle{width:42px;height:23px;background:var(--surface2);border-radius:12px;position:relative;cursor:pointer;border:1px solid var(--border);transition:background .2s;flex-shrink:0}
.toggle.on{background:var(--accent);border-color:var(--accent)}
.toggle::after{content:'';position:absolute;width:17px;height:17px;background:white;border-radius:50%;top:2px;left:2px;transition:transform .2s}
.toggle.on::after{transform:translateX(19px)}
.product-list{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.product-item{display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:11px 14px}
.product-info{flex:1}
.product-name{font-weight:600;font-size:14px}
.product-price{color:var(--accent);font-size:13px;font-family:'JetBrains Mono',monospace}
.product-desc{color:var(--text2);font-size:12px;margin-top:2px}
.add-form{background:var(--surface2);border:1px dashed var(--border);border-radius:8px;padding:14px;margin-bottom:12px}
.toast{position:fixed;bottom:20px;right:20px;background:var(--accent);color:#000;padding:10px 18px;border-radius:8px;font-weight:600;font-size:13px;transform:translateY(70px);opacity:0;transition:all .3s;z-index:999}
.toast.show{transform:translateY(0);opacity:1}
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;text-align:center}
.stat-num{font-size:26px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--accent)}
.stat-label{font-size:12px;color:var(--text2);margin-top:3px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
a{color:var(--accent2)}
small{display:block;margin-top:4px;color:var(--text2);font-size:12px}
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo">🤖 <span>ShopBot</span></div>
  <div class="nav-item active" onclick="showPage('dashboard',this)">📊 Dashboard</div>
  <div class="nav-item" onclick="showPage('shop',this)">🏪 Shop Info</div>
  <div class="nav-item" onclick="showPage('products',this)">📦 Products</div>
  <div class="nav-item" onclick="showPage('bot',this)">⚙️ Bot Settings</div>
  <div class="nav-item" onclick="showPage('keywords',this)">💬 Keywords</div>
</div>

<div class="main">

<!-- Dashboard -->
<div id="page-dashboard" class="page active">
  <h2>Dashboard</h2>
  <p class="subtitle">Bot এর সামগ্রিক অবস্থা</p>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-num" id="s-products">0</div><div class="stat-label">Products</div></div>
    <div class="stat-card"><div class="stat-num" id="s-keywords">0</div><div class="stat-label">Keywords</div></div>
    <div class="stat-card"><div class="stat-num"><span class="dot"></span></div><div class="stat-label">Bot Active</div></div>
  </div>
  <div class="card">
    <h3>Status</h3>
    <div class="toggle-row"><div class="toggle-info"><div class="toggle-label">Shop</div><div class="toggle-desc" id="d-shop">-</div></div></div>
    <div class="toggle-row"><div class="toggle-info"><div class="toggle-label">Gemini API</div><div class="toggle-desc" id="d-gemini">-</div></div></div>
    <div class="toggle-row"><div class="toggle-info"><div class="toggle-label">Sales Mode</div><div class="toggle-desc" id="d-sales">-</div></div></div>
  </div>
</div>

<!-- Shop -->
<div id="page-shop" class="page">
  <h2>Shop Information</h2>
  <p class="subtitle">তোমার shop এর তথ্য — Bot এটা ব্যবহার করবে customer কে জানাতে</p>
  <div class="card">
    <h3>Basic Info</h3>
    <div class="form-row">
      <div class="form-group"><label>Shop নাম</label><input id="shop-name" placeholder="আমার Shop"></div>
      <div class="form-group"><label>Phone</label><input id="shop-phone" placeholder="01XXXXXXXXX"></div>
    </div>
    <div class="form-row">
      <div class="form-group full"><label>Location</label><input id="shop-location" placeholder="ঢাকা, বাংলাদেশ"></div>
    </div>
  </div>
  <div class="card">
    <h3>Delivery & Payment</h3>
    <div class="form-row">
      <div class="form-group"><label>ঢাকার ভেতরে (৳)</label><input id="d-inside" placeholder="৬০"></div>
      <div class="form-group"><label>ঢাকার বাইরে (৳)</label><input id="d-outside" placeholder="১২০"></div>
    </div>
    <div class="form-row">
      <div class="form-group full"><label>Payment Methods</label><input id="shop-payment" placeholder="bKash, Nagad, COD"></div>
    </div>
  </div>
  <button class="btn btn-primary" onclick="saveShop()">✅ Save করো</button>
</div>

<!-- Products -->
<div id="page-products" class="page">
  <h2>Products</h2>
  <p class="subtitle">তোমার product যোগ করো — Bot ছবি দেখে এগুলো match করবে এবং দাম বলবে</p>
  <div class="card">
    <h3>নতুন Product</h3>
    <div class="add-form">
      <div class="form-row">
        <div class="form-group"><label>নাম</label><input id="p-name" placeholder="Nike Air Force 1"></div>
        <div class="form-group"><label>দাম (৳)</label><input id="p-price" type="number" placeholder="2500"></div>
      </div>
      <div class="form-group" style="margin-bottom:10px"><label>বিবরণ (optional)</label><input id="p-desc" placeholder="সাদা রঙ, সাইজ 40-44"></div>
      <button class="btn btn-primary" onclick="addProduct()">+ যোগ করো</button>
    </div>
    <div class="product-list" id="product-list"></div>
  </div>
</div>

<!-- Bot Settings -->
<div id="page-bot" class="page">
  <h2>Bot Settings</h2>
  <p class="subtitle">AI এর আচরণ ও API সেটআপ</p>
  <div class="card">
    <h3>Gemini API Key (ছবি ও লিংক)</h3>
    <div class="form-group">
      <label>API Key</label>
      <input type="password" id="gemini-key" placeholder="AIza...">
      <small>👉 <a href="https://aistudio.google.com" target="_blank">aistudio.google.com</a> থেকে বিনামূল্যে নাও</small>
    </div>
  </div>
  <div class="card">
    <h3>Ollama (Text Reply)</h3>
    <div class="form-row">
      <div class="form-group"><label>Model</label><input id="o-model" placeholder="llama3.2"></div>
      <div class="form-group"><label>Port</label><input id="o-port" type="number" placeholder="11434"></div>
    </div>
  </div>
  <div class="card">
    <h3>Behavior</h3>
    <div class="toggle-row">
      <div class="toggle-info"><div class="toggle-label">Sales Mode</div><div class="toggle-desc">চালু থাকলে bot বিক্রির দিকে focus করবে</div></div>
      <div class="toggle" id="t-sales" onclick="toggleBot('salesPersonality','t-sales')"></div>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><div class="toggle-label">বাংলায় Reply</div><div class="toggle-desc">সবসময় বাংলায় উত্তর দেবে</div></div>
      <div class="toggle" id="t-bangla" onclick="toggleBot('replyInBangla','t-bangla')"></div>
    </div>
  </div>
  <button class="btn btn-primary" onclick="saveBot()">✅ Save করো</button>
</div>

<!-- Keywords -->
<div id="page-keywords" class="page">
  <h2>Keywords</h2>
  <p class="subtitle">নির্দিষ্ট শব্দে নির্দিষ্ট reply — AI এর আগে এগুলো check হবে</p>
  <div class="card">
    <h3>নতুন Keyword</h3>
    <div class="add-form">
      <div class="form-row">
        <div class="form-group"><label>Keyword</label><input id="k-word" placeholder="দাম, price, hello"></div>
        <div class="form-group"><label>Reply</label><input id="k-reply" placeholder="ছবি পাঠান দাম জানতে"></div>
      </div>
      <button class="btn btn-primary" onclick="addKeyword()">+ যোগ করো</button>
    </div>
    <div class="product-list" id="keyword-list"></div>
  </div>
</div>

</div>
<div class="toast" id="toast"></div>

<script>
let cfg = {};

async function load() {
  const r = await fetch('/api/config');
  cfg = await r.json();
  render();
}

async function save() {
  await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  toast('✅ Save হয়েছে!');
  renderDash();
}

function render() {
  renderDash();
  // Shop
  document.getElementById('shop-name').value = cfg.shop?.name||'';
  document.getElementById('shop-phone').value = cfg.shop?.phone||'';
  document.getElementById('shop-location').value = cfg.shop?.location||'';
  document.getElementById('d-inside').value = cfg.shop?.deliveryInside||'';
  document.getElementById('d-outside').value = cfg.shop?.deliveryOutside||'';
  document.getElementById('shop-payment').value = cfg.shop?.payment||'';
  // Bot
  document.getElementById('gemini-key').value = cfg.bot?.geminiApiKey||'';
  document.getElementById('o-model').value = cfg.bot?.ollamaModel||'llama3.2';
  document.getElementById('o-port').value = cfg.bot?.ollamaPort||11434;
  setToggle('t-sales', cfg.bot?.salesPersonality);
  setToggle('t-bangla', cfg.bot?.replyInBangla);
  renderProducts();
  renderKeywords();
}

function renderDash() {
  document.getElementById('s-products').textContent = cfg.products?.length||0;
  document.getElementById('s-keywords').textContent = Object.keys(cfg.keywords||{}).length;
  document.getElementById('d-shop').textContent = cfg.shop?.name||'-';
  document.getElementById('d-gemini').textContent = cfg.bot?.geminiApiKey ? '✅ Set আছে' : '❌ Set নেই';
  document.getElementById('d-sales').textContent = cfg.bot?.salesPersonality ? '✅ চালু' : '❌ বন্ধ';
}

function renderProducts() {
  const el = document.getElementById('product-list');
  const p = cfg.products||[];
  el.innerHTML = p.length ? p.map((x,i) => \`
    <div class="product-item">
      <div class="product-info">
        <div class="product-name">\${x.name}</div>
        <div class="product-price">৳\${x.price}</div>
        \${x.description?'<div class="product-desc">'+x.description+'</div>':''}
      </div>
      <button class="btn btn-danger" onclick="delProduct(\${i})">🗑</button>
    </div>\`).join('')
    : '<p style="color:var(--text2);font-size:13px;padding:12px;text-align:center">কোনো product নেই</p>';
}

function renderKeywords() {
  const el = document.getElementById('keyword-list');
  const entries = Object.entries(cfg.keywords||{});
  el.innerHTML = entries.length ? entries.map(([k,v]) => \`
    <div class="product-item">
      <div class="product-info">
        <div class="product-name">\${k}</div>
        <div class="product-desc">\${v}</div>
      </div>
      <button class="btn btn-danger" onclick="delKeyword('\${k}')">🗑</button>
    </div>\`).join('')
    : '<p style="color:var(--text2);font-size:13px;padding:12px;text-align:center">কোনো keyword নেই</p>';
}

function saveShop() {
  cfg.shop = {
    name: document.getElementById('shop-name').value,
    phone: document.getElementById('shop-phone').value,
    location: document.getElementById('shop-location').value,
    deliveryInside: document.getElementById('d-inside').value,
    deliveryOutside: document.getElementById('d-outside').value,
    payment: document.getElementById('shop-payment').value,
  };
  save();
}

function saveBot() {
  cfg.bot = {...cfg.bot,
    geminiApiKey: document.getElementById('gemini-key').value,
    ollamaModel: document.getElementById('o-model').value,
    ollamaPort: parseInt(document.getElementById('o-port').value)||11434,
  };
  save();
}

function toggleBot(key, id) {
  cfg.bot[key] = !cfg.bot[key];
  setToggle(id, cfg.bot[key]);
}

function setToggle(id, val) {
  const el = document.getElementById(id);
  if(el) el.className = 'toggle' + (val ? ' on' : '');
}

function addProduct() {
  const name = document.getElementById('p-name').value.trim();
  const price = document.getElementById('p-price').value.trim();
  const desc = document.getElementById('p-desc').value.trim();
  if(!name||!price){toast('❌ নাম ও দাম দিন',true);return;}
  cfg.products = cfg.products||[];
  cfg.products.push({name,price,description:desc});
  document.getElementById('p-name').value='';
  document.getElementById('p-price').value='';
  document.getElementById('p-desc').value='';
  save(); renderProducts();
}

function delProduct(i) { cfg.products.splice(i,1); save(); renderProducts(); }

function addKeyword() {
  const k = document.getElementById('k-word').value.trim();
  const v = document.getElementById('k-reply').value.trim();
  if(!k||!v){toast('❌ keyword ও reply দিন',true);return;}
  cfg.keywords = cfg.keywords||{};
  cfg.keywords[k] = v;
  document.getElementById('k-word').value='';
  document.getElementById('k-reply').value='';
  save(); renderKeywords();
}

function delKeyword(k) { delete cfg.keywords[k]; save(); renderKeywords(); }

function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  el.classList.add('active');
}

function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = err ? 'var(--danger)' : 'var(--accent)';
  t.style.color = err ? 'white' : '#000';
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2500);
}

load();
</script>
</body>
</html>`;
}

// ============================================================
// Admin HTTP Server
// ============================================================
function startAdminServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if ((req.url === '/' || req.url === '/admin') && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getAdminHTML());
        } else if (req.url === '/api/config' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(loadConfig()));
        } else if (req.url === '/api/config' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    saveConfig(JSON.parse(body));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch { res.writeHead(400); res.end('Invalid JSON'); }
            });
        } else {
            res.writeHead(404); res.end();
        }
    });

    server.listen(3000, () => {
        console.log('🖥️  Admin Panel: http://localhost:3000\n');
    });
}

// ============================================================
// WhatsApp Bot
// ============================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['ShopBot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) console.log('\n📱 QR Code স্ক্যান করো WhatsApp দিয়ে!\n');
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot চালু!\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            const mc = msg.message;
            if (!mc) continue;

            const config = loadConfig(); // fresh config প্রতিবার

            try {
                if (mc.imageMessage) {
                    await sock.sendPresenceUpdate('composing', jid);
                    await randomDelay();
                    const buf = await downloadMediaMessage(msg, 'buffer', {});
                    const reply = await analyzeImage(buf, mc.imageMessage.mimetype, config);
                    await sock.sendPresenceUpdate('paused', jid);
                    await sock.sendMessage(jid, { text: reply }, { quoted: msg });

                } else if (mc.conversation || mc.extendedTextMessage) {
                    const text = mc.conversation || mc.extendedTextMessage?.text || '';
                    if (!text) continue;

                    await sock.sendPresenceUpdate('composing', jid);
                    await randomDelay();

                    let reply = null;

                    // URL?
                    const url = extractURL(text);
                    if (url) reply = await getPriceFromLink(url, config);

                    // Keyword?
                    if (!reply) {
                        const lower = text.toLowerCase();
                        for (const [k, v] of Object.entries(config.keywords || {})) {
                            if (lower.includes(k.toLowerCase())) { reply = v; break; }
                        }
                    }

                    // Ollama AI
                    if (!reply) reply = await getOllamaReply(text, config);

                    await sock.sendPresenceUpdate('paused', jid);
                    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
                }
            } catch (err) {
                console.error('Error:', err.message);
            }
        }
    });
}

// Start
startAdminServer();
startBot().catch(console.error);