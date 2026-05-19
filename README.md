# WhatsApp Shop Bot - Setup Guide

## যা যা লাগবে
- Node.js 18+ (nodejs.org থেকে download করো)
- Gemini API Key (বিনামূল্যে)
- একটা WhatsApp নম্বর (আলাদা নম্বর ব্যবহার করো)

---

## Step 1: Gemini API Key নাও (Free)
1. যাও: https://aistudio.google.com
2. Sign in করো Google account দিয়ে
3. "Get API Key" তে click করো
4. API Key copy করো

---

## Step 2: Bot Setup করো

```bash
# এই folder এ এসো terminal এ
cd whatsapp-bot

# Dependencies install করো
npm install

# index.js ফাইল খোলো এবং এই লাইন এ তোমার API key দাও:
# const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY';
```

---

## Step 3: Bot চালাও

```bash
node index.js
```

Terminal এ QR code দেখাবে।
WhatsApp > Linked Devices > Link a Device > QR scan করো।

---

## Bot কী কী করতে পারে

### ছবি পাঠালে:
- পণ্যের নাম বলবে
- আনুমানিক বাজার মূল্য বলবে
- মূল বৈশিষ্ট্য বলবে

### লিংক পাঠালে:
- সেই page থেকে price বের করবে

### Text message:
- Keyword দিয়ে auto reply করবে
- হ্যালো, hello, hi, price, দাম, link — এগুলো কাজ করবে

---

## Custom Reply যোগ করতে চাইলে

`index.js` ফাইলে এই অংশ খোঁজো:

```javascript
const KEYWORD_REPLIES = {
    'হ্যালো': 'আস্সালামুআলাইকুম!...',
    // এখানে নতুন keyword যোগ করো
    'তোমার keyword': 'তোমার reply',
};
```

---

## সমস্যা হলে

- **QR scan হচ্ছে না**: WhatsApp app আপডেট করো
- **Bot reply দিচ্ছে না**: Terminal এ error দেখো
- **Account ban**: আলাদা নম্বর ব্যবহার করো, mass message পাঠাবে না

---

## Free Limit (Gemini)
- প্রতিদিন **1500 request** বিনামূল্যে
- প্রতি মিনিটে **15 request**
- ছোট business এর জন্য যথেষ্ট
