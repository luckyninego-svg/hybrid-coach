/**
 * HYROX / RUNNING AI COACH BOT
 * Stack: Strava Webhook → Node.js → Claude AI → Telegram
 * 
 * HOW IT WORKS:
 * 1. Athlete connects Strava (one-time OAuth)
 * 2. Every new Strava activity triggers a webhook to this server
 * 3. Server fetches full activity data from Strava
 * 4. Claude AI analyzes it using the coaching framework
 * 5. Feedback is sent to athlete via Telegram
 * 6. Athlete can also chat with the bot anytime
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const { buildCoachingPrompt, analyzeActivity, buildChatContext } = require('./coaching');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ─────────────────────────────────────────────
// TELEGRAM: Send message to athlete
// ─────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  try {
    // Strip markdown symbols to avoid parse errors
    const cleanText = text.replace(/[*_`]/g, '');
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: cleanText
    });
  } catch (err) {
    console.error('Telegram send error:', err.message);
    console.error('Telegram error details:', err.response?.data);
  }
}

// ─────────────────────────────────────────────
// TELEGRAM: Receive messages from athlete
// ─────────────────────────────────────────────
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200); // Always respond immediately to Telegram

  const message = req.body?.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text?.trim();
  const firstName = message.from?.first_name || 'Athlete';

  if (!text) return;

  // Handle /start command - new athlete onboarding
  if (text === '/start') {
    await db.upsertAthlete({ telegram_id: String(chatId), name: firstName });
    const stravaAuthUrl = `${process.env.BASE_URL}/auth/strava?telegram_id=${chatId}`;
    await sendTelegram(chatId,
      `Welcome ${firstName}! 👋\n\n` +
      `I'm your personal Running & HYROX coach, powered by science.\n\n` +
      `I use your training data to give you zone-based, physiologically sound coaching — ` +
      `not generic advice.\n\n` +
      `*Step 1:* Connect your Strava so I can read your training data:\n` +
      `👉 ${stravaAuthUrl}\n\n` +
      `Once connected, I'll automatically analyze every run and workout you log.`
    );
    return;
  }

  // Handle /status command
  if (text === '/status') {
    const athlete = await db.getAthleteByTelegram(chatId);
    if (!athlete) {
      await sendTelegram(chatId, 'You haven\'t connected yet. Send /start to begin.');
      return;
    }
    const status =
      `*Your Profile*\n` +
      `Name: ${athlete.name}\n` +
      `Strava: ${athlete.strava_connected ? '✅ Connected' : '❌ Not connected'}\n` +
      `Critical Speed: ${athlete.critical_speed ? athlete.critical_speed + ' min/km' : 'Not set yet'}\n` +
      `Training Phase: ${athlete.training_phase || 'Not set'}\n` +
      `Goal Race: ${athlete.goal_race || 'Not set'}\n\n` +
      `Use /setzones to update your training zones.`;
    await sendTelegram(chatId, status);
    return;
  }

  // Handle /setzones command - uses Strava HR data to estimate LT1/LT2
  if (text.startsWith('/setzones')) {
    const athleteForZones = await db.getAthleteByTelegram(chatId);
    if (!athleteForZones || !athleteForZones.strava_connected) {
      await sendTelegram(chatId, 'Please connect Strava first so I can analyze your actual training data to find your thresholds.');
      return;
    }
    await sendTelegram(chatId, 'Analyzing your last 60 days of Strava runs to estimate your LT1, LT2 and training zones. Give me a moment...');
    try {
      const zones = await calculateZonesFromStrava(athleteForZones);
      if (!zones) {
        await sendTelegram(chatId, 'I need at least 10 runs with heart rate data in the last 60 days to calculate your zones. Keep training and try again soon!');
        return;
      }
      await db.updateAthlete(String(chatId), {
        critical_speed: zones.criticalSpeed,
        zone1_pace: zones.z1,
        zone2_pace: zones.z2,
        zone3_pace: zones.z3,
        zone4_pace: zones.z4,
        zone5_pace: zones.z5,
        lt1_pace: zones.lt1,
        lt2_pace: zones.lt2,
        lt1_hr: String(zones.lt1Hr),
        lt2_hr: String(zones.lt2Hr),
        awaiting_input: null
      });
      await sendTelegram(chatId,
        'Zones calculated from your Strava data (' + zones.runsAnalyzed + ' runs analyzed):

' +
        'LT1 aerobic threshold: ' + zones.lt1 + ' min/km at ' + zones.lt1Hr + ' bpm
' +
        'LT2 anaerobic threshold: ' + zones.lt2 + ' min/km at ' + zones.lt2Hr + ' bpm

' +
        'Z1 Recovery:     slower than ' + zones.z1 + ' min/km
' +
        'Z2 Aerobic Base: ' + zones.z2 + ' min/km
' +
        'Z3 Tempo:        ' + zones.z3 + ' min/km
' +
        'Z4 Threshold:    ' + zones.z4 + ' min/km
' +
        'Z5 VO2max+:      faster than ' + zones.z5 + ' min/km

' +
        'These are based on your real training data and will be updated every 30 days.'
      );
    } catch (err) {
      console.error('Zone calculation error:', err.message);
      await sendTelegram(chatId, 'Something went wrong analyzing your Strava data. Try again in a moment.');
    }
    return;
  }

  // Handle athlete input flows
  const athlete = await db.getAthleteByTelegram(chatId);

  if (athlete && athlete.awaiting_input === '5k_time') {
    const zones = calculate5KZones(text);
    if (!zones) {
      await sendTelegram(chatId, 'I did not catch that. Please send your 5K time like this: 25:30');
      return;
    }
    await db.updateAthlete(String(chatId), {
      critical_speed: zones.criticalSpeed,
      five_k_time: text,
      zone1_pace: zones.z1,
      zone2_pace: zones.z2,
      zone3_pace: zones.z3,
      zone4_pace: zones.z4,
      zone5_pace: zones.z5,
      awaiting_input: null
    });
    await sendTelegram(chatId,
      'Zones calculated from ' + text + ' 5K

' +
      'Critical Speed: ' + zones.criticalSpeed + ' min/km

' +
      'Z1 Recovery: > ' + zones.z1 + '
' +
      'Z2 Aerobic Base: ' + zones.z2 + '
' +
      'Z3 Tempo: ' + zones.z3 + '
' +
      'Z4 Threshold: ' + zones.z4 + '
' +
      'Z5 VO2max+: < ' + zones.z5 + '

' +
      'These zones are now locked in.'
    );
    return;
  }

  // Free-form coaching chat
  try {
    const athleteData = await db.getAthleteByTelegram(chatId);
    const recentActivities = await db.getRecentActivities(chatId, 5);
    const context = buildChatContext(athleteData, recentActivities);

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      system: buildCoachingPrompt(context),
      messages: [{ role: 'user', content: text }]
    });

    await sendTelegram(chatId, response.content[0].text);
  } catch (err) {
    console.error('Claude error:', err.message);
    await sendTelegram(chatId, 'Something went wrong on my end. Try again in a moment.');
  }
});

// ─────────────────────────────────────────────
// STRAVA: OAuth - Step 1, redirect athlete to Strava
// ─────────────────────────────────────────────
app.get('/auth/strava', (req, res) => {
  const { telegram_id } = req.query;
  const baseUrl = process.env.BASE_URL.startsWith('http')
    ? process.env.BASE_URL
    : 'https://' + process.env.BASE_URL;
  const redirectUri = baseUrl + '/auth/strava/callback';
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: String(telegram_id || '')
  });
  res.redirect('https://www.strava.com/oauth/authorize?' + params);
});

// ─────────────────────────────────────────────
// STRAVA: OAuth - Step 2, receive token after athlete approves
// ─────────────────────────────────────────────
app.get('/auth/strava/callback', async (req, res) => {
  const { code, state: telegramId } = req.query;

  if (!telegramId || telegramId === 'undefined' || telegramId === '') {
    return res.status(400).send('Missing telegram_id. Please start the bot again and use the connect link.');
  }

  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_at, athlete } = tokenRes.data;

    // Create athlete record first if it doesn't exist
    await db.upsertAthlete({ telegram_id: String(telegramId), name: athlete.firstname + ' ' + athlete.lastname });

    await db.updateAthlete(String(telegramId), {
      strava_id: String(athlete.id),
      strava_access_token: String(access_token),
      strava_refresh_token: String(refresh_token),
      strava_token_expires: Number(expires_at),
      strava_connected: 1,
      name: athlete.firstname + ' ' + athlete.lastname
    });

    // Subscribe this athlete's Strava to our webhook
    await ensureStravaWebhook();

    await sendTelegram(telegramId,
      `✅ *Strava connected!*\n\n` +
      `Welcome ${athlete.firstname}! I can now see your training data.\n\n` +
      `Next, let's set your training zones. Send */setzones* to begin, ` +
      `or just start training and I'll analyze your activities automatically.`
    );

    res.send('<h2>✅ Connected! Return to Telegram to continue.</h2>');
  } catch (err) {
    console.error('Strava auth error:', err.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// ─────────────────────────────────────────────
// STRAVA: Webhook verification (required by Strava)
// ─────────────────────────────────────────────
app.get('/webhook/strava', (req, res) => {
  const { 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (token === process.env.STRAVA_VERIFY_TOKEN) {
    res.json({ 'hub.challenge': challenge });
  } else {
    res.sendStatus(403);
  }
});

// ─────────────────────────────────────────────
// STRAVA: Webhook - new activity event received
// ─────────────────────────────────────────────
app.post('/webhook/strava', async (req, res) => {
  res.sendStatus(200); // Must respond within 2 seconds

  const { object_type, aspect_type, object_id, owner_id } = req.body;

  // Only process new activities
  if (object_type !== 'activity' || aspect_type !== 'create') return;

  try {
    // Find athlete by Strava ID
    const athlete = await db.getAthleteByStravaId(owner_id);
    if (!athlete) return;

    // Refresh token if needed
    const token = await refreshStravaToken(athlete);

    // Fetch full activity from Strava
    const activityRes = await axios.get(
      `https://www.strava.com/api/v3/activities/${object_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const activity = activityRes.data;

    // Only process runs and relevant workout types
    const relevantTypes = ['Run', 'TrailRun', 'VirtualRun', 'Workout', 'WeightTraining'];
    if (!relevantTypes.includes(activity.type)) return;

    // Store activity
    await db.saveActivity({
      telegram_id: athlete.telegram_id,
      strava_id: object_id,
      type: activity.type,
      name: activity.name,
      date: activity.start_date,
      distance_km: (activity.distance / 1000).toFixed(2),
      duration_min: Math.round(activity.moving_time / 60),
      avg_pace: formatPace(activity.average_speed),
      avg_hr: activity.average_heartrate,
      max_hr: activity.max_heartrate,
      suffer_score: activity.suffer_score,
      elevation_m: activity.total_elevation_gain,
      raw_data: JSON.stringify(activity)
    });

    // Build AI coaching feedback
    const athleteProfile = await db.getAthleteByTelegram(athlete.telegram_id);
    const recentActivities = await db.getRecentActivities(athlete.telegram_id, 7);
    const analysis = analyzeActivity(activity, athleteProfile);

    const aiResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      system: buildCoachingPrompt(buildChatContext(athleteProfile, recentActivities)),
      messages: [{
        role: 'user',
        content: `Analyze this activity and give concise coaching feedback:\n\n${JSON.stringify(analysis, null, 2)}`
      }]
    });

    // Send feedback to athlete on Telegram
    const activityEmoji = activity.type === 'Run' ? '🏃' : '💪';
    await sendTelegram(athlete.telegram_id,
      `${activityEmoji} *New activity synced: ${activity.name}*\n\n` +
      aiResponse.content[0].text
    );

  } catch (err) {
    console.error('Strava webhook processing error:', err.message);
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function formatPace(metersPerSecond) {
  if (!metersPerSecond || metersPerSecond === 0) return null;
  const secondsPerKm = 1000 / metersPerSecond;
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.round(secondsPerKm % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function calculate5KZones(timeStr) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const totalSeconds = parseInt(match[1]) * 60 + parseInt(match[2]);
  const paceSecPerKm = totalSeconds / 5; // 5K pace in sec/km

  // Critical Speed ≈ 5K pace + 10-15 sec (slightly faster sustainable pace)
  const cs = paceSecPerKm + 12;

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  return {
    criticalSpeed: fmt(cs),
    z1: fmt(cs * 1.35),          // > 135% of CS pace (slower)
    z2: fmt(cs * 1.15) + '–' + fmt(cs * 1.35),
    z3: fmt(cs * 1.05) + '–' + fmt(cs * 1.15),
    z4: fmt(cs * 0.95) + '–' + fmt(cs * 1.05),
    z5: fmt(cs * 0.95)            // < 95% of CS pace (faster)
  };
}

async function refreshStravaToken(athlete) {
  const now = Math.floor(Date.now() / 1000);
  if (athlete.strava_token_expires > now + 300) {
    return athlete.strava_access_token;
  }

  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: athlete.strava_refresh_token,
    grant_type: 'refresh_token'
  });

  await db.updateAthlete(athlete.telegram_id, {
    strava_access_token: res.data.access_token,
    strava_refresh_token: res.data.refresh_token,
    strava_token_expires: res.data.expires_at
  });

  return res.data.access_token;
}

async function ensureStravaWebhook() {
  try {
    const existing = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET
      }
    });
    if (existing.data.length > 0) return; // Already subscribed

    await axios.post('https://www.strava.com/api/v3/push_subscriptions', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: `${process.env.BASE_URL}/webhook/strava`,
      verify_token: process.env.STRAVA_VERIFY_TOKEN
    });
    console.log('Strava webhook registered');
  } catch (err) {
    console.error('Webhook registration error:', err.message);
  }
}


// ─────────────────────────────────────────────
// CALCULATE LT1 / LT2 FROM STRAVA HISTORY
// Uses pace vs HR relationship across last 60 days
// ─────────────────────────────────────────────
async function calculateZonesFromStrava(athlete) {
  const token = await refreshStravaToken(athlete);
  const sixtyDaysAgo = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000);

  // Fetch last 60 days of activities
  const res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
    headers: { Authorization: 'Bearer ' + token },
    params: { after: sixtyDaysAgo, per_page: 60 }
  });

  // Filter runs with HR and pace data
  const runs = res.data.filter(a =>
    (a.type === 'Run' || a.type === 'TrailRun') &&
    a.average_heartrate &&
    a.average_speed > 0 &&
    a.moving_time > 600  // at least 10 minutes
  );

  if (runs.length < 5) return null;

  // Build pace/HR data points
  // pace in sec/km, hr in bpm
  const dataPoints = runs.map(r => ({
    paceSecPerKm: Math.round(1000 / r.average_speed),
    hr: Math.round(r.average_heartrate),
    durationMin: Math.round(r.moving_time / 60),
    sufferScore: r.suffer_score || 0
  }));

  // Sort by pace (slowest to fastest)
  dataPoints.sort((a, b) => b.paceSecPerKm - a.paceSecPerKm);

  // Find HR range
  const hrs = dataPoints.map(d => d.hr);
  const minHR = Math.min(...hrs);
  const maxHR = Math.max(...hrs);
  const hrRange = maxHR - minHR;

  // LT1 estimate: HR at ~55% of HR range above min (aerobic threshold)
  const lt1Hr = Math.round(minHR + hrRange * 0.55);
  // LT2 estimate: HR at ~80% of HR range above min (anaerobic threshold)  
  const lt2Hr = Math.round(minHR + hrRange * 0.80);

  // Find paces corresponding to these HR values
  // Use linear interpolation across data points
  const lt1Point = interpolatePaceAtHR(dataPoints, lt1Hr);
  const lt2Point = interpolatePaceAtHR(dataPoints, lt2Hr);

  if (!lt1Point || !lt2Point) return null;

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60).toString().padStart(2, '0');
    return m + ':' + sec;
  };

  // Critical Speed = LT2 pace
  const cs = lt2Point;

  return {
    runsAnalyzed: runs.length,
    lt1: fmt(lt1Point),
    lt2: fmt(lt2Point),
    lt1Hr,
    lt2Hr,
    criticalSpeed: fmt(cs),
    z1: fmt(cs * 1.35),
    z2: fmt(cs * 1.20) + '-' + fmt(cs * 1.35),
    z3: fmt(cs * 1.08) + '-' + fmt(cs * 1.20),
    z4: fmt(cs * 0.97) + '-' + fmt(cs * 1.08),
    z5: fmt(cs * 0.97)
  };
}

function interpolatePaceAtHR(dataPoints, targetHR) {
  // Find two closest points around target HR
  let below = null, above = null;
  for (const p of dataPoints) {
    if (p.hr <= targetHR) {
      if (!below || p.hr > below.hr) below = p;
    }
    if (p.hr >= targetHR) {
      if (!above || p.hr < above.hr) above = p;
    }
  }
  if (below && above && below !== above) {
    // Linear interpolation
    const ratio = (targetHR - below.hr) / (above.hr - below.hr);
    return Math.round(below.paceSecPerKm + ratio * (above.paceSecPerKm - below.paceSecPerKm));
  }
  if (below) return below.paceSecPerKm;
  if (above) return above.paceSecPerKm;
  return null;
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🏃 HYROX Coach Bot running on port ${PORT}`);
  await db.init();

  // Register Telegram webhook
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: `${process.env.BASE_URL}/webhook/telegram`
    });
    console.log('✅ Telegram webhook registered');
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});
