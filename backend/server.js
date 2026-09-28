const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOGS_FILE = path.join(DATA_DIR, 'alerts.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory runtime state with persisted fallback
let config = {
  gasThreshold: parseInt(process.env.GAS_THRESHOLD) || 2000,
  whatsappToken: process.env.WHATSAPP_TOKEN || '',
  phoneNumberId: process.env.PHONE_NUMBER_ID || '',
  recipientPhone: process.env.RECIPIENT_PHONE || '',
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v23.0',
  alertTemplateName: process.env.ALERT_TEMPLATE_NAME || 'gas_alert',
  recoveryTemplateName: process.env.RECOVERY_TEMPLATE_NAME || 'gas_recovered',
  autoNotifyWhatsapp: true,
  buzzerMuted: false
};

// Load saved configuration if exists
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    config = { ...config, ...savedConfig };
  } catch (err) {
    console.error('Error reading config file:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Error saving config:', err.message);
  }
}

// Telemetry & Alert History
let alertLogs = [];
if (fs.existsSync(LOGS_FILE)) {
  try {
    alertLogs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error reading alert logs:', err.message);
  }
}

function saveAlertLogs() {
  try {
    // Keep max 200 logs
    if (alertLogs.length > 200) alertLogs = alertLogs.slice(-200);
    fs.writeFileSync(LOGS_FILE, JSON.stringify(alertLogs, null, 2));
  } catch (err) {
    console.error('Error saving alert logs:', err.message);
  }
}

let telemetryHistory = [];
const MAX_HISTORY = 120; // 2 minutes at 1s intervals or ~10 mins

let latestDeviceState = {
  gasValue: 0,
  gasPpmEstimate: 0,
  isAlert: false,
  buzzerActive: false,
  ledActive: false,
  ip: 'Unknown',
  rssi: 0,
  lastSeen: null,
  uptimeSec: 0,
  status: 'offline'
};

let activeAlertSession = null;
let lastAlertSentTime = 0;
let lastRecoverySentTime = 0;
const NOTIFICATION_COOLDOWN_MS = 5000; // 5s debounce

// ==========================================
// WhatsApp Meta Cloud API Dispatcher
// ==========================================
async function sendWhatsAppTemplateMessage(templateName, gasVal, thresholdVal, customRecipient = null) {
  const token = config.whatsappToken;
  const phoneId = config.phoneNumberId;
  const recipient = (customRecipient || config.recipientPhone || '').replace(/\D/g, '');

  if (!token || !phoneId || !recipient || token === 'YOUR_WHATSAPP_ACCESS_TOKEN') {
    return {
      success: false,
      error: 'WhatsApp Cloud API credentials or Recipient number not configured.'
    };
  }

  const url = `https://graph.facebook.com/${config.graphApiVersion}/${phoneId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: 'en_US'
      },
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: String(gasVal)
            },
            {
              type: 'text',
              text: String(thresholdVal)
            }
          ]
        }
      ]
    }
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log(`[WhatsApp] Sent template '${templateName}' to ${recipient}:`, response.data);
    return {
      success: true,
      data: response.data
    };
  } catch (err) {
    const errorData = err.response ? err.response.data : err.message;
    console.error(`[WhatsApp Error] Failed to send template '${templateName}':`, errorData);
    return {
      success: false,
      error: errorData
    };
  }
}

// Optional Direct Free-form Text WhatsApp message (works within 24h conversation window)
async function sendWhatsAppTextMessage(text, customRecipient = null) {
  const token = config.whatsappToken;
  const phoneId = config.phoneNumberId;
  const recipient = (customRecipient || config.recipientPhone || '').replace(/\D/g, '');

  if (!token || !phoneId || !recipient) {
    return { success: false, error: 'Credentials not configured' };
  }

  const url = `https://graph.facebook.com/${config.graphApiVersion}/${phoneId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return { success: false, error: err.response ? err.response.data : err.message };
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Device Status Checker Cron
setInterval(() => {
  if (latestDeviceState.lastSeen) {
    const secondsSinceLastPing = (Date.now() - new Date(latestDeviceState.lastSeen).getTime()) / 1000;
    const isOnline = secondsSinceLastPing < 15;
    const newStatus = isOnline ? (latestDeviceState.isAlert ? 'alarm' : 'online') : 'offline';
    
    if (latestDeviceState.status !== newStatus) {
      latestDeviceState.status = newStatus;
      io.emit('device_status_change', { status: newStatus, lastSeen: latestDeviceState.lastSeen });
    }
  }
}, 3000);

// ==========================================
// REST API Endpoints
// ==========================================

// 1. Get complete dashboard summary
app.get('/api/status', (req, res) => {
  const isOnline = latestDeviceState.lastSeen && 
    ((Date.now() - new Date(latestDeviceState.lastSeen).getTime()) / 1000 < 15);

  res.json({
    device: {
      ...latestDeviceState,
      status: isOnline ? (latestDeviceState.isAlert ? 'alarm' : 'online') : 'offline'
    },
    config: {
      gasThreshold: config.gasThreshold,
      autoNotifyWhatsapp: config.autoNotifyWhatsapp,
      buzzerMuted: config.buzzerMuted,
      recipientPhone: config.recipientPhone ? config.recipientPhone.replace(/.(?=.{4})/g, '*') : '',
      alertTemplateName: config.alertTemplateName,
      recoveryTemplateName: config.recoveryTemplateName,
      hasToken: Boolean(config.whatsappToken && config.whatsappToken !== 'YOUR_WHATSAPP_ACCESS_TOKEN'),
      hasPhoneId: Boolean(config.phoneNumberId && config.phoneNumberId !== 'YOUR_PHONE_NUMBER_ID')
    },
    historySummary: {
      points: telemetryHistory.length,
      totalAlerts: alertLogs.length
    }
  });
});

// WhatsApp inbound webhook: /status, /set <n>, /help (only from configured recipient)
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'gas-detector-verify';

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // ack immediately
  const messages = [];
  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      messages.push(...((change.value && change.value.messages) || []));
    }
  }
  const owner = (config.recipientPhone || '').replace(/\D/g, '');
  for (const msg of messages) {
    if (msg.type !== 'text' || !owner || msg.from.replace(/\D/g, '') !== owner) continue;
    handleWhatsAppCommand(msg.text.body.trim(), msg.from).catch(err =>
      console.error('[Webhook] command error:', err.message));
  }
});

async function handleWhatsAppCommand(text, from) {
  const cmd = text.toLowerCase();
  let reply;
  if (cmd === '/status' || cmd === 'status') {
    reply = `📊 *System Status Report*\n\n🔹 Current Gas Level: ${latestDeviceState.gasValue}\n` +
      `🔹 Active Threshold: ${config.gasThreshold}\n🔹 Signal Strength (RSSI): ${latestDeviceState.rssi} dBm`;
  } else if (/^\/?set\s+\d+$/.test(cmd)) {
    const n = parseInt(cmd.split(/\s+/)[1], 10);
    if (n > 100 && n < 4095) {
      config.gasThreshold = n;
      saveConfig();
      io.emit('config_updated', { gasThreshold: n });
      reply = `✅ Threshold updated successfully.\nNew Limit: ${n}`;
    } else {
      reply = '❌ Invalid value. Enter a value between 100 and 4095. Example: /set 2850';
    }
  } else if (cmd === '/start' || cmd === '/help' || cmd === 'help') {
    reply = '🤖 *Gas Monitoring System Commands:*\n\n🔹 `/status` - Current gas reading & parameters\n🔹 `/set 2850` - Update alarm threshold';
  } else {
    return;
  }
  await sendWhatsAppTextMessage(reply, from);
}

// 2. Telemetry ingestion from ESP32
app.post('/api/telemetry', async (req, res) => {
  const { gasValue, buzzerState, ledState, ip, rssi, uptime } = req.body;
  const now = new Date();

  const numericGas = Number(gasValue) || 0;
  const isBreached = numericGas > config.gasThreshold;

  latestDeviceState = {
    gasValue: numericGas,
    gasPpmEstimate: Math.round(numericGas * 1.2), // indicative scale
    isAlert: isBreached,
    buzzerActive: Boolean(buzzerState),
    ledActive: Boolean(ledState),
    ip: ip || latestDeviceState.ip,
    rssi: Number(rssi) || latestDeviceState.rssi,
    lastSeen: now.toISOString(),
    uptimeSec: Number(uptime) || (latestDeviceState.uptimeSec + 1),
    status: isBreached ? 'alarm' : 'online'
  };

  // Add to telemetry time-series
  const dataPoint = {
    time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    timestamp: now.getTime(),
    gasValue: numericGas,
    threshold: config.gasThreshold,
    isAlert: isBreached
  };
  telemetryHistory.push(dataPoint);
  if (telemetryHistory.length > MAX_HISTORY) telemetryHistory.shift();

  // Alert State Machine & WhatsApp dispatch
  if (isBreached) {
    if (!activeAlertSession) {
      // New alert session started
      activeAlertSession = {
        id: 'ALT-' + Date.now(),
        startTime: now.toISOString(),
        startTimestamp: now.getTime(),
        peakValue: numericGas,
        threshold: config.gasThreshold,
        status: 'active',
        whatsappAlertSent: false,
        whatsappRecoverySent: false
      };

      console.log(`🚨 [ALERT] Gas threshold breached! Level: ${numericGas}, Threshold: ${config.gasThreshold}`);

      // WhatsApp Cloud API Trigger
      if (config.autoNotifyWhatsapp && (now.getTime() - lastAlertSentTime > NOTIFICATION_COOLDOWN_MS)) {
        lastAlertSentTime = now.getTime();
        sendWhatsAppTemplateMessage(config.alertTemplateName, numericGas, config.gasThreshold)
          .then((result) => {
            if (activeAlertSession) {
              activeAlertSession.whatsappAlertSent = result.success;
              activeAlertSession.whatsappAlertDetails = result;
              saveAlertLogs();
            }
            io.emit('whatsapp_dispatch', { type: 'alert', success: result.success, result });
          });
      }

      alertLogs.unshift(activeAlertSession);
      saveAlertLogs();
      io.emit('new_alert', activeAlertSession);
    } else {
      // Update ongoing alert session peak
      if (numericGas > activeAlertSession.peakValue) {
        activeAlertSession.peakValue = numericGas;
        saveAlertLogs();
      }
    }
  } else {
    // Normal gas level
    if (activeAlertSession) {
      activeAlertSession.endTime = now.toISOString();
      activeAlertSession.durationSeconds = Math.round((now.getTime() - activeAlertSession.startTimestamp) / 1000);
      activeAlertSession.status = 'resolved';

      console.log(`✅ [RECOVERED] Gas level normalized! Level: ${numericGas}`);

      // WhatsApp Recovery Notification
      if (config.autoNotifyWhatsapp && (now.getTime() - lastRecoverySentTime > NOTIFICATION_COOLDOWN_MS)) {
        lastRecoverySentTime = now.getTime();
        sendWhatsAppTemplateMessage(config.recoveryTemplateName, numericGas, config.gasThreshold)
          .then((result) => {
            if (activeAlertSession) {
              activeAlertSession.whatsappRecoverySent = result.success;
              saveAlertLogs();
            }
            io.emit('whatsapp_dispatch', { type: 'recovery', success: result.success, result });
          });
      }

      saveAlertLogs();
      io.emit('alert_resolved', activeAlertSession);
      activeAlertSession = null;
    }
  }

  // Real-time broadcast to connected web UI
  io.emit('telemetry', {
    ...latestDeviceState,
    threshold: config.gasThreshold,
    point: dataPoint
  });

  // Respond to ESP32 with current configuration commands
  res.json({
    success: true,
    threshold: config.gasThreshold,
    buzzerMuted: config.buzzerMuted,
    timestamp: now.getTime()
  });
});

// 3. ESP32 lightweight polling endpoint for config
app.get('/api/config', (req, res) => {
  res.json({
    threshold: config.gasThreshold,
    buzzerMuted: config.buzzerMuted,
    autoNotifyWhatsapp: config.autoNotifyWhatsapp
  });
});

// 4. Update Gas Threshold from Dashboard
app.post('/api/config/threshold', (req, res) => {
  const { threshold } = req.body;
  const num = parseInt(threshold, 10);
  if (isNaN(num) || num < 100 || num > 4095) {
    return res.status(400).json({ error: 'Threshold must be an integer between 100 and 4095' });
  }

  config.gasThreshold = num;
  saveConfig();

  io.emit('config_updated', { gasThreshold: config.gasThreshold });
  console.log(`⚙️ Gas threshold updated to: ${config.gasThreshold}`);

  res.json({ success: true, gasThreshold: config.gasThreshold });
});

// 5. Update Full Settings (WhatsApp & Behavior)
app.post('/api/config/settings', (req, res) => {
  const {
    gasThreshold,
    whatsappToken,
    phoneNumberId,
    recipientPhone,
    graphApiVersion,
    alertTemplateName,
    recoveryTemplateName,
    autoNotifyWhatsapp,
    buzzerMuted
  } = req.body;

  if (gasThreshold !== undefined) config.gasThreshold = parseInt(gasThreshold, 10) || config.gasThreshold;
  if (whatsappToken !== undefined && whatsappToken.trim() !== '') config.whatsappToken = whatsappToken.trim();
  if (phoneNumberId !== undefined && phoneNumberId.trim() !== '') config.phoneNumberId = phoneNumberId.trim();
  if (recipientPhone !== undefined) config.recipientPhone = recipientPhone.replace(/\D/g, '');
  if (graphApiVersion !== undefined && graphApiVersion.trim() !== '') config.graphApiVersion = graphApiVersion.trim();
  if (alertTemplateName !== undefined && alertTemplateName.trim() !== '') config.alertTemplateName = alertTemplateName.trim();
  if (recoveryTemplateName !== undefined && recoveryTemplateName.trim() !== '') config.recoveryTemplateName = recoveryTemplateName.trim();
  if (autoNotifyWhatsapp !== undefined) config.autoNotifyWhatsapp = Boolean(autoNotifyWhatsapp);
  if (buzzerMuted !== undefined) config.buzzerMuted = Boolean(buzzerMuted);

  saveConfig();
  io.emit('config_updated', config);

  res.json({
    success: true,
    message: 'Configuration updated successfully'
  });
});

// 6. Test WhatsApp Cloud API Trigger
app.post('/api/whatsapp/test', async (req, res) => {
  const { templateName, gasValue, recipient } = req.body;
  const tName = templateName || config.alertTemplateName || 'hello_world';
  const gVal = gasValue || 2500;

  console.log(`[Test WhatsApp] Sending test '${tName}'...`);
  
  let result;
  if (tName === 'hello_world') {
    // Hello World template default
    const token = config.whatsappToken;
    const phoneId = config.phoneNumberId;
    const toNum = (recipient || config.recipientPhone || '').replace(/\D/g, '');
    const url = `https://graph.facebook.com/${config.graphApiVersion}/${phoneId}/messages`;

    try {
      const response = await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: toNum,
          type: 'template',
          template: {
            name: 'hello_world',
            language: { code: 'en_US' }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      result = { success: true, data: response.data };
    } catch (err) {
      result = { success: false, error: err.response ? err.response.data : err.message };
    }
  } else {
    result = await sendWhatsAppTemplateMessage(tName, gVal, config.gasThreshold, recipient);
  }

  res.json(result);
});

// 7. Get Telemetry History
app.get('/api/history', (req, res) => {
  res.json({ history: telemetryHistory });
});

// 8. Get Alert Logs
app.get('/api/alerts', (req, res) => {
  res.json({ alerts: alertLogs });
});

// 9. Clear Alert Logs
app.delete('/api/alerts', (req, res) => {
  alertLogs = [];
  saveAlertLogs();
  io.emit('alerts_cleared');
  res.json({ success: true });
});

// 10. Simulate Gas Reading (Great for testing without physical gas/ESP32)
app.post('/api/simulate', async (req, res) => {
  const { gasValue } = req.body;
  const val = Number(gasValue) || 1200;

  // Emulate telemetry hit
  await axios.post(`http://localhost:${PORT}/api/telemetry`, {
    gasValue: val,
    buzzerState: val > config.gasThreshold,
    ledState: val > config.gasThreshold,
    ip: '127.0.0.1 (Simulator)',
    rssi: -45,
    uptime: 100
  });

  res.json({ success: true, simulatedValue: val });
});

// Socket.io Connection handler
io.on('connection', (socket) => {
  console.log('⚡ Client connected to real-time stream:', socket.id);
  
  // Send current state immediately on connect
  socket.emit('initial_state', {
    device: latestDeviceState,
    config,
    history: telemetryHistory,
    alerts: alertLogs.slice(0, 30)
  });

  socket.on('disconnect', () => {
    // disconnected
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`
  =============================================================
  🔥 ESP32 Smart Gas Detector & WhatsApp IoT Backend is Active
  =============================================================
  🌐 Web Dashboard: http://localhost:${PORT}
  📡 Telemetry API: POST http://localhost:${PORT}/api/telemetry
  ⚙️  Config API:    GET  http://localhost:${PORT}/api/config
  📱 WhatsApp API:  Meta Graph API ${config.graphApiVersion}
  🎯 Gas Threshold: ${config.gasThreshold}
  =============================================================
  `);
});
