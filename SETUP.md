# 🏃 HYROX Coach Bot — Setup Guide

## What This Bot Does
- Athletes connect their Strava once via a link
- Every run synced from Garmin/COROS → Strava → bot automatically
- Claude AI analyzes each activity using your coaching framework
- Feedback sent instantly to athlete on Telegram
- Athletes can also chat freely with the coach anytime

---

## Architecture
```
Garmin/COROS Watch
      ↓ (auto-sync)
    Strava
      ↓ (webhook — fires on every new activity)
  Your Server (Railway)
      ↓
  Claude AI (with coaching framework)
      ↓
   Telegram Bot
      ↓
   Athlete's Phone
```

---

## Step 1: Create Your Telegram Bot (5 min)

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a name: e.g. `HYROX Coach`
4. Choose a username: e.g. `hyrox_coach_bot`
5. BotFather gives you a **token** — copy it to `.env` as `TELEGRAM_BOT_TOKEN`

---

## Step 2: Create Strava API App (5 min)

1. Go to https://www.strava.com/settings/api
2. Create an application:
   - App Name: `HYROX Coach`
   - Category: `Coach`
   - Website: your Railway URL (add after Step 4)
   - Authorization Callback Domain: your Railway domain
3. Copy **Client ID** and **Client Secret** to `.env`

---

## Step 3: Get Anthropic API Key (2 min)

1. Go to https://console.anthropic.com
2. Create an API key
3. Copy to `.env` as `ANTHROPIC_API_KEY`

---

## Step 4: Deploy to Railway (10 min)

Railway is the easiest free hosting for this bot.

1. Go to https://railway.app and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Push your code to GitHub first:
   ```bash
   git init
   git add .
   git commit -m "Initial HYROX coach bot"
   # Create a GitHub repo and push
   git remote add origin https://github.com/YOUR_USERNAME/hyrox-coach
   git push -u origin main
   ```
4. In Railway, select your repo
5. Go to **Variables** tab and add all your `.env` values
6. Railway gives you a URL like `https://hyrox-coach.up.railway.app`
7. Copy this URL to `.env` as `BASE_URL`

---

## Step 5: Register Strava Webhook (2 min)

After your server is live, run this once to register the Strava webhook:

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=YOUR_CLIENT_ID \
  -F client_secret=YOUR_CLIENT_SECRET \
  -F callback_url=https://YOUR-RAILWAY-URL.up.railway.app/webhook/strava \
  -F verify_token=YOUR_VERIFY_TOKEN
```

---

## Step 6: Test It

1. Open Telegram, find your bot
2. Send `/start`
3. Click the Strava connect link
4. Authorize the app on Strava
5. Go for a run — bot should message you within 60 seconds of syncing

---

## Athlete Commands

| Command | What it does |
|---------|-------------|
| `/start` | Onboarding + Strava connect link |
| `/status` | Show profile, zones, connected apps |
| `/setzones` | Enter 5K time to calculate training zones |
| Free text | Chat with the coach about anything |

---

## Scaling Up (when you have more athletes)

- **Swap SQLite → Supabase**: Free tier handles ~500 athletes easily
- **Add Garmin Connect API**: Richer data (HRV, body battery, sleep)
- **Add weekly check-in**: Cron job every Monday sending weekly training summary
- **Add training plan delivery**: Bot sends the week's sessions every Sunday night

---

## Folder Structure

```
hyrox-coach/
├── server.js       ← Main server (Telegram + Strava webhooks)
├── coaching.js     ← AI coaching logic + system prompt
├── database.js     ← SQLite database layer
├── package.json    ← Dependencies
├── .env.example    ← Environment variable template
└── SETUP.md        ← This file
```
