/**
 * HYROX / RUNNING AI COACH BOT
 * Stack: Strava Webhook -> Node.js -> Claude AI -> Telegram
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
const TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN;

async function sendTelegram(chatId, text) {
  try {
    const cleanText = text.replace(/[*_`]/g, '');
    await axios.post(TELEGRAM_API + '/sendMessage', {
      chat_id: chatId,
      text: cleanText
    });
  } catch (err) {
    console.error('Telegram send error:', err.message);
    console.error('Details:', err.response && err.response.data);
  }
}

app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200);
  const message = req.body && req.body.message;
  if (!message) return;
  const chatId = message.chat.id;
  const text = message.text && message.text.trim();
  const firstName = (message.from && message.from.first_name) || 'Athlete';
  if (!text) return;

  if (text === '/start') {
    await db.upsertAthlete({ telegram_id: String(chatId), name: firstName });
    const stravaAuthUrl = process.env.BASE_URL + '/auth/strava?telegram_id=' + chatId;
    // Use inline button so Telegram preserves the full URL including state param
    try {
      await axios.post(TELEGRAM_API + '/sendMessage', {
        chat_id: chatId,
        text: 'Welcome ' + firstName + '!\n\nI am your personal Running & HYROX coach, powered by science.\n\nTap the button below to connect your Strava:',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Connect Strava', url: stravaAuthUrl }
          ]]
        }
      });
    } catch (err) {
      console.error('Start message error:', err.message);
    }
    return;
  }

  if (text === '/status') {
    const athlete = await db.getAthleteByTelegram(chatId);
    if (!athlete) {
      await sendTelegram(chatId, 'You have not connected yet. Send /start to begin.');
      return;
    }
    await sendTelegram(chatId,
      'Your Profile\n\n' +
      'Name: ' + (athlete.name || 'Unknown') + '\n' +
      'Strava: ' + (athlete.strava_connected ? 'Connected' : 'Not connected') + '\n' +
      'Critical Speed: ' + (athlete.critical_speed ? athlete.critical_speed + ' min/km' : 'Not set') + '\n' +
      'LT1: ' + (athlete.lt1_pace ? athlete.lt1_pace + ' min/km at ' + athlete.lt1_hr + ' bpm' : 'Not set') + '\n' +
      'LT2: ' + (athlete.lt2_pace ? athlete.lt2_pace + ' min/km at ' + athlete.lt2_hr + ' bpm' : 'Not set') + '\n' +
      'Training Phase: ' + (athlete.training_phase || 'Base') + '\n\n' +
      '/setzones - calculate zones from your Strava data\n' +
      '/disconnect - disconnect Strava'
    );
    return;
  }

  if (text === '/disconnect') {
    await db.updateAthlete(String(chatId), {
      strava_connected: 0,
      strava_access_token: null,
      strava_refresh_token: null,
      strava_id: null
    });
    await sendTelegram(chatId,
      'Strava disconnected.\n\n' +
      'Your training history is still saved.\n' +
      'Send /start anytime to reconnect.'
    );
    return;
  }

  if (text.startsWith('/setzones')) {
    const athleteForZones = await db.getAthleteByTelegram(chatId);
    if (!athleteForZones || !athleteForZones.strava_connected) {
      await sendTelegram(chatId, 'Please connect Strava first. Send /start to get the connect link.');
      return;
    }
    await sendTelegram(chatId, 'Analyzing your last 60 days of Strava runs to find your LT1 and LT2. Give me a moment...');
    try {
      const zones = await calculateZonesFromStrava(athleteForZones);
      if (!zones) {
        await sendTelegram(chatId, 'I need at least 5 runs with heart rate data in the last 60 days. Keep training and try again soon!');
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
        'Zones calculated from your Strava data (' + zones.runsAnalyzed + ' runs analyzed)\n\n' +
        'LT1 aerobic threshold: ' + zones.lt1 + ' min/km at ' + zones.lt1Hr + ' bpm\n' +
        'LT2 anaerobic threshold: ' + zones.lt2 + ' min/km at ' + zones.lt2Hr + ' bpm\n\n' +
        'Z1 Recovery:     slower than ' + zones.z1 + ' min/km\n' +
        'Z2 Aerobic Base: ' + zones.z2 + ' min/km\n' +
        'Z3 Tempo:        ' + zones.z3 + ' min/km\n' +
        'Z4 Threshold:    ' + zones.z4 + ' min/km\n' +
        'Z5 VO2max+:      faster than ' + zones.z5 + ' min/km\n\n' +
        'Use /setzones anytime to recalculate as your fitness improves.'
      );
    } catch (err) {
      console.error('Zone calculation error:', err.message);
      await sendTelegram(chatId, 'Something went wrong analyzing your Strava data. Try again in a moment.');
    }
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

app.get('/auth/strava', (req, res) => {
  const telegram_id = req.query.telegram_id;
  const baseUrl = process.env.BASE_URL.startsWith('http') ? process.env.BASE_URL : 'https://' + process.env.BASE_URL;
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

app.get('/auth/strava/callback', async (req, res) => {
  const code = req.query.code;
  const telegramId = req.query.state;
  if (!telegramId || telegramId === 'undefined' || telegramId === '') {
    return res.status(400).send('Missing telegram_id. Please use the link from the bot.');
  }
  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });
    const access_token = tokenRes.data.access_token;
    const refresh_token = tokenRes.data.refresh_token;
    const expires_at = tokenRes.data.expires_at;
    const athlete = tokenRes.data.athlete;
    await db.upsertAthlete({ telegram_id: String(telegramId), name: athlete.firstname + ' ' + athlete.lastname });
    await db.updateAthlete(String(telegramId), {
      strava_id: String(athlete.id),
      strava_access_token: String(access_token),
      strava_refresh_token: String(refresh_token),
      strava_token_expires: Number(expires_at),
      strava_connected: 1,
      name: athlete.firstname + ' ' + athlete.lastname
    });
    await ensureStravaWebhook();
    await sendTelegram(telegramId,
      'Strava connected!\n\n' +
      'Welcome ' + athlete.firstname + '! I can now see your training data.\n\n' +
      'Send /setzones so I can calculate your personal training zones from your actual run data.'
    );
    res.send('<h2>Connected! Return to Telegram to continue.</h2>');
  } catch (err) {
    console.error('Strava auth error:', err.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

app.get('/webhook/strava', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === process.env.STRAVA_VERIFY_TOKEN) {
    res.json({ 'hub.challenge': challenge });
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/strava', async (req, res) => {
  res.sendStatus(200);
  const object_type = req.body.object_type;
  const aspect_type = req.body.aspect_type;
  const object_id = req.body.object_id;
  const owner_id = req.body.owner_id;
  if (object_type !== 'activity' || aspect_type !== 'create') return;
  try {
    const athlete = await db.getAthleteByStravaId(owner_id);
    if (!athlete) return;
    const token = await refreshStravaToken(athlete);
    const activityRes = await axios.get(
      'https://www.strava.com/api/v3/activities/' + object_id,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const activity = activityRes.data;
    const relevantTypes = ['Run', 'TrailRun', 'VirtualRun', 'Workout', 'WeightTraining'];
    if (!relevantTypes.includes(activity.type)) return;
    await db.saveActivity({
      telegram_id: athlete.telegram_id,
      strava_id: String(object_id),
      type: activity.type,
      name: activity.name,
      date: activity.start_date,
      distance_km: parseFloat((activity.distance / 1000).toFixed(2)),
      duration_min: Math.round(activity.moving_time / 60),
      avg_pace: formatPace(activity.average_speed),
      avg_hr: activity.average_heartrate || null,
      max_hr: activity.max_heartrate || null,
      suffer_score: activity.suffer_score || null,
      elevation_m: activity.total_elevation_gain || null,
      raw_data: JSON.stringify(activity)
    });
    const athleteProfile = await db.getAthleteByTelegram(athlete.telegram_id);
    const recentActivities = await db.getRecentActivities(athlete.telegram_id, 7);
    const analysis = analyzeActivity(activity, athleteProfile);
    const aiResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      system: buildCoachingPrompt(buildChatContext(athleteProfile, recentActivities)),
      messages: [{ role: 'user', content: 'Analyze this activity and give concise coaching feedback:\n\n' + JSON.stringify(analysis, null, 2) }]
    });
    await sendTelegram(athlete.telegram_id,
      'New ' + activity.type + ' synced: ' + activity.name + '\n\n' +
      aiResponse.content[0].text
    );
  } catch (err) {
    console.error('Strava webhook error:', err.message);
  }
});

async function calculateZonesFromStrava(athlete) {
  const token = await refreshStravaToken(athlete);
  const ninetyDaysAgo = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  const res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
    headers: { Authorization: 'Bearer ' + token },
    params: { after: ninetyDaysAgo, per_page: 90 }
  });

  // Filter quality runs: need HR, pace, and at least 15 min duration
  // Exclude races (suffer score very high) to avoid skewing thresholds
  const runs = res.data.filter(function(a) {
    return (a.type === 'Run' || a.type === 'TrailRun') &&
      a.average_heartrate && a.average_speed > 0 &&
      a.moving_time > 900 &&
      (!a.suffer_score || a.suffer_score < 250);
  });

  if (runs.length < 5) return null;

  // Build data points: pace in sec/km, HR in bpm
  var dataPoints = runs.map(function(r) {
    return {
      paceSecPerKm: Math.round(1000 / r.average_speed),
      hr: Math.round(r.average_heartrate),
      durationMin: Math.round(r.moving_time / 60)
    };
  });

  // Remove outliers: drop top and bottom 10% HR values
  dataPoints.sort(function(a, b) { return a.hr - b.hr; });
  var trimCount = Math.max(1, Math.floor(dataPoints.length * 0.10));
  dataPoints = dataPoints.slice(trimCount, dataPoints.length - trimCount);

  if (dataPoints.length < 5) return null;

  // Sort by pace slowest to fastest
  dataPoints.sort(function(a, b) { return b.paceSecPerKm - a.paceSecPerKm; });

  // Calculate HR efficiency ratio (HR per pace unit) for each point
  // As effort increases, HR rises disproportionately at thresholds
  // We look for where the HR:pace slope changes - that is the threshold
  var slopes = [];
  for (var i = 1; i < dataPoints.length; i++) {
    var paceDiff = dataPoints[i-1].paceSecPerKm - dataPoints[i].paceSecPerKm; // positive = getting faster
    var hrDiff = dataPoints[i].hr - dataPoints[i-1].hr; // positive = HR going up
    if (paceDiff > 0) {
      slopes.push({
        index: i,
        pace: dataPoints[i].paceSecPerKm,
        hr: dataPoints[i].hr,
        slope: hrDiff / paceDiff  // HR rise per sec/km pace improvement
      });
    }
  }

  if (slopes.length < 3) return null;

  // Smooth slopes with 3-point moving average to reduce noise
  var smoothed = [];
  for (var j = 1; j < slopes.length - 1; j++) {
    smoothed.push({
      pace: slopes[j].pace,
      hr: slopes[j].hr,
      slope: (slopes[j-1].slope + slopes[j].slope + slopes[j+1].slope) / 3
    });
  }

  // Find LT1: first significant slope increase (aerobic threshold)
  // Look in lower 60% of pace range (easier efforts)
  var avgSlope = smoothed.reduce(function(s, p) { return s + p.slope; }, 0) / smoothed.length;
  var lt1Point = null, lt2Point = null;
  var lt1Hr = null, lt2Hr = null;

  var cutoff = Math.floor(smoothed.length * 0.60);
  for (var k = 1; k < cutoff; k++) {
    if (smoothed[k].slope > avgSlope * 1.3 && !lt1Point) {
      lt1Point = smoothed[k].pace;
      lt1Hr = smoothed[k].hr;
      break;
    }
  }

  // Find LT2: sharp slope increase in upper 40% (anaerobic threshold)
  for (var l = cutoff; l < smoothed.length; l++) {
    if (smoothed[l].slope > avgSlope * 1.8) {
      lt2Point = smoothed[l].pace;
      lt2Hr = smoothed[l].hr;
      break;
    }
  }

  // Fallback: if inflection detection fails, use robust percentile method
  // but calibrated closer to real-world thresholds
  var hrs = dataPoints.map(function(d) { return d.hr; });
  var minHR = Math.min.apply(null, hrs);
  var maxHR = Math.max.apply(null, hrs);
  var hrRange = maxHR - minHR;

  if (!lt1Point) {
    // LT1 typically at 65-70% of HR reserve above resting
    var lt1HrFallback = Math.round(minHR + hrRange * 0.62);
    lt1Point = interpolatePaceAtHR(dataPoints, lt1HrFallback);
    lt1Hr = lt1HrFallback;
  }
  if (!lt2Point) {
    // LT2 typically at 82-87% of HR reserve - calibrated from research
    var lt2HrFallback = Math.round(minHR + hrRange * 0.84);
    lt2Point = interpolatePaceAtHR(dataPoints, lt2HrFallback);
    lt2Hr = lt2HrFallback;
  }

  if (!lt1Point || !lt2Point) return null;

  function fmt(s) {
    var m = Math.floor(s / 60);
    var sec = Math.round(s % 60).toString().padStart(2, '0');
    return m + ':' + sec;
  }

  // Critical Speed = LT2 pace
  var cs = lt2Point;

  return {
    runsAnalyzed: runs.length,
    lt1: fmt(lt1Point),
    lt2: fmt(lt2Point),
    lt1Hr: lt1Hr,
    lt2Hr: lt2Hr,
    criticalSpeed: fmt(cs),
    z1: fmt(Math.round(cs * 1.35)),
    z2: fmt(Math.round(cs * 1.20)) + '-' + fmt(Math.round(cs * 1.35)),
    z3: fmt(Math.round(cs * 1.08)) + '-' + fmt(Math.round(cs * 1.20)),
    z4: fmt(Math.round(cs * 0.97)) + '-' + fmt(Math.round(cs * 1.08)),
    z5: fmt(Math.round(cs * 0.97))
  };
}

function interpolatePaceAtHR(dataPoints, targetHR) {
  var below = null, above = null;
  for (var i = 0; i < dataPoints.length; i++) {
    var p = dataPoints[i];
    if (p.hr <= targetHR && (!below || p.hr > below.hr)) below = p;
    if (p.hr >= targetHR && (!above || p.hr < above.hr)) above = p;
  }
  if (below && above && below !== above) {
    var ratio = (targetHR - below.hr) / (above.hr - below.hr);
    return Math.round(below.paceSecPerKm + ratio * (above.paceSecPerKm - below.paceSecPerKm));
  }
  if (below) return below.paceSecPerKm;
  if (above) return above.paceSecPerKm;
  return null;
}

function formatPace(metersPerSecond) {
  if (!metersPerSecond || metersPerSecond === 0) return null;
  var secondsPerKm = 1000 / metersPerSecond;
  var mins = Math.floor(secondsPerKm / 60);
  var secs = Math.round(secondsPerKm % 60).toString().padStart(2, '0');
  return mins + ':' + secs;
}

async function refreshStravaToken(athlete) {
  var now = Math.floor(Date.now() / 1000);
  if (athlete.strava_token_expires > now + 300) return athlete.strava_access_token;
  var res = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: athlete.strava_refresh_token,
    grant_type: 'refresh_token'
  });
  await db.updateAthlete(athlete.telegram_id, {
    strava_access_token: String(res.data.access_token),
    strava_refresh_token: String(res.data.refresh_token),
    strava_token_expires: Number(res.data.expires_at)
  });
  return res.data.access_token;
}

async function ensureStravaWebhook() {
  try {
    var existing = await axios.get('https://www.strava.com/api/v3/push_subscriptions', {
      params: { client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET }
    });
    if (existing.data.length > 0) return;
    await axios.post('https://www.strava.com/api/v3/push_subscriptions', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: process.env.BASE_URL + '/webhook/strava',
      verify_token: process.env.STRAVA_VERIFY_TOKEN
    });
    console.log('Strava webhook registered');
  } catch (err) {
    console.error('Webhook registration error:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async function() {
  console.log('HYROX Coach Bot running on port ' + PORT);
  await db.init();
  try {
    await axios.post(TELEGRAM_API + '/setWebhook', { url: process.env.BASE_URL + '/webhook/telegram' });
    console.log('Telegram webhook registered');
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});
