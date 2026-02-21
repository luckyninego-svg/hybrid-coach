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

// ─────────────────────────────────────────────
// SEND PLAIN MESSAGE
// ─────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  try {
    await axios.post(TELEGRAM_API + '/sendMessage', {
      chat_id: chatId,
      text: text.replace(/[*_`]/g, '')
    });
  } catch (err) {
    console.error('Telegram send error:', err.message, err.response && err.response.data);
  }
}

// ─────────────────────────────────────────────
// SEND MESSAGE WITH INLINE BUTTONS
// ─────────────────────────────────────────────
async function sendTelegramButtons(chatId, text, buttons) {
  try {
    await axios.post(TELEGRAM_API + '/sendMessage', {
      chat_id: chatId,
      text: text.replace(/[*_`]/g, ''),
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    console.error('Telegram button error:', err.message, err.response && err.response.data);
  }
}

// ─────────────────────────────────────────────
// RPE BUTTONS (1-10 in two rows)
// ─────────────────────────────────────────────
function rpeButtons(activityId) {
  return [
    [1,2,3,4,5].map(function(n) { return { text: String(n), callback_data: 'rpe_' + n + '_' + activityId }; }),
    [6,7,8,9,10].map(function(n) { return { text: String(n), callback_data: 'rpe_' + n + '_' + activityId }; })
  ];
}

// ─────────────────────────────────────────────
// TELEGRAM: Receive messages
// ─────────────────────────────────────────────
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200);

  // Handle button callbacks (RPE taps)
  if (req.body && req.body.callback_query) {
    await handleCallback(req.body.callback_query);
    return;
  }

  const message = req.body && req.body.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text && message.text.trim();
  const firstName = (message.from && message.from.first_name) || 'Athlete';
  if (!text) return;

  // /start
  if (text === '/start') {
    await db.upsertAthlete({ telegram_id: String(chatId), name: firstName });
    await sendTelegramButtons(chatId,
      'Welcome ' + firstName + '!\n\n' +
      'I am your personal Running & HYROX coach, powered by science.\n\n' +
      'I analyze your training data and build your zones from real physiology - not generic formulas.\n\n' +
      'Step 1: Connect your Strava:',
      [[{ text: 'Connect Strava', url: process.env.BASE_URL + '/auth/strava?telegram_id=' + chatId }]]
    );
    return;
  }

  // /status
  if (text === '/status') {
    const athlete = await db.getAthleteByTelegram(chatId);
    if (!athlete) {
      await sendTelegram(chatId, 'You have not connected yet. Send /start to begin.');
      return;
    }
    await sendTelegram(chatId,
      'Your Profile\n\n' +
      'Name: ' + (athlete.name || 'Unknown') + '\n' +
      'Age: ' + (athlete.age ? athlete.age + ' years' : 'Not set') + '\n' +
      'Max HR: ' + (athlete.max_hr_calculated ? athlete.max_hr_calculated + ' bpm' : 'Not calculated') + '\n' +
      'Strava: ' + (athlete.strava_connected ? 'Connected' : 'Not connected') + '\n' +
      'Critical Speed: ' + (athlete.critical_speed ? athlete.critical_speed + ' min/km' : 'Not set') + '\n' +
      'LT1: ' + (athlete.lt1_pace ? athlete.lt1_pace + ' min/km at ' + athlete.lt1_hr + ' bpm' : 'Not set') + '\n' +
      'LT2: ' + (athlete.lt2_pace ? athlete.lt2_pace + ' min/km at ' + athlete.lt2_hr + ' bpm' : 'Not set') + '\n' +
      'Zone calibration: ' + (athlete.rpe_count ? athlete.rpe_count + ' sessions logged' : 'Not started') + '\n' +
      'Training Phase: ' + (athlete.training_phase || 'Base') + '\n\n' +
      '/setzones - calculate zones from Strava data\n' +
      '/sync - manually sync latest activities from Strava\n' +
      '/disconnect - disconnect Strava'
    );
    return;
  }

  // /disconnect
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

  // /sync - manually backfill latest 30 activities from Strava
  if (text === '/sync') {
    const syncAthlete = await db.getAthleteByTelegram(chatId);
    if (!syncAthlete || !syncAthlete.strava_connected) {
      await sendTelegram(chatId, 'Please connect Strava first. Send /start to get the connect link.');
      return;
    }
    await sendTelegram(chatId, 'Syncing your latest activities from Strava...');
    try {
      var syncToken = await refreshStravaToken(syncAthlete);
      var syncRes = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: 'Bearer ' + syncToken },
        params: { per_page: 30 }
      });
      var saved = 0;
      for (var si = 0; si < syncRes.data.length; si++) {
        var sa = syncRes.data[si];
        try {
          await db.saveActivity({
            telegram_id: String(chatId),
            strava_id: String(sa.id),
            type: sa.type,
            name: sa.name,
            date: sa.start_date,
            distance_km: parseFloat((sa.distance / 1000).toFixed(2)),
            duration_min: Math.round(sa.moving_time / 60),
            avg_pace: formatPace(sa.average_speed),
            avg_hr: sa.average_heartrate || null,
            max_hr: sa.max_heartrate || null,
            suffer_score: sa.suffer_score || null,
            elevation_m: sa.total_elevation_gain || null,
            raw_data: JSON.stringify(sa)
          });
          saved++;
        } catch (e) { /* skip duplicates */ }
      }
      await sendTelegram(chatId, 'Synced ' + saved + ' activities from Strava. You can now ask me about any of them.');
    } catch (err) {
      console.error('Sync error:', err.message);
      await sendTelegram(chatId, 'Something went wrong syncing. Try again in a moment.');
    }
    return;
  }

  // /setzones
  if (text.startsWith('/setzones')) {
    const athleteForZones = await db.getAthleteByTelegram(chatId);
    if (!athleteForZones || !athleteForZones.strava_connected) {
      await sendTelegram(chatId, 'Please connect Strava first. Send /start to get the connect link.');
      return;
    }
    if (!athleteForZones.age) {
      await sendTelegram(chatId, 'I need your age first to calculate your max heart rate.\n\nHow old are you? (just type the number)');
      await db.updateAthlete(String(chatId), { awaiting_input: 'age' });
      return;
    }
    await runZoneCalculation(chatId, athleteForZones);
    return;
  }

  // Handle awaiting input flows
  const athlete = await db.getAthleteByTelegram(chatId);

  if (athlete && athlete.awaiting_input === 'age') {
    var age = parseInt(text);
    if (isNaN(age) || age < 10 || age > 90) {
      await sendTelegram(chatId, 'Please enter a valid age as a number, e.g. 32');
      return;
    }
    // Tanaka formula: HRmax = 208 - (0.7 x age)
    var tanakaMax = Math.round(208 - (0.7 * age));
    await db.updateAthlete(String(chatId), {
      age: age,
      max_hr_calculated: tanakaMax,
      awaiting_input: null
    });
    await sendTelegram(chatId,
      'Got it! Age: ' + age + '\n\n' +
      'Estimated max HR (Tanaka formula): ' + tanakaMax + ' bpm\n\n' +
      'I will cross-check this against your actual Strava data and use whichever is higher.\n\n' +
      'Calculating your zones now...'
    );
    var updatedAthlete = await db.getAthleteByTelegram(chatId);
    await runZoneCalculation(chatId, updatedAthlete);
    return;
  }

  // Free-form coaching chat
  try {
    const athleteData = await db.getAthleteByTelegram(chatId);
    const recentActivities = await db.getRecentActivities(chatId, 5);
    const context = buildChatContext(athleteData, recentActivities);
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
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
// HANDLE RPE BUTTON CALLBACKS
// ─────────────────────────────────────────────
async function handleCallback(callbackQuery) {
  var chatId = callbackQuery.message.chat.id;
  var data = callbackQuery.data;

  // Answer the callback to remove loading spinner
  try {
    await axios.post(TELEGRAM_API + '/answerCallbackQuery', {
      callback_query_id: callbackQuery.id
    });
  } catch (err) { /* ignore */ }

  if (data.startsWith('rpe_')) {
    var parts = data.split('_');
    var rpe = parseInt(parts[1]);
    var activityId = parts[2];

    // Save RPE to activity
    await db.saveRPE(activityId, rpe);

    // Get athlete and adjust zones based on RPE
    var athlete = await db.getAthleteByTelegram(chatId);
    var adjustment = await adjustZonesFromRPE(athlete, rpe, activityId);

    var feedback = getRPEFeedback(rpe, adjustment);
    await sendTelegram(chatId, 'RPE ' + rpe + '/10 logged.\n\n' + feedback);

    // After 3+ RPE logs, recalibrate zones
    var rpeCount = (athlete.rpe_count || 0) + 1;
    await db.updateAthlete(String(chatId), { rpe_count: rpeCount });

    if (rpeCount >= 3 && rpeCount % 3 === 0) {
      await sendTelegram(chatId,
        'You have logged ' + rpeCount + ' sessions. Running /setzones to recalibrate your zones with the new data...'
      );
      var updatedAthlete = await db.getAthleteByTelegram(chatId);
      await runZoneCalculation(chatId, updatedAthlete);
    }
  }
}

// ─────────────────────────────────────────────
// ZONE CALCULATION (HRmax anchored)
// ─────────────────────────────────────────────
async function runZoneCalculation(chatId, athlete) {
  await sendTelegram(chatId, 'Analyzing your last 90 days of Strava runs. Give me a moment...');
  try {
    var zones = await calculateZonesFromStrava(athlete);
    if (!zones) {
      await sendTelegram(chatId, 'I need at least 5 runs with heart rate data in the last 90 days. Keep training and try again soon!');
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
      max_hr_actual: zones.maxHrSeen,
      awaiting_input: null
    });
    await sendTelegram(chatId,
      'Zones calculated from ' + zones.runsAnalyzed + ' runs\n\n' +
      'Max HR used: ' + zones.maxHrUsed + ' bpm (' + zones.maxHrSource + ')\n\n' +
      'LT1 aerobic threshold:   ' + zones.lt1 + ' min/km at ' + zones.lt1Hr + ' bpm\n' +
      'LT2 anaerobic threshold: ' + zones.lt2 + ' min/km at ' + zones.lt2Hr + ' bpm\n\n' +
      'Z1 Recovery:     slower than ' + zones.z1 + ' min/km\n' +
      'Z2 Aerobic Base: ' + zones.z2 + ' min/km\n' +
      'Z3 Tempo:        ' + zones.z3 + ' min/km\n' +
      'Z4 Threshold:    ' + zones.z4 + ' min/km\n' +
      'Z5 VO2max+:      faster than ' + zones.z5 + ' min/km\n\n' +
      'These zones will auto-refine as you log RPE after each run.\n' +
      'Use /setzones anytime to recalculate.'
    );
  } catch (err) {
    console.error('Zone calculation error:', err.message);
    await sendTelegram(chatId, 'Something went wrong analyzing your Strava data. Try again in a moment.');
  }
}

// ─────────────────────────────────────────────
// RPE ZONE ADJUSTMENT LOGIC
// ─────────────────────────────────────────────
async function adjustZonesFromRPE(athlete, rpe, activityId) {
  // Get the activity to know what zone it was in
  var activity = await db.getActivityByStravaId(activityId);
  if (!activity || !athlete.lt2_pace) return null;

  // Parse LT2 pace to seconds
  var lt2Parts = athlete.lt2_pace.split(':');
  var lt2Sec = parseInt(lt2Parts[0]) * 60 + parseInt(lt2Parts[1]);

  // Get activity pace
  if (!activity.avg_pace) return null;
  var paceParts = activity.avg_pace.split(':');
  var activityPaceSec = parseInt(paceParts[0]) * 60 + parseInt(paceParts[1]);

  // Was this a threshold session? (within 10% of LT2 pace)
  var isThresholdSession = Math.abs(activityPaceSec - lt2Sec) / lt2Sec < 0.10;
  if (!isThresholdSession) return null;

  // Target RPE for threshold is 7
  // If RPE < 6 at threshold pace → zones too conservative → tighten by 3 sec/km
  // If RPE > 8 at threshold pace → zones too aggressive → loosen by 3 sec/km
  var adjustment = null;
  if (rpe <= 5) {
    adjustment = 'faster';
    var newLt2Sec = lt2Sec - 5;
    await db.updateAthlete(String(athlete.telegram_id), {
      lt2_pace: formatSecondsToMinKm(newLt2Sec),
      critical_speed: formatSecondsToMinKm(newLt2Sec)
    });
  } else if (rpe >= 9) {
    adjustment = 'slower';
    var newLt2SecSlow = lt2Sec + 5;
    await db.updateAthlete(String(athlete.telegram_id), {
      lt2_pace: formatSecondsToMinKm(newLt2SecSlow),
      critical_speed: formatSecondsToMinKm(newLt2SecSlow)
    });
  }
  return adjustment;
}

function getRPEFeedback(rpe, adjustment) {
  if (rpe <= 3) return 'Very easy effort. Good recovery session. Aerobic base work confirmed.';
  if (rpe <= 5) return 'Moderate effort. Solid aerobic work. Good zone 2 session.';
  if (rpe === 6) return 'Solid effort. Right at the aerobic-tempo border.';
  if (rpe === 7) {
    if (adjustment === 'faster') return 'Target RPE for threshold work. Your zones have been tightened slightly - you are fitter than estimated.';
    return 'Perfect threshold effort. Right where we want you for LT2 work.';
  }
  if (rpe === 8) return 'Hard session. Good VO2max stimulus. Make sure tomorrow is easy recovery.';
  if (rpe >= 9) {
    if (adjustment === 'slower') return 'Very hard. Zones adjusted slightly - this pace may be above your current threshold. Rest well.';
    return 'Maximum effort. Ensure 48 hours easy recovery before next hard session.';
  }
  return 'RPE logged.';
}

function formatSecondsToMinKm(totalSeconds) {
  var m = Math.floor(totalSeconds / 60);
  var s = Math.round(totalSeconds % 60).toString().padStart(2, '0');
  return m + ':' + s;
}

// ─────────────────────────────────────────────
// STRAVA: OAuth Step 1
// ─────────────────────────────────────────────
app.get('/auth/strava', (req, res) => {
  var telegram_id = req.query.telegram_id;
  var baseUrl = process.env.BASE_URL.startsWith('http') ? process.env.BASE_URL : 'https://' + process.env.BASE_URL;
  var params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: baseUrl + '/auth/strava/callback',
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: String(telegram_id || '')
  });
  res.redirect('https://www.strava.com/oauth/authorize?' + params);
});

// ─────────────────────────────────────────────
// STRAVA: OAuth Step 2
// ─────────────────────────────────────────────
app.get('/auth/strava/callback', async (req, res) => {
  var code = req.query.code;
  var telegramId = req.query.state;
  if (!telegramId || telegramId === 'undefined' || telegramId === '') {
    return res.status(400).send('Missing telegram_id. Please use the link from the bot.');
  }
  try {
    var tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });
    var access_token = tokenRes.data.access_token;
    var refresh_token = tokenRes.data.refresh_token;
    var expires_at = tokenRes.data.expires_at;
    var athlete = tokenRes.data.athlete;
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

    // Backfill last 30 activities from Strava into Supabase
    try {
      var backfillRes = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: 'Bearer ' + access_token },
        params: { per_page: 30 }
      });
      // Accept all activity types
      var toSave = backfillRes.data;
      for (var i = 0; i < toSave.length; i++) {
        var a = toSave[i];
        await db.saveActivity({
          telegram_id: String(telegramId),
          strava_id: String(a.id),
          type: a.type,
          name: a.name,
          date: a.start_date,
          distance_km: parseFloat((a.distance / 1000).toFixed(2)),
          duration_min: Math.round(a.moving_time / 60),
          avg_pace: formatPace(a.average_speed),
          avg_hr: a.average_heartrate || null,
          max_hr: a.max_heartrate || null,
          suffer_score: a.suffer_score || null,
          elevation_m: a.total_elevation_gain || null,
          raw_data: JSON.stringify(a)
        });
      }
      console.log('Backfilled ' + toSave.length + ' activities for ' + telegramId);
    } catch (err) {
      console.error('Backfill error:', err.message);
    }

    await sendTelegram(telegramId,
      'Strava connected! Welcome ' + athlete.firstname + '!\n\n' +
      'Now I need one more thing to calibrate your zones accurately.\n\n' +
      'How old are you? (just type the number)'
    );
    await db.updateAthlete(String(telegramId), { awaiting_input: 'age' });
    res.send('<h2>Connected! Return to Telegram to continue.</h2>');
  } catch (err) {
    console.error('Strava auth error:', err.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// ─────────────────────────────────────────────
// STRAVA: Webhook verification
// ─────────────────────────────────────────────
app.get('/webhook/strava', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.STRAVA_VERIFY_TOKEN) {
    res.json({ 'hub.challenge': req.query['hub.challenge'] });
  } else {
    res.sendStatus(403);
  }
});

// ─────────────────────────────────────────────
// STRAVA: New activity webhook
// ─────────────────────────────────────────────
app.post('/webhook/strava', async (req, res) => {
  res.sendStatus(200);
  console.log('Strava webhook received:', JSON.stringify(req.body));
  if (req.body.object_type !== 'activity' || req.body.aspect_type !== 'create') {
    console.log('Ignoring webhook - not a new activity:', req.body.object_type, req.body.aspect_type);
    return;
  }
  try {
    console.log('Looking up athlete with Strava ID:', req.body.owner_id);
    var athlete = await db.getAthleteByStravaId(req.body.owner_id);
    if (!athlete) {
      console.log('No athlete found for Strava ID:', req.body.owner_id);
      return;
    }
    console.log('Found athlete:', athlete.telegram_id, athlete.name);
    var token = await refreshStravaToken(athlete);
    var activityRes = await axios.get(
      'https://www.strava.com/api/v3/activities/' + req.body.object_id,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    var activity = activityRes.data;

    // Fetch per-km splits for runs
    var splits = [];
    if (activity.type === 'Run' || activity.type === 'TrailRun') {
      try {
        // Use the splits_metric already in the activity detail (per km auto-splits)
        if (activity.splits_metric && activity.splits_metric.length > 0) {
          splits = activity.splits_metric.map(function(s, idx) {
            var paceSec = s.average_speed > 0 ? Math.round(1000 / s.average_speed) : null;
            return {
              km: idx + 1,
              pace: paceSec ? Math.floor(paceSec/60) + ':' + (paceSec%60).toString().padStart(2,'0') : null,
              hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
              elevation: s.elevation_difference ? Math.round(s.elevation_difference) : null
            };
          });
        }
      } catch (splitErr) {
        console.error('Splits fetch error:', splitErr.message);
      }
    }
    // Attach splits to activity for AI analysis
    activity._splits = splits;
    // Accept all activity types - let Claude decide what's coaching-relevant

    await db.saveActivity({
      telegram_id: athlete.telegram_id,
      strava_id: String(req.body.object_id),
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

    var athleteProfile = await db.getAthleteByTelegram(athlete.telegram_id);
    var recentActivities = await db.getRecentActivities(athlete.telegram_id, 7);
    var analysis = analyzeActivity(activity, athleteProfile);

    var aiResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 700,
      system: buildCoachingPrompt(buildChatContext(athleteProfile, recentActivities)),
      messages: [{ role: 'user', content: 'Analyze this activity and give concise coaching feedback:\n\n' + JSON.stringify(analysis, null, 2) }]
    });

    // Send coaching feedback
    await sendTelegram(athlete.telegram_id,
      'New ' + activity.type + ': ' + activity.name + '\n\n' +
      aiResponse.content[0].text
    );

    // Ask for RPE with tap buttons - only for runs
    if (activity.type === 'Run' || activity.type === 'TrailRun') {
      await sendTelegramButtons(athlete.telegram_id,
        'How hard did that feel? Rate your RPE (1 = very easy, 10 = maximum effort):',
        rpeButtons(String(req.body.object_id))
      );
    }

  } catch (err) {
    console.error('Strava webhook error:', err.message);
  }
});

// ─────────────────────────────────────────────
// ZONE CALCULATION - HRmax anchored algorithm
// ─────────────────────────────────────────────
async function calculateZonesFromStrava(athlete) {
  var token = await refreshStravaToken(athlete);
  var ninetyDaysAgo = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);

  var res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
    headers: { Authorization: 'Bearer ' + token },
    params: { after: ninetyDaysAgo, per_page: 90 }
  });

  var runs = res.data.filter(function(a) {
    return (a.type === 'Run' || a.type === 'TrailRun') &&
      a.average_heartrate && a.average_speed > 0 && a.moving_time > 900;
  });

  if (runs.length < 5) return null;

  // Find actual max HR seen in data
  var maxHrSeen = Math.max.apply(null, runs.map(function(r) {
    return r.max_heartrate || r.average_heartrate;
  }));

  // Use Tanaka or actual - whichever is higher
  var tanakaMax = athlete.max_hr_calculated || Math.round(208 - (0.7 * (athlete.age || 35)));
  var maxHrUsed = Math.max(tanakaMax, maxHrSeen);
  var maxHrSource = maxHrSeen > tanakaMax ? 'actual Strava data' : 'Tanaka formula (age ' + athlete.age + ')';

  // Anchor LT1 and LT2 to HRmax percentages (research-validated)
  // LT1 = 75-80% HRmax, LT2 = 87-92% HRmax
  var lt1Hr = Math.round(maxHrUsed * 0.78);
  var lt2Hr = Math.round(maxHrUsed * 0.89);

  // Build data points with outlier removal
  var dataPoints = runs.map(function(r) {
    return {
      paceSecPerKm: Math.round(1000 / r.average_speed),
      hr: Math.round(r.average_heartrate)
    };
  });

  // Remove top and bottom 10% HR outliers
  dataPoints.sort(function(a, b) { return a.hr - b.hr; });
  var trimCount = Math.max(1, Math.floor(dataPoints.length * 0.10));
  dataPoints = dataPoints.slice(trimCount, dataPoints.length - trimCount);

  if (dataPoints.length < 4) return null;

  // Find pace at LT1 and LT2 HR via interpolation
  var lt1PaceSec = interpolatePaceAtHR(dataPoints, lt1Hr);
  var lt2PaceSec = interpolatePaceAtHR(dataPoints, lt2Hr);

  if (!lt1PaceSec || !lt2PaceSec) return null;

  // Sanity check: LT2 should be faster than LT1
  if (lt2PaceSec >= lt1PaceSec) {
    // Swap if inverted
    var temp = lt2PaceSec;
    lt2PaceSec = lt1PaceSec;
    lt1PaceSec = temp;
    var tempHr = lt2Hr;
    lt2Hr = lt1Hr;
    lt1Hr = tempHr;
  }

  function fmt(s) {
    var m = Math.floor(s / 60);
    var sec = Math.round(s % 60).toString().padStart(2, '0');
    return m + ':' + sec;
  }

  var cs = lt2PaceSec;

  return {
    runsAnalyzed: runs.length,
    maxHrSeen: maxHrSeen,
    maxHrUsed: maxHrUsed,
    maxHrSource: maxHrSource,
    lt1: fmt(lt1PaceSec),
    lt2: fmt(lt2PaceSec),
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

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// AUTO-SYNC: Poll Strava every 30 minutes for all athletes
// Backup mechanism in case webhook misses activities
// ─────────────────────────────────────────────
async function autoSyncAllAthletes() {
  console.log('Auto-sync started:', new Date().toISOString());
  try {
    var athletes = await db.getAllConnectedAthletes();
    console.log('Auto-sync: found ' + athletes.length + ' connected athletes');
    for (var i = 0; i < athletes.length; i++) {
      var athlete = athletes[i];
      try {
        var token = await refreshStravaToken(athlete);
        // Only fetch activities from last 24 hours
        var since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
        var res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
          headers: { Authorization: 'Bearer ' + token },
          params: { after: since, per_page: 10 }
        });
        var newActivities = 0;
        for (var j = 0; j < res.data.length; j++) {
          var a = res.data[j];
          // Check if already saved
          var existing = await db.getActivityByStravaId(String(a.id));
          if (existing) continue;

          // Fetch full activity detail to get splits_metric
          var fullActivity = a;
          if (a.type === 'Run' || a.type === 'TrailRun') {
            try {
              var detailRes = await axios.get('https://www.strava.com/api/v3/activities/' + a.id, {
                headers: { Authorization: 'Bearer ' + syncToken }
              });
              fullActivity = detailRes.data;
              if (fullActivity.splits_metric && fullActivity.splits_metric.length > 0) {
                fullActivity._splits = fullActivity.splits_metric.map(function(s, idx) {
                  var paceSec = s.average_speed > 0 ? Math.round(1000 / s.average_speed) : null;
                  return {
                    km: idx + 1,
                    pace: paceSec ? Math.floor(paceSec/60) + ':' + (paceSec%60).toString().padStart(2,'0') : null,
                    hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
                    elevation: s.elevation_difference ? Math.round(s.elevation_difference) : null
                  };
                });
              }
            } catch (e) {
              console.error('Detail fetch error:', e.message);
            }
          }
          a = fullActivity;

          // Save new activity
          await db.saveActivity({
            telegram_id: athlete.telegram_id,
            strava_id: String(a.id),
            type: a.type,
            name: a.name,
            date: a.start_date,
            distance_km: parseFloat((a.distance / 1000).toFixed(2)),
            duration_min: Math.round(a.moving_time / 60),
            avg_pace: formatPace(a.average_speed),
            avg_hr: a.average_heartrate || null,
            max_hr: a.max_heartrate || null,
            suffer_score: a.suffer_score || null,
            elevation_m: a.total_elevation_gain || null,
            raw_data: JSON.stringify(a)
          });
          newActivities++;
          // Send coaching feedback for new activity
          try {
            var athleteProfile = await db.getAthleteByTelegram(athlete.telegram_id);
            var recentActivities = await db.getRecentActivities(athlete.telegram_id, 7);
            var analysis = analyzeActivity(a, athleteProfile);
            var aiResponse = await anthropic.messages.create({
              model: 'claude-opus-4-6',
              max_tokens: 700,
              system: buildCoachingPrompt(buildChatContext(athleteProfile, recentActivities)),
              messages: [{ role: 'user', content: 'Analyze this activity and give concise coaching feedback with next workout prescription:\n\n' + JSON.stringify(analysis, null, 2) }]
            });
            await sendTelegram(athlete.telegram_id,
              'New ' + a.type + ': ' + a.name + '\n\n' + aiResponse.content[0].text
            );
            if (a.type === 'Run' || a.type === 'TrailRun') {
              await sendTelegramButtons(athlete.telegram_id,
                'How hard did that feel? (1 = very easy, 10 = maximum)',
                rpeButtons(String(a.id))
              );
            }
          } catch (feedbackErr) {
            console.error('Auto-sync feedback error:', feedbackErr.message);
          }
        }
        if (newActivities > 0) {
          console.log('Auto-sync: saved ' + newActivities + ' new activities for ' + athlete.name);
        }
      } catch (athleteErr) {
        console.error('Auto-sync error for athlete ' + athlete.telegram_id + ':', athleteErr.message);
      }
    }
  } catch (err) {
    console.error('Auto-sync failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
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
  // Run auto-sync immediately on boot, then every 30 minutes
  autoSyncAllAthletes();
  setInterval(autoSyncAllAthletes, 30 * 60 * 1000);
  console.log('Auto-sync scheduled every 30 minutes');
});
